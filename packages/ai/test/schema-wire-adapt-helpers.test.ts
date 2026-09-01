import { describe, expect, it } from "bun:test";
import { adaptSchemaForStrict } from "../src/utils/schema/adapt";
import {
	isArkErrors,
	isArkSchema,
	isZodSchema,
	normalizeEmptySchemas,
	stripSchemaDescriptions,
} from "../src/utils/schema/wire";

describe("isZodSchema", () => {
	it("returns false for null", () => {
		expect(isZodSchema(null)).toBe(false);
	});
	it("returns false for string", () => {
		expect(isZodSchema("hello")).toBe(false);
	});
	it("returns false for plain object", () => {
		expect(isZodSchema({})).toBe(false);
	});
	it("returns false for object with _zod but no parse", () => {
		expect(isZodSchema({ _zod: {} })).toBe(false);
	});
	it("returns false for object with parse but no _zod", () => {
		expect(isZodSchema({ parse: () => {} })).toBe(false);
	});
});

describe("isArkSchema", () => {
	it("returns false for null", () => {
		expect(isArkSchema(null)).toBe(false);
	});
	it("returns false for string", () => {
		expect(isArkSchema("hello")).toBe(false);
	});
	it("returns false for plain object", () => {
		expect(isArkSchema({})).toBe(false);
	});
	it("returns false for function without toJsonSchema", () => {
		expect(isArkSchema(() => {})).toBe(false);
	});
	it("returns false for function with toJsonSchema but no assert", () => {
		expect(isArkSchema({ toJsonSchema: () => {} })).toBe(false);
	});
});

describe("isArkErrors", () => {
	it("returns false for non-array", () => {
		expect(isArkErrors("hello")).toBe(false);
	});
	it("returns false for array without summary", () => {
		expect(isArkErrors([1, 2, 3])).toBe(false);
	});
	it("returns false for null", () => {
		expect(isArkErrors(null)).toBe(false);
	});
	it("returns true for array with summary function", () => {
		const errors = [1, 2] as unknown[];
		(errors as { summary?: string }).summary = "test";
		expect(isArkErrors(errors)).toBe(true);
	});
});

describe("normalizeEmptySchemas", () => {
	it("replaces empty object in items with true", () => {
		const schema = { type: "array", items: {} };
		normalizeEmptySchemas(schema);
		expect(schema.items).toBe(true);
	});
	it("replaces empty objects in properties map", () => {
		const schema = { type: "object", properties: { name: {} } };
		normalizeEmptySchemas(schema);
		expect(schema.properties.name).toBe(true);
	});
	it("replaces empty objects in anyOf array", () => {
		const schema: Record<string, unknown> = { anyOf: [{}, { type: "string" }] };
		normalizeEmptySchemas(schema);
		expect((schema.anyOf as unknown[])[0]).toBe(true);
		expect((schema.anyOf as unknown[])[1]).toEqual({ type: "string" });
	});
	it("does not replace non-empty objects", () => {
		const schema = { type: "array", items: { type: "string" } };
		normalizeEmptySchemas(schema);
		expect(schema.items).toEqual({ type: "string" });
	});
	it("handles null and primitives", () => {
		expect(() => normalizeEmptySchemas(null)).not.toThrow();
		expect(() => normalizeEmptySchemas("hello")).not.toThrow();
		expect(() => normalizeEmptySchemas(42)).not.toThrow();
	});
	it("handles arrays", () => {
		expect(() => normalizeEmptySchemas([1, 2, 3])).not.toThrow();
	});
	it("recurses into nested objects", () => {
		const schema = {
			type: "object",
			properties: {
				address: {
					type: "object",
					properties: { city: {} },
				},
			},
		};
		normalizeEmptySchemas(schema);
		expect(schema.properties.address.properties.city).toBe(true);
	});
});

describe("stripSchemaDescriptions", () => {
	it("strips description from schema", () => {
		const result = stripSchemaDescriptions({ type: "string", description: "test" });
		expect(result.description).toBeUndefined();
	});
	it("strips descriptions from nested properties", () => {
		const result = stripSchemaDescriptions({
			type: "object",
			description: "root",
			properties: {
				name: { type: "string", description: "name field" },
			},
		});
		expect(result.description).toBeUndefined();
		const props = result.properties as Record<string, unknown>;
		expect((props.name as Record<string, unknown>).description).toBeUndefined();
	});
	it("preserves type", () => {
		const result = stripSchemaDescriptions({ type: "string", description: "test" });
		expect(result.type).toBe("string");
	});
	it("caches result", () => {
		const schema = { type: "string", description: "test" };
		const r1 = stripSchemaDescriptions(schema);
		const r2 = stripSchemaDescriptions(schema);
		expect(r1).toBe(r2);
	});
	it("handles schema without description", () => {
		const result = stripSchemaDescriptions({ type: "string" });
		expect(result.type).toBe("string");
		expect(result.description).toBeUndefined();
	});
});

describe("adaptSchemaForStrict", () => {
	it("returns non-strict for strict=false", () => {
		const result = adaptSchemaForStrict({ type: "string" }, false);
		expect(result.strict).toBe(false);
		expect(result.schema.type).toBe("string");
	});
	it("returns strict for valid schema with strict=true", () => {
		const result = adaptSchemaForStrict({ type: "string" }, true);
		expect(result.strict).toBe(true);
		expect(result.schema.type).toBe("string");
	});
	it("returns strict for valid object schema", () => {
		const result = adaptSchemaForStrict(
			{
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
			},
			true,
		);
		expect(result.strict).toBe(true);
		expect(result.schema.additionalProperties).toBe(false);
	});
	it("upgrades draft-07 schema", () => {
		const result = adaptSchemaForStrict(
			{
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "string",
			},
			false,
		);
		expect(result.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
	});
});
