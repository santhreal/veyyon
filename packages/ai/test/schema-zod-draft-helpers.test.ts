import { describe, expect, it } from "bun:test";
import {
	JSON_SCHEMA_DRAFT_2020_12_URI,
	schemaNeedsDraft202012Upgrade,
	upgradeJsonSchemaTo202012,
} from "../src/utils/schema/draft";
import { decontaminateZodInstance } from "../src/utils/schema/zod-decontaminate";

describe("decontaminateZodInstance", () => {
	it("returns non-object value unchanged", () => {
		expect(decontaminateZodInstance("hello")).toBe("hello");
	});
	it("returns number unchanged", () => {
		expect(decontaminateZodInstance(42)).toBe(42);
	});
	it("returns null unchanged", () => {
		expect(decontaminateZodInstance(null)).toBeNull();
	});
	it("returns plain object without zod leak unchanged", () => {
		const obj = { type: "string", description: "test" };
		expect(decontaminateZodInstance(obj)).toBe(obj);
	});
	it("returns array without zod leaks unchanged", () => {
		const arr = [1, 2, 3];
		expect(decontaminateZodInstance(arr)).toBe(arr);
	});
	it("decontaminates zod string leak", () => {
		const zodLeak = {
			type: "string",
			def: { type: "string" },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("string");
		expect(result.def).toBeUndefined();
	});
	it("decontaminates zod number leak", () => {
		const zodLeak = {
			type: "number",
			def: { type: "number" },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("number");
		expect(result.def).toBeUndefined();
	});
	it("decontaminates zod boolean leak", () => {
		const zodLeak = {
			type: "boolean",
			def: { type: "boolean" },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("boolean");
	});
	it("decontaminates zod object leak with shape", () => {
		const zodLeak = {
			type: "object",
			def: {
				type: "object",
				shape: {
					name: { type: "string", def: { type: "string" } },
				},
			},
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("object");
		const props = result.properties as Record<string, unknown>;
		expect(props.name).toBeDefined();
		expect((props.name as Record<string, unknown>).def).toBeUndefined();
	});
	it("decontaminates zod array leak with element", () => {
		const zodLeak = {
			type: "array",
			def: {
				type: "array",
				element: { type: "string", def: { type: "string" } },
			},
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("array");
		const items = result.items as Record<string, unknown>;
		expect(items.def).toBeUndefined();
	});
	it("decontaminates zod enum leak", () => {
		const zodLeak = {
			type: "enum",
			def: { type: "enum", entries: { a: "a", b: "b" } },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("string");
		expect(result.enum).toEqual(["a", "b"]);
	});
	it("decontaminates zod literal leak with single value", () => {
		const zodLeak = {
			type: "literal",
			def: { type: "literal", values: ["hello"] },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.const).toBe("hello");
	});
	it("decontaminates zod union leak", () => {
		const zodLeak = {
			type: "union",
			def: {
				type: "union",
				options: [
					{ type: "string", def: { type: "string" } },
					{ type: "number", def: { type: "number" } },
				],
			},
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.anyOf).toBeDefined();
		const anyOf = result.anyOf as unknown[];
		expect(anyOf).toHaveLength(2);
	});
	it("decontaminates zod nullable leak", () => {
		const zodLeak = {
			type: "nullable",
			def: { type: "nullable", innerType: { type: "string", def: { type: "string" } } },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toEqual(["string", "null"]);
	});
	it("does not treat non-zod object as leak", () => {
		const obj = { type: "string", def: { type: "not-a-zod-kind" } };
		expect(decontaminateZodInstance(obj)).toBe(obj);
	});
	it("handles nested non-zod objects", () => {
		const obj = { a: { b: { c: 1 } } };
		expect(decontaminateZodInstance(obj)).toBe(obj);
	});
	it("handles circular references in arrays", () => {
		const arr: unknown[] = [1, 2];
		arr.push(arr);
		const result = decontaminateZodInstance(arr);
		expect(Array.isArray(result)).toBe(true);
	});
	it("handles circular references in objects", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		const result = decontaminateZodInstance(obj);
		expect(typeof result).toBe("object");
	});
	it("strips zod noise keys from scalar leak", () => {
		const zodLeak = {
			type: "string",
			def: { type: "string" },
			options: {},
			_zod: {},
			checks: [],
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.options).toBeUndefined();
		expect(result._zod).toBeUndefined();
		expect(result.checks).toBeUndefined();
	});
	it("decontaminates zod int leak to integer type", () => {
		const zodLeak = {
			type: "int",
			def: { type: "int" },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("integer");
	});
	it("decontaminates zod bigint leak to string type", () => {
		const zodLeak = {
			type: "bigint",
			def: { type: "bigint" },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("string");
	});
	it("decontaminates zod date leak to string type", () => {
		const zodLeak = {
			type: "date",
			def: { type: "date" },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("string");
	});
	it("decontaminates zod set leak to array with uniqueItems", () => {
		const zodLeak = {
			type: "set",
			def: { type: "set", valueType: { type: "string", def: { type: "string" } } },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("array");
		expect(result.uniqueItems).toBe(true);
	});
	it("decontaminates zod tuple leak to array with prefixItems", () => {
		const zodLeak = {
			type: "tuple",
			def: {
				type: "tuple",
				items: [{ type: "string", def: { type: "string" } }],
			},
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("array");
		expect(result.prefixItems).toBeDefined();
	});
	it("decontaminates zod record leak to object with additionalProperties", () => {
		const zodLeak = {
			type: "record",
			def: { type: "record", valueType: { type: "string", def: { type: "string" } } },
		};
		const result = decontaminateZodInstance(zodLeak) as Record<string, unknown>;
		expect(result.type).toBe("object");
		expect(result.additionalProperties).toBeDefined();
	});
});

describe("JSON_SCHEMA_DRAFT_2020_12_URI", () => {
	it("is the correct URI", () => {
		expect(JSON_SCHEMA_DRAFT_2020_12_URI).toBe("https://json-schema.org/draft/2020-12/schema");
	});
});

describe("schemaNeedsDraft202012Upgrade", () => {
	it("returns false for null schema", () => {
		expect(schemaNeedsDraft202012Upgrade(null)).toBe(false);
	});
	it("returns false for non-object schema", () => {
		expect(schemaNeedsDraft202012Upgrade("hello")).toBe(false);
	});
	it("returns false for already 2020-12 schema", () => {
		expect(
			schemaNeedsDraft202012Upgrade({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "string",
			}),
		).toBe(false);
	});
	it("returns true for draft-07 schema", () => {
		expect(
			schemaNeedsDraft202012Upgrade({
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "string",
			}),
		).toBe(true);
	});
	it("returns true for schema with definitions", () => {
		expect(
			schemaNeedsDraft202012Upgrade({
				type: "string",
				definitions: { name: { type: "string" } },
			}),
		).toBe(true);
	});
	it("returns true for schema with $ref to definitions", () => {
		expect(
			schemaNeedsDraft202012Upgrade({
				$ref: "#/definitions/name",
			}),
		).toBe(true);
	});
	it("returns false for schema without draft-07 features", () => {
		expect(schemaNeedsDraft202012Upgrade({ type: "string" })).toBe(false);
	});
});

describe("upgradeJsonSchemaTo202012", () => {
	it("returns schema unchanged if no upgrade needed", () => {
		const schema = { type: "string" };
		expect(upgradeJsonSchemaTo202012(schema)).toBe(schema);
	});
	it("upgrades $schema URI from draft-07", () => {
		const result = upgradeJsonSchemaTo202012({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "string",
		}) as Record<string, unknown>;
		expect(result.$schema).toBe(JSON_SCHEMA_DRAFT_2020_12_URI);
	});
	it("converts definitions to $defs", () => {
		const result = upgradeJsonSchemaTo202012({
			type: "object",
			definitions: { name: { type: "string" } },
		}) as Record<string, unknown>;
		expect(result.$defs).toBeDefined();
		expect(result.definitions).toBeUndefined();
	});
	it("converts $ref from #/definitions/ to #/$defs/", () => {
		const result = upgradeJsonSchemaTo202012({
			definitions: { name: { type: "string" } },
			$ref: "#/definitions/name",
		}) as Record<string, unknown>;
		expect(result.$ref).toBe("#/$defs/name");
	});
	it("upgrades schema with dependencies to dependentRequired", () => {
		const result = upgradeJsonSchemaTo202012({
			type: "object",
			properties: { a: { type: "string" } },
			dependencies: { a: ["b"] },
		}) as Record<string, unknown>;
		expect(result.dependentRequired).toBeDefined();
	});
});
