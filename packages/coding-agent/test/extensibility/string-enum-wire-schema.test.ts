import { describe, expect, it } from "bun:test";
import { StringEnum } from "@veyyon/kernel/loader/legacy-pi-ai-shim";

/**
 * StringEnum is the legacy pi-ai compat helper an old extension uses to declare an enum
 * parameter. Its contract is that the schema serializes to the legacy wire form
 * `{ type: "string", enum: [...] }`, which is how a pi-ai extension's tool parameter
 * reaches the model. It previously injected that form via a NON-enumerable `toJSON`.
 *
 * The bug this suite locks out (BUG-STRINGENUM-TOJSON-NONENUMERABLE-DEAD-UNDER-BUN):
 * Bun up to 1.3 deviated from the ECMAScript spec and ignored a non-enumerable
 * `toJSON` (Node honors it). So under Bun -- the runtime veyyon ships on -- the override
 * never fired and JSON.stringify produced the bare TypeBox form: `{ enum: [...] }` with
 * NO `type`, `{ const: x }` for a single value, and `{ not: {} }` for an empty set. The
 * `.toJSON()` method and JSON.stringify silently disagreed. The typebox shim's own
 * contract is that a schema serializes through its ENUMERABLE keywords, so the fix
 * rewrites the schema's own enumerable keywords to the legacy form. Bun 1.4.0 honors a
 * non-enumerable `toJSON`, which retires the deviation but not the fix: enumerable
 * keywords serialize the same on every runtime, and the canary at the bottom records
 * which mechanism the runtime under this suite supports.
 *
 * These assert the legacy wire form on every serialization boundary (top-level, nested,
 * array), that JSON.stringify and .toJSON() AGREE, that runtime validation still works,
 * and -- as the root-cause control -- what the runtime does with a non-enumerable
 * toJSON, so a flip in either direction fails loudly.
 */

describe("StringEnum legacy wire schema", () => {
	it("serializes an array enum to { type: 'string', enum: [...] } with options merged", () => {
		const schema = StringEnum(["a", "b"], { default: "a" });
		expect(JSON.parse(JSON.stringify(schema))).toEqual({ type: "string", enum: ["a", "b"], default: "a" });
	});

	it("serializes the same form when nested inside a parameters object and in an array", () => {
		const schema = StringEnum(["x", "y"]);
		expect(JSON.parse(JSON.stringify({ params: schema }))).toEqual({
			params: { type: "string", enum: ["x", "y"] },
		});
		expect(JSON.parse(JSON.stringify([schema]))).toEqual([{ type: "string", enum: ["x", "y"] }]);
	});

	it("keeps enum: [value] for a single value instead of collapsing to const", () => {
		expect(JSON.parse(JSON.stringify(StringEnum(["only"])))).toEqual({ type: "string", enum: ["only"] });
	});

	it("keeps enum: [] for an empty set instead of collapsing to not: {}", () => {
		expect(JSON.parse(JSON.stringify(StringEnum([])))).toEqual({ type: "string", enum: [] });
	});

	it("derives the enum from a record's values", () => {
		expect(JSON.parse(JSON.stringify(StringEnum({ A: "a", B: "b" })))).toEqual({ type: "string", enum: ["a", "b"] });
	});

	it("drops option keys whose value is undefined", () => {
		const schema = StringEnum(["x"], { description: undefined, default: "x" });
		expect(JSON.parse(JSON.stringify(schema))).toEqual({ type: "string", enum: ["x"], default: "x" });
	});

	it("makes JSON.stringify and .toJSON() agree (they previously diverged under Bun)", () => {
		const schema = StringEnum(["a", "b"], { default: "a" }) as unknown as { toJSON(): unknown };
		expect(JSON.parse(JSON.stringify(schema))).toEqual(schema.toJSON());
	});

	it("does not leak a toJSON key into an object spread of the schema", () => {
		const schema = StringEnum(["a", "b"]);
		expect(Object.keys({ ...schema })).not.toContain("toJSON");
	});
});

describe("StringEnum runtime validation still works", () => {
	it("accepts a member and rejects a non-member via safeParse", () => {
		const schema = StringEnum(["a", "b"]) as unknown as {
			safeParse(input: unknown): { success: boolean; data?: unknown };
		};
		expect(schema.safeParse("a")).toEqual({ success: true, data: "a" });
		expect(schema.safeParse("z").success).toBe(false);
	});
});

describe("the runtime's non-enumerable toJSON behavior (root cause)", () => {
	/**
	 * WHY THIS IS STILL HERE, NOW THAT IT PASSES THE OTHER WAY.
	 *
	 * Bun ignored a non-enumerable `toJSON` up to 1.3, which is what killed the old
	 * override. Bun 1.4.0 honors it, matching Node and the ECMAScript spec, so this
	 * canary records the runtime's answer rather than a deviation: the fix above does
	 * not depend on it either way, because rewriting the schema's own enumerable
	 * keywords serializes identically on both runtimes. The canary is what tells a
	 * later reader which mechanism the runtime under them actually supports, and it
	 * goes red on the next flip in either direction.
	 */
	it("honors a non-enumerable toJSON, as the spec requires", () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "toJSON", { value: () => ({ ok: 1 }), enumerable: false });
		expect(JSON.stringify(obj)).toBe('{"ok":1}');
		// And an enumerable one, which every runtime has always honored.
		const enumerable: Record<string, unknown> = {};
		Object.defineProperty(enumerable, "toJSON", { value: () => ({ ok: 2 }), enumerable: true });
		expect(JSON.stringify(enumerable)).toBe('{"ok":2}');
	});
});
