import { describe, expect, it } from "bun:test";
import { isValidJsonSchema } from "../src/utils/schema/meta-validator";

describe("isValidJsonSchema", () => {
	it("returns true for true schema", () => {
		expect(isValidJsonSchema(true)).toBe(true);
	});
	it("returns true for false schema", () => {
		expect(isValidJsonSchema(false)).toBe(true);
	});
	it("returns false for non-object non-boolean", () => {
		expect(isValidJsonSchema("hello")).toBe(false);
	});
	it("returns false for null", () => {
		expect(isValidJsonSchema(null)).toBe(false);
	});
	it("returns true for valid string type", () => {
		expect(isValidJsonSchema({ type: "string" })).toBe(true);
	});
	it("returns true for valid number type", () => {
		expect(isValidJsonSchema({ type: "number" })).toBe(true);
	});
	it("returns true for valid integer type", () => {
		expect(isValidJsonSchema({ type: "integer" })).toBe(true);
	});
	it("returns true for valid boolean type", () => {
		expect(isValidJsonSchema({ type: "boolean" })).toBe(true);
	});
	it("returns true for valid null type", () => {
		expect(isValidJsonSchema({ type: "null" })).toBe(true);
	});
	it("returns true for valid array type", () => {
		expect(isValidJsonSchema({ type: "array" })).toBe(true);
	});
	it("returns true for valid object type", () => {
		expect(isValidJsonSchema({ type: "object" })).toBe(true);
	});
	it("returns false for invalid type string", () => {
		expect(isValidJsonSchema({ type: "custom" })).toBe(false);
	});
	it("returns true for type array", () => {
		expect(isValidJsonSchema({ type: ["string", "null"] })).toBe(true);
	});
	it("returns false for empty type array", () => {
		expect(isValidJsonSchema({ type: [] })).toBe(false);
	});
	it("returns false for type array with duplicates", () => {
		expect(isValidJsonSchema({ type: ["string", "string"] })).toBe(false);
	});
	it("returns false for type array with invalid type", () => {
		expect(isValidJsonSchema({ type: ["string", "custom"] })).toBe(false);
	});
	it("returns true for valid anyOf", () => {
		expect(isValidJsonSchema({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe(true);
	});
	it("returns false for invalid anyOf entry", () => {
		expect(isValidJsonSchema({ anyOf: [{ type: "custom" }] })).toBe(false);
	});
	it("returns true for valid oneOf", () => {
		expect(isValidJsonSchema({ oneOf: [{ type: "string" }] })).toBe(true);
	});
	it("returns true for valid allOf", () => {
		expect(isValidJsonSchema({ allOf: [{ type: "string" }] })).toBe(true);
	});
	it("returns true for valid properties", () => {
		expect(isValidJsonSchema({ properties: { name: { type: "string" } } })).toBe(true);
	});
	it("returns false for invalid properties entry", () => {
		expect(isValidJsonSchema({ properties: { name: { type: "custom" } } })).toBe(false);
	});
	it("returns true for valid required array", () => {
		expect(isValidJsonSchema({ required: ["name", "age"] })).toBe(true);
	});
	it("returns false for required with non-string entry", () => {
		expect(isValidJsonSchema({ required: ["name", 42] })).toBe(false);
	});
	it("returns false for required with duplicates", () => {
		expect(isValidJsonSchema({ required: ["name", "name"] })).toBe(false);
	});
	it("returns false for required not array", () => {
		expect(isValidJsonSchema({ required: "name" })).toBe(false);
	});
	it("returns true for valid items", () => {
		expect(isValidJsonSchema({ items: { type: "string" } })).toBe(true);
	});
	it("returns false for items as array (draft-07 tuple)", () => {
		expect(isValidJsonSchema({ items: [{ type: "string" }] })).toBe(false);
	});
	it("returns true for valid prefixItems", () => {
		expect(isValidJsonSchema({ prefixItems: [{ type: "string" }] })).toBe(true);
	});
	it("returns false for additionalItems (deprecated)", () => {
		expect(isValidJsonSchema({ additionalItems: { type: "string" } })).toBe(false);
	});
	it("returns false for dependencies (deprecated)", () => {
		expect(isValidJsonSchema({ dependencies: { a: ["b"] } })).toBe(false);
	});
	it("returns true for additionalProperties: false", () => {
		expect(isValidJsonSchema({ additionalProperties: false })).toBe(true);
	});
	it("returns true for additionalProperties: true", () => {
		expect(isValidJsonSchema({ additionalProperties: true })).toBe(true);
	});
	it("returns true for additionalProperties as schema", () => {
		expect(isValidJsonSchema({ additionalProperties: { type: "string" } })).toBe(true);
	});
	it("returns true for valid enum", () => {
		expect(isValidJsonSchema({ enum: ["a", "b", "c"] })).toBe(true);
	});
	it("returns false for empty enum", () => {
		expect(isValidJsonSchema({ enum: [] })).toBe(false);
	});
	it("returns false for enum with duplicates", () => {
		expect(isValidJsonSchema({ enum: ["a", "a"] })).toBe(false);
	});
	it("returns false for enum not array", () => {
		expect(isValidJsonSchema({ enum: "a" })).toBe(false);
	});
	it("returns true for valid minimum", () => {
		expect(isValidJsonSchema({ type: "number", minimum: 0 })).toBe(true);
	});
	it("returns false for minimum not number", () => {
		expect(isValidJsonSchema({ type: "number", minimum: "0" })).toBe(false);
	});
	it("returns true for valid multipleOf", () => {
		expect(isValidJsonSchema({ type: "number", multipleOf: 5 })).toBe(true);
	});
	it("returns false for multipleOf <= 0", () => {
		expect(isValidJsonSchema({ type: "number", multipleOf: 0 })).toBe(false);
	});
	it("returns false for negative multipleOf", () => {
		expect(isValidJsonSchema({ type: "number", multipleOf: -5 })).toBe(false);
	});
	it("returns true for valid minLength", () => {
		expect(isValidJsonSchema({ type: "string", minLength: 1 })).toBe(true);
	});
	it("returns false for minLength negative", () => {
		expect(isValidJsonSchema({ type: "string", minLength: -1 })).toBe(false);
	});
	it("returns false for minLength not integer", () => {
		expect(isValidJsonSchema({ type: "string", minLength: 1.5 })).toBe(false);
	});
	it("returns true for valid pattern", () => {
		expect(isValidJsonSchema({ type: "string", pattern: "^a" })).toBe(true);
	});
	it("returns false for invalid pattern", () => {
		expect(isValidJsonSchema({ type: "string", pattern: "[" })).toBe(false);
	});
	it("returns false for pattern not string", () => {
		expect(isValidJsonSchema({ type: "string", pattern: 42 })).toBe(false);
	});
	it("returns true for valid format", () => {
		expect(isValidJsonSchema({ type: "string", format: "email" })).toBe(true);
	});
	it("returns false for format not string", () => {
		expect(isValidJsonSchema({ type: "string", format: 42 })).toBe(false);
	});
	it("returns true for valid nullable", () => {
		expect(isValidJsonSchema({ type: "string", nullable: true })).toBe(true);
	});
	it("returns false for nullable not boolean", () => {
		expect(isValidJsonSchema({ type: "string", nullable: "yes" })).toBe(false);
	});
	it("returns true for valid $defs", () => {
		expect(isValidJsonSchema({ $defs: { name: { type: "string" } } })).toBe(true);
	});
	it("returns true for valid definitions", () => {
		expect(isValidJsonSchema({ definitions: { name: { type: "string" } } })).toBe(true);
	});
	it("returns true for valid not", () => {
		expect(isValidJsonSchema({ not: { type: "string" } })).toBe(true);
	});
	it("returns false for invalid not", () => {
		expect(isValidJsonSchema({ not: { type: "custom" } })).toBe(false);
	});
	it("returns true for valid if/then/else", () => {
		expect(
			isValidJsonSchema({
				if: { type: "string" },
				// biome-ignore lint/suspicious/noThenProperty: JSON schema keyword, not a promise
				then: { type: "string" },
				else: { type: "number" },
			}),
		).toBe(true);
	});
	it("returns false for invalid if", () => {
		expect(isValidJsonSchema({ if: { type: "custom" } })).toBe(false);
	});
	it("returns true for valid dependentSchemas", () => {
		expect(isValidJsonSchema({ dependentSchemas: { a: { type: "string" } } })).toBe(true);
	});
	it("returns true for valid dependentRequired", () => {
		expect(isValidJsonSchema({ dependentRequired: { a: ["b"] } })).toBe(true);
	});
	it("returns false for dependentRequired with non-string entry", () => {
		expect(isValidJsonSchema({ dependentRequired: { a: [42] } })).toBe(false);
	});
	it("returns true for valid uniqueItems", () => {
		expect(isValidJsonSchema({ uniqueItems: true })).toBe(true);
	});
	it("returns false for uniqueItems not boolean", () => {
		expect(isValidJsonSchema({ uniqueItems: "yes" })).toBe(false);
	});
	it("returns true for valid readOnly", () => {
		expect(isValidJsonSchema({ readOnly: true })).toBe(true);
	});
	it("returns false for readOnly not boolean", () => {
		expect(isValidJsonSchema({ readOnly: "yes" })).toBe(false);
	});
	it("returns true for valid writeOnly", () => {
		expect(isValidJsonSchema({ writeOnly: false })).toBe(true);
	});
	it("returns true for valid deprecated", () => {
		expect(isValidJsonSchema({ deprecated: true })).toBe(true);
	});
	it("returns true for empty object", () => {
		expect(isValidJsonSchema({})).toBe(true);
	});
	it("handles circular references", () => {
		const schema: Record<string, unknown> = { type: "object", properties: {} };
		schema.properties.self = schema;
		expect(isValidJsonSchema(schema)).toBe(true);
	});
});
