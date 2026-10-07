/**
 * WHY: an MCP server that ships `JSON.stringify(zodSchema)` as a tool's `inputSchema` sends Zod's
 * instance fields (`def`, `type: "enum"`, an object-shaped `enum`, `options`, null-valued checks)
 * where JSON Schema keywords belong, and a strict validator rejects the whole tool list.
 * `decontaminateZodInstance` rewrites every recognized kind into JSON Schema.
 *
 * Class closed: a recognized kind whose rewrite keeps Zod residue or emits invalid JSON Schema. The
 * sweep reads `ZOD_INSTANCE_KINDS` from source, so a kind added there turns this suite red until its
 * rewrite is recorded in `REWRITES`. The suite also pins that the walk copies only the path to a
 * rewrite and returns everything else by reference, that a leak under a key an unmodelled kind keeps
 * is rewritten too, and that a key or kind named for an `Object.prototype` member is not taken for a
 * known one.
 *
 * Not caught: a Zod release that serializes a kind under `def` fields other than the ones these
 * fixtures use.
 */
import { describe, expect, it } from "bun:test";
import { decontaminateZodInstance, isValidJsonSchema, ZOD_INSTANCE_KINDS } from "@veyyon/ai/utils/schema";

type Json = Record<string, unknown>;

const zod = (kind: string, def: Json = {}, surface: Json = {}): Json => ({
	def: { type: kind, ...def },
	type: kind,
	...surface,
});
/** A serialized `z.string()` carrying the null-valued checks Zod leaks, and its rewrite. */
const zString = () => zod("string", { checks: [] }, { format: null, minLength: null });
const STRING = { type: "string" };
const zNumber = () => zod("number");
const NUMBER = { type: "number" };

/** Input and exact rewrite of a serialized instance of every recognized kind. */
const REWRITES: Record<string, { input: () => Json; output: unknown }> = {
	string: {
		input: () => zod("string", {}, { format: null, default: null, description: "d" }),
		output: { type: "string", default: null, description: "d" },
	},
	number: { input: () => zod("number", {}, { minimum: null }), output: NUMBER },
	int: { input: () => zod("int"), output: { type: "integer" } },
	boolean: { input: () => zod("boolean"), output: { type: "boolean" } },
	bigint: { input: () => zod("bigint"), output: STRING },
	null: { input: () => zod("null"), output: { type: "null" } },
	date: { input: () => zod("date"), output: STRING },
	nan: { input: () => zod("nan"), output: NUMBER },
	undefined: { input: () => zod("undefined", {}, { description: "u" }), output: { description: "u" } },
	void: { input: () => zod("void"), output: {} },
	any: { input: () => zod("any", {}, { _zod: { version: 4 }, checks: [] }), output: {} },
	unknown: { input: () => zod("unknown", {}, { enum: { a: "a" } }), output: {} },
	never: { input: () => zod("never"), output: {} },
	symbol: { input: () => zod("symbol"), output: {} },
	promise: { input: () => zod("promise"), output: {} },
	function: { input: () => zod("function"), output: {} },
	file: { input: () => zod("file"), output: {} },
	custom: { input: () => zod("custom", {}, { options: ["x"] }), output: {} },
	template_literal: { input: () => zod("template_literal", {}, { enum: ["a"] }), output: { enum: ["a"] } },
	success: { input: () => zod("success"), output: {} },
	enum: {
		input: () =>
			zod(
				"enum",
				{ entries: { up: "up", down: "down" } },
				{ enum: { up: "up", down: "down" }, options: ["up", "down"] },
			),
		output: { type: "string", enum: ["up", "down"] },
	},
	literal: { input: () => zod("literal", { values: ["on"] }, { values: ["on"] }), output: { const: "on" } },
	union: {
		input: () => zod("union", { options: [zString(), zNumber()] }),
		output: { anyOf: [STRING, NUMBER] },
	},
	discriminatedUnion: {
		input: () => zod("discriminatedUnion", {}, { options: [zString()] }),
		output: { anyOf: [STRING] },
	},
	intersection: {
		input: () => zod("intersection", { left: zString(), right: { type: "object" } }),
		output: { allOf: [STRING, { type: "object" }] },
	},
	array: { input: () => zod("array", { element: zString() }), output: { type: "array", items: STRING } },
	set: {
		input: () => zod("set", { valueType: zNumber() }),
		output: { type: "array", uniqueItems: true, items: NUMBER },
	},
	tuple: {
		input: () => zod("tuple", { items: [zString()], rest: zNumber() }),
		output: { type: "array", prefixItems: [STRING], items: NUMBER },
	},
	record: {
		input: () => zod("record", { valueType: zString() }),
		output: { type: "object", additionalProperties: STRING },
	},
	map: { input: () => zod("map", { valueType: zNumber() }), output: { type: "object", additionalProperties: NUMBER } },
	object: {
		input: () =>
			zod("object", {
				shape: {
					plain: zString(),
					optional: zod("optional", { innerType: zString() }),
					defaulted: zod("default", { innerType: zNumber(), defaultValue: 1 }),
					prefaulted: zod("prefault", { innerType: zNumber() }),
					nullable: zod("nullable", { innerType: zString() }),
				},
			}),
		output: {
			type: "object",
			properties: {
				plain: STRING,
				optional: STRING,
				defaulted: NUMBER,
				prefaulted: NUMBER,
				nullable: { type: ["string", "null"] },
			},
			required: ["plain", "nullable"],
		},
	},
	optional: { input: () => zod("optional", { innerType: zString() }), output: STRING },
	nonoptional: { input: () => zod("nonoptional", { innerType: zString() }), output: STRING },
	nullable: { input: () => zod("nullable", { innerType: zNumber() }), output: { type: ["number", "null"] } },
	default: { input: () => zod("default", { innerType: zString(), defaultValue: "x" }), output: STRING },
	prefault: { input: () => zod("prefault", { innerType: zString() }), output: STRING },
	catch: { input: () => zod("catch", { innerType: zNumber() }), output: NUMBER },
	readonly: { input: () => zod("readonly", { innerType: zString() }), output: STRING },
	brand: { input: () => zod("brand", { innerType: zString() }), output: STRING },
	lazy: { input: () => zod("lazy", { schema: zNumber() }), output: NUMBER },
	pipe: { input: () => zod("pipe", { in: zString(), out: zNumber() }), output: STRING },
	transform: { input: () => zod("transform", { out: zNumber() }), output: NUMBER },
};

const ZOD_RESIDUE = new Set(["def", "_zod", "checks", "options"]);
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** Paths in `value` that still carry a Zod field, an object-shaped `enum`, or a non-JSON-Schema `type`. */
function residue(value: unknown, path = "$", found: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) residue(value[i], `${path}[${i}]`, found);
		return found;
	}
	if (value === null || typeof value !== "object") return found;
	for (const [key, child] of Object.entries(value)) {
		const at = `${path}.${key}`;
		if (ZOD_RESIDUE.has(key)) found.push(at);
		if (key === "enum" && !Array.isArray(child)) found.push(at);
		if (key === "type") {
			const types = Array.isArray(child) ? child : [child];
			if (!types.every(t => typeof t === "string" && JSON_TYPES.has(t))) found.push(at);
		}
		if (key !== "const" && key !== "default" && key !== "enum") residue(child, at, found);
	}
	return found;
}

describe("a serialized Zod instance becomes JSON Schema for every kind", () => {
	it("records a rewrite for every recognized kind", () => {
		expect(Object.keys(REWRITES).sort()).toEqual([...ZOD_INSTANCE_KINDS].sort());
	});

	for (const kind of ZOD_INSTANCE_KINDS) {
		it(`rewrites a serialized ${kind} into valid JSON Schema without Zod residue`, () => {
			const fixture = REWRITES[kind];
			expect(fixture).toBeDefined();
			const input = fixture!.input();
			const snapshot = structuredClone(input);
			const output = decontaminateZodInstance(input);
			expect(output).toEqual(fixture!.output);
			expect(residue(output)).toEqual([]);
			expect(isValidJsonSchema(output)).toBe(true);
			expect(input).toEqual(snapshot);
		});
	}

	it("a serialized instance nested under each kind is rewritten too", () => {
		const nested = zod("array", {
			element: zod("optional", { innerType: zod("union", { options: [zString(), zNumber()] }) }),
		});
		expect(decontaminateZodInstance({ type: "object", properties: { list: nested } })).toEqual({
			type: "object",
			properties: { list: { type: "array", items: { anyOf: [STRING, NUMBER] } } },
		});
	});

	it("a leak under a key an unmodelled kind keeps is rewritten too", () => {
		const input = zod("any", {}, { description: "d", properties: { x: zString() }, items: [zNumber()] });
		expect(decontaminateZodInstance(input)).toEqual({ description: "d", properties: { x: STRING }, items: [NUMBER] });
	});
});

describe("an enum takes its values from options, then entries, then an object-shaped enum", () => {
	const cases: Array<[name: string, surface: Json, def: Json, output: unknown]> = [
		["options", { options: ["a"], enum: { c: "c" } }, { entries: { b: "b" } }, { type: "string", enum: ["a"] }],
		["entries", { enum: { c: "c" } }, { entries: { b: 2.5 } }, { type: "number", enum: [2.5] }],
		["an object-shaped enum", { enum: { c: 3 } }, {}, { type: "integer", enum: [3] }],
		["nothing", {}, {}, { type: "string", enum: [] }],
	];
	for (const [name, surface, def, output] of cases) {
		it(`from ${name}`, () => {
			expect(decontaminateZodInstance(zod("enum", def, surface))).toEqual(output);
		});
	}
});

describe("nullable admits null once whatever its inner schema", () => {
	const cases: Array<[name: string, inner: unknown, output: unknown]> = [
		["a scalar type", zString(), { type: ["string", "null"] }],
		[
			"a type list without null",
			{ type: ["string", "integer"], description: "d" },
			{ type: ["string", "integer", "null"], description: "d" },
		],
		["a type list that already has null", zod("nullable", { innerType: zString() }), { type: ["string", "null"] }],
		["a union", zod("union", { options: [zString()] }), { anyOf: [{ anyOf: [STRING] }, { type: "null" }] }],
		["a reference", { $ref: "#/$defs/x" }, { anyOf: [{ $ref: "#/$defs/x" }, { type: "null" }] }],
		["nothing", undefined, { anyOf: [{}, { type: "null" }] }],
	];
	for (const [name, inner, output] of cases) {
		it(`around ${name}`, () => {
			const def = inner === undefined ? {} : { innerType: inner };
			expect(decontaminateZodInstance(zod("nullable", def))).toEqual(output);
		});
	}
});

describe("the walk copies only the path to a rewrite", () => {
	it("returns a schema with nothing to rewrite by reference", () => {
		const clean = {
			type: "object",
			properties: {
				a: { type: "string" },
				def: { type: "string" },
				list: { anyOf: [{ type: "null" }, { enum: ["x"] }] },
			},
			required: ["a"],
		};
		const snapshot = structuredClone(clean);
		expect(decontaminateZodInstance(clean)).toBe(clean);
		expect(clean).toEqual(snapshot);
	});

	it("keeps every untouched sibling by reference and in order", () => {
		const first = { type: "integer" };
		const last = { type: "boolean" };
		const before = { type: "null" };
		const after = { const: 1 };
		const anyOf = [before, zString(), after, zNumber()];
		const properties = { first, leak: zNumber(), last, again: zString() };
		const input = { type: "object", properties, anyOf, description: "kept" };
		const snapshot = structuredClone(input);

		const output = decontaminateZodInstance(input) as Json & { properties: Json; anyOf: unknown[] };

		expect(output).toEqual({
			type: "object",
			properties: { first, leak: NUMBER, last, again: STRING },
			anyOf: [before, STRING, after, NUMBER],
			description: "kept",
		});
		expect(Object.keys(output)).toEqual(["type", "properties", "anyOf", "description"]);
		expect(Object.keys(output.properties)).toEqual(["first", "leak", "last", "again"]);
		expect(output).not.toBe(input);
		expect(output.properties).not.toBe(properties);
		expect(output.anyOf).not.toBe(anyOf);
		expect(output.properties.first).toBe(first);
		expect(output.properties.last).toBe(last);
		expect(output.anyOf[0]).toBe(before);
		expect(output.anyOf[2]).toBe(after);
		expect(input).toEqual(snapshot);
	});

	it("ends on a schema that reaches itself and keeps the cycle", () => {
		const cyclic: Json = { type: "object" };
		cyclic.properties = { self: cyclic, leak: zString() };
		const output = decontaminateZodInstance(cyclic) as { properties: Json };
		expect(output.properties.leak).toEqual(STRING);
		expect(output.properties.self).toBe(cyclic);
	});
});

describe("a name from Object.prototype is not a known kind or key", () => {
	it("leaves a node whose kind is named for an Object.prototype member alone", () => {
		for (const kind of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
			const node = zod(kind);
			expect(decontaminateZodInstance(node)).toBe(node);
		}
	});

	it("keeps an Object.prototype-named key and drops it when null", () => {
		const input = zod("string", {}, { constructor: "kept", toString: null, valueOf: 1 });
		expect(decontaminateZodInstance(input)).toEqual({ type: "string", constructor: "kept", valueOf: 1 });
	});
});
