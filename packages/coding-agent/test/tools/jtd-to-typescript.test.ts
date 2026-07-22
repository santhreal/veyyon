/**
 * The JTD-to-TypeScript renderer, which produces the type a subagent is told to
 * return.
 *
 * This output goes straight into a system prompt, so it is not decoration: it
 * is the only description the model gets of the shape it must submit, and
 * anything wrong or missing here shows up as a subagent failing output
 * validation in a loop.
 *
 * The renderer had no tests. It also could not render a self-referential
 * schema: it recursed with no cycle detection, so a schema describing a tree, a
 * linked list, or nested comments threw `RangeError: Maximum call stack size
 * exceeded`, which the prompt helper swallowed into `unknown`. Those are
 * ordinary shapes to want, so recursion is now expanded into a named interface
 * and only a finitely-but-absurdly deep schema is refused.
 */
import { describe, expect, it } from "bun:test";
import { jtdToTypeScript, jtdToTypeScriptParts } from "@veyyon/coding-agent/tools/jtd-to-typescript";

describe("jtdToTypeScript", () => {
	describe("primitive types", () => {
		it.each([
			["string", "string"],
			["boolean", "boolean"],
			["timestamp", "string"],
			["float32", "number"],
			["float64", "number"],
			["int8", "number"],
			["uint8", "number"],
			["int16", "number"],
			["uint16", "number"],
			["int32", "number"],
			["uint32", "number"],
		])("renders JTD %s as TypeScript %s", (jtd, ts) => {
			expect(jtdToTypeScript({ type: jtd })).toBe(ts);
		});

		it("renders an unrecognised type as unknown rather than inventing one", () => {
			// Emitting the raw JTD name would put a type the model cannot satisfy
			// into the prompt.
			expect(jtdToTypeScript({ type: "not-a-jtd-type" })).toBe("unknown");
		});
	});

	describe("objects", () => {
		it("renders each property with its type", () => {
			expect(jtdToTypeScript({ properties: { title: { type: "string" }, count: { type: "int32" } } })).toBe(
				"{\n  title: string;\n  count: number;\n}",
			);
		});

		it("marks optional properties with a question mark", () => {
			// The distinction is the whole reason JTD separates the two keys, and a
			// model told everything is required will pad output with empty values.
			const output = jtdToTypeScript({
				properties: { id: { type: "string" } },
				optionalProperties: { note: { type: "string" } },
			});

			expect(output).toContain("id: string;");
			expect(output).toContain("note?: string;");
		});

		it("quotes a property name that is not a valid identifier", () => {
			// `content-type: string;` is not valid TypeScript, and a prompt showing it
			// teaches the model syntax that does not parse.
			expect(jtdToTypeScript({ properties: { "content-type": { type: "string" } } })).toContain(
				'"content-type": string;',
			);
		});

		it("does not quote a name that only looks unusual", () => {
			// Over-quoting is not harmful but it is noise, and `$ref`/`_id` are valid
			// identifiers.
			const output = jtdToTypeScript({ properties: { $ref: { type: "string" }, _id: { type: "string" } } });

			expect(output).toContain("$ref: string;");
			expect(output).toContain("_id: string;");
		});
	});

	describe("arrays and dictionaries", () => {
		it("renders elements as a suffixed array when the item type is short", () => {
			expect(jtdToTypeScript({ elements: { type: "string" } })).toBe("string[]");
		});

		it("renders elements as Array<...> when the item type is long or multi-line", () => {
			// `{ a: string; b: string; ... }[]` reads badly and is easy to misparse.
			const output = jtdToTypeScript({
				elements: {
					properties: { alpha: { type: "string" }, beta: { type: "string" }, gamma: { type: "string" } },
				},
			});

			expect(output.startsWith("Array<")).toBe(true);
			expect(output).toContain("alpha: string;");
		});

		it("renders values as a Record", () => {
			expect(jtdToTypeScript({ values: { type: "int32" } })).toBe("Record<string, number>");
		});
	});

	describe("enums and discriminated unions", () => {
		it("renders an enum as a union of string literals", () => {
			expect(jtdToTypeScript({ enum: ["open", "closed"] })).toBe('"open" | "closed"');
		});

		it("folds the discriminator into each variant", () => {
			// The model has to see that the tag and the variant fields travel
			// together, or it emits the tag beside a mismatched body.
			const output = jtdToTypeScript({
				discriminator: "kind",
				mapping: {
					text: { properties: { body: { type: "string" } } },
					image: { properties: { url: { type: "string" } } },
				},
			});

			expect(output).toBe('{ kind: "text"; body: string; } | { kind: "image"; url: string; }');
		});

		it("renders a variant with no fields as just the tag", () => {
			// This produced `{ kind: "ping"; nknow }`. The empty variant renders as
			// `unknown`, not `{}`, so the guard checking for `{}` never fired and the
			// brace-strip sliced the first and last letters off the word instead.
			// Malformed TypeScript in the prompt is worse than a missing type: the
			// model copies it.
			const output = jtdToTypeScript({ discriminator: "kind", mapping: { ping: {} } });

			expect(output).toBe('{ kind: "ping" }');
		});

		it("renders a fieldless variant beside a normal one without corrupting either", () => {
			// The mixed case is the realistic one, and it is where the malformed
			// variant would sit unnoticed next to a correct one.
			const output = jtdToTypeScript({
				discriminator: "kind",
				mapping: { ping: {}, text: { properties: { body: { type: "string" } } } },
			});

			expect(output).toBe('{ kind: "ping" } | { kind: "text"; body: string; }');
		});

		it("does not splice a non-object variant into the tag", () => {
			// Any variant that does not render to braces hits the same slicing path.
			// Guarding on the shape rather than on one expected string is what makes
			// that safe.
			const output = jtdToTypeScript({ discriminator: "kind", mapping: { n: { type: "int32" } } });

			expect(output).toBe('{ kind: "n" }');
		});
	});

	describe("schemas with nothing to describe", () => {
		it.each([
			[null, "null"],
			[undefined, "undefined"],
			[{}, "an empty object"],
			["not a schema", "a string"],
		])("renders %s (%s) as unknown", schema => {
			// A degenerate schema is a legitimate result, not an error. It must not
			// throw, because it is rendered while building a system prompt.
			expect(jtdToTypeScript(schema)).toBe("unknown");
		});
	});

	describe("self-referential schemas", () => {
		/** A node containing another node directly, the classic tree shape. */
		function tree(): Record<string, unknown> {
			const node: Record<string, unknown> = { properties: { name: { type: "string" } } };
			(node.properties as Record<string, unknown>).child = node;
			return node;
		}

		/** A node containing an ARRAY of itself, the nested-comments shape. */
		function comment(): Record<string, unknown> {
			const node: Record<string, unknown> = { properties: { text: { type: "string" } } };
			(node.properties as Record<string, unknown>).replies = { elements: node };
			return node;
		}

		it("renders a directly recursive node as a named interface", () => {
			// This threw `RangeError` before. The interface plus the back-reference is
			// what makes the type expressible at all.
			expect(jtdToTypeScriptParts(tree())).toEqual({
				definitions: "interface Node {\n  name: string;\n  child: Node;\n}",
				type: "Node",
			});
		});

		it("renders recursion through an array", () => {
			expect(jtdToTypeScriptParts(comment())).toEqual({
				definitions: "interface Node {\n  text: string;\n  replies: Node[];\n}",
				type: "Node",
			});
		});

		it("keeps definitions separate from the type expression", () => {
			// A caller splicing the type into `result: { data: … }` must put the
			// declarations before that structure. Joining them forces the caller to
			// split them back apart, and getting it wrong puts an `interface` in type
			// position.
			const parts = jtdToTypeScriptParts(tree());

			expect(parts.type).toBe("Node");
			expect(parts.definitions).not.toContain("result:");
		});

		it("joins definitions before the type in the string form", () => {
			expect(jtdToTypeScript(tree())).toBe("interface Node {\n  name: string;\n  child: Node;\n}\n\nNode");
		});

		it("names a nested recursive node while the root stays inline", () => {
			// Only the self-referential part becomes an interface. Naming the whole
			// schema would hide the fields the model most needs to see.
			const node: Record<string, unknown> = { properties: { name: { type: "string" } } };
			(node.properties as Record<string, unknown>).child = node;

			const parts = jtdToTypeScriptParts({ properties: { root: node, total: { type: "int32" } } });

			expect(parts.definitions).toContain("interface Node {");
			expect(parts.type).toContain("root: Node;");
			expect(parts.type).toContain("total: number;");
		});

		it("renders identically on repeated calls, so the prompt stays cacheable", () => {
			// Names are assigned in first-encounter order. If they depended on
			// iteration accidents the system prompt would differ between runs and
			// defeat prompt caching.
			expect(jtdToTypeScript(tree())).toBe(jtdToTypeScript(tree()));
		});

		it("gives two distinct recursive nodes distinct names", () => {
			// Reusing one name would merge two unrelated types into one, which is
			// worse than not rendering them: the model would be told a field accepts a
			// shape it does not.
			const first: Record<string, unknown> = { properties: { a: { type: "string" } } };
			(first.properties as Record<string, unknown>).self = first;
			const second: Record<string, unknown> = { properties: { b: { type: "string" } } };
			(second.properties as Record<string, unknown>).self = second;

			const parts = jtdToTypeScriptParts({ properties: { one: first, two: second } });

			expect(parts.definitions).toContain("interface Node {");
			expect(parts.definitions).toContain("interface Node2 {");
			expect(parts.type).toContain("one: Node;");
			expect(parts.type).toContain("two: Node2;");
		});

		it("does not treat a schema reused without recursion as recursive", () => {
			// The same object appearing twice as SIBLINGS is not a cycle. Naming it
			// would clutter the prompt with an interface for an ordinary shared shape.
			const shared = { properties: { id: { type: "string" } } };

			const parts = jtdToTypeScriptParts({ properties: { left: shared, right: shared } });

			expect(parts.definitions).toBe("");
			expect(parts.type).toContain("left: {");
			expect(parts.type).toContain("right: {");
		});
	});

	describe("a schema too deep to render", () => {
		function nested(depth: number): Record<string, unknown> {
			let schema: Record<string, unknown> = { type: "string" };
			for (let i = 0; i < depth; i++) schema = { properties: { next: schema } };
			return schema;
		}

		it("refuses with a message naming the depth, not a stack overflow", () => {
			// `RangeError: Maximum call stack size exceeded` names neither the schema
			// nor the reason, and is what the operator used to get.
			expect(() => jtdToTypeScript(nested(150))).toThrow(/levels deep/);
		});

		it("tells the operator how to fix it", () => {
			expect(() => jtdToTypeScript(nested(150))).toThrow(/Flatten it/);
		});

		it("still renders a deeply nested but acceptable schema", () => {
			// The ceiling must not reject schemas people legitimately write. Fifty
			// levels is already far past anything reasonable.
			const output = jtdToTypeScript(nested(50));

			expect(output).toContain("next:");
			expect(output).toContain("string");
		});
	});
});
