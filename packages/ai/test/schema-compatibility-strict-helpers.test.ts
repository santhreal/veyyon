import { describe, expect, it } from "bun:test";
import { validateSchemaCompatibility } from "../src/utils/schema/compatibility";
import { findStrictToolSchemaViolation } from "../src/utils/schema/strict-tool-validation";

describe("findStrictToolSchemaViolation", () => {
	it("returns null for null schema", () => {
		expect(findStrictToolSchemaViolation(null)).toBeNull();
	});
	it("returns null for non-object schema", () => {
		expect(findStrictToolSchemaViolation("hello")).toBeNull();
	});
	it("returns null for valid simple schema", () => {
		expect(findStrictToolSchemaViolation({ type: "string" })).toBeNull();
	});
	it("returns null for valid object schema", () => {
		expect(
			findStrictToolSchemaViolation({
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
			}),
		).toBeNull();
	});
	it("returns null for valid array schema", () => {
		expect(findStrictToolSchemaViolation({ type: "array", items: { type: "string" } })).toBeNull();
	});
	it("detects enum value not matching type", () => {
		const result = findStrictToolSchemaViolation({ type: "string", enum: [42] });
		expect(result).toBe("#/enum");
	});
	it("detects const value not matching type", () => {
		const result = findStrictToolSchemaViolation({ type: "string", const: 42 });
		expect(result).toBe("#/const");
	});
	it("returns null for enum value matching type", () => {
		expect(findStrictToolSchemaViolation({ type: "string", enum: ["a", "b"] })).toBeNull();
	});
	it("returns null for const value matching type", () => {
		expect(findStrictToolSchemaViolation({ type: "number", const: 42 })).toBeNull();
	});
	it("returns null for integer type with integer const", () => {
		expect(findStrictToolSchemaViolation({ type: "integer", const: 42 })).toBeNull();
	});
	it("detects integer type with non-integer const", () => {
		expect(findStrictToolSchemaViolation({ type: "integer", const: 3.14 })).toBe("#/const");
	});
	it("returns null for boolean type with boolean const", () => {
		expect(findStrictToolSchemaViolation({ type: "boolean", const: true })).toBeNull();
	});
	it("returns null for null type with null const", () => {
		expect(findStrictToolSchemaViolation({ type: "null", const: null })).toBeNull();
	});
	it("detects violation in nested properties", () => {
		const result = findStrictToolSchemaViolation({
			type: "object",
			properties: { age: { type: "string", const: 42 } },
		});
		expect(result).toBe("#/properties/age/const");
	});
	it("detects violation in array items", () => {
		const result = findStrictToolSchemaViolation({
			type: "array",
			items: { type: "string", enum: [1] },
		});
		expect(result).toBe("#/items/enum");
	});
	it("detects violation in anyOf", () => {
		const result = findStrictToolSchemaViolation({
			anyOf: [{ type: "string", const: 1 }],
		});
		expect(result).toBe("#/anyOf/0/const");
	});
	it("detects violation in oneOf", () => {
		const result = findStrictToolSchemaViolation({
			oneOf: [{ type: "number", enum: ["a"] }],
		});
		expect(result).toBe("#/oneOf/0/enum");
	});
	it("detects violation in allOf", () => {
		const result = findStrictToolSchemaViolation({
			allOf: [{ type: "boolean", const: "yes" }],
		});
		expect(result).toBe("#/allOf/0/const");
	});
	it("detects violation in $defs", () => {
		const result = findStrictToolSchemaViolation({
			$defs: { name: { type: "string", enum: [1] } },
		});
		expect(result).toBe("#/$defs/name/enum");
	});
	it("detects violation in definitions", () => {
		const result = findStrictToolSchemaViolation({
			definitions: { name: { type: "number", const: "a" } },
		});
		expect(result).toBe("#/definitions/name/const");
	});
	it("detects violation in prefixItems", () => {
		const result = findStrictToolSchemaViolation({
			prefixItems: [{ type: "string", enum: [true] }],
		});
		expect(result).toBe("#/prefixItems/0/enum");
	});
	it("detects violation in additionalProperties", () => {
		const result = findStrictToolSchemaViolation({
			additionalProperties: { type: "string", const: 1 },
		});
		expect(result).toBe("#/additionalProperties/const");
	});
	it("detects violation in array element", () => {
		const result = findStrictToolSchemaViolation([{ type: "string", const: 1 }]);
		expect(result).toBe("#/0/const");
	});
	it("handles type array with matching enum", () => {
		expect(findStrictToolSchemaViolation({ type: ["string", "null"], enum: ["a", null] })).toBeNull();
	});
	it("handles type array with non-matching enum", () => {
		expect(findStrictToolSchemaViolation({ type: ["string", "null"], enum: [42] })).toBe("#/enum");
	});
	it("returns null for unknown type", () => {
		expect(findStrictToolSchemaViolation({ type: "custom" })).toBeNull();
	});
	it("returns null for schema without type", () => {
		expect(findStrictToolSchemaViolation({ properties: { a: { type: "string" } } })).toBeNull();
	});
	it("detects violation in patternProperties", () => {
		const result = findStrictToolSchemaViolation({
			patternProperties: { "^a": { type: "string", const: 1 } },
		});
		expect(result).toContain("patternProperties");
	});
	it("detects violation in propertyNames", () => {
		const result = findStrictToolSchemaViolation({
			propertyNames: { type: "string", const: 1 },
		});
		expect(result).toContain("propertyNames");
	});
	it("detects violation in contains", () => {
		const result = findStrictToolSchemaViolation({
			type: "array",
			contains: { type: "string", const: 1 },
		});
		expect(result).toContain("contains");
	});
	it("detects violation in not", () => {
		const result = findStrictToolSchemaViolation({
			not: { type: "string", const: 1 },
		});
		expect(result).toContain("not");
	});
	it("detects violation in if", () => {
		const result = findStrictToolSchemaViolation({
			if: { type: "string", const: 1 },
		});
		expect(result).toContain("if");
	});
	it("detects violation in then", () => {
		const result = findStrictToolSchemaViolation({
			// biome-ignore lint/suspicious/noThenProperty: JSON schema keyword, not a promise
			then: { type: "string", const: 1 },
		});
		expect(result).toContain("then");
	});
	it("detects violation in else", () => {
		const result = findStrictToolSchemaViolation({
			else: { type: "string", const: 1 },
		});
		expect(result).toContain("else");
	});
});

describe("validateSchemaCompatibility", () => {
	it("returns compatible for valid string schema with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string" }, "openai-strict");
		expect(result.compatible).toBe(true);
		expect(result.violations).toEqual([]);
	});
	it("returns compatible for valid object schema with openai-strict", () => {
		const result = validateSchemaCompatibility(
			{
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
				additionalProperties: false,
			},
			"openai-strict",
		);
		expect(result.compatible).toBe(true);
	});
	it("returns incompatible for schema with forbidden keys with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", default: "a" }, "openai-strict");
		expect(result.compatible).toBe(false);
		expect(result.violations.length).toBeGreaterThan(0);
	});
	it("returns compatible for valid schema with google", () => {
		const result = validateSchemaCompatibility({ type: "string" }, "google");
		expect(result.compatible).toBe(true);
	});
	it("returns incompatible for schema with $ref with google", () => {
		const result = validateSchemaCompatibility({ $ref: "#/$defs/name" }, "google");
		expect(result.compatible).toBe(false);
	});
	it("returns compatible for valid schema with cloud-code-assist-claude", () => {
		const result = validateSchemaCompatibility(
			{ type: "object", properties: { name: { type: "string" } } },
			"cloud-code-assist-claude",
		);
		expect(result.compatible).toBe(true);
	});
	it("returns provider in result", () => {
		const result = validateSchemaCompatibility({ type: "string" }, "openai-strict");
		expect(result.provider).toBe("openai-strict");
	});
	it("returns incompatible for schema with examples with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", examples: ["a"] }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for schema with format with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", format: "email" }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for schema with pattern with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", pattern: "^a" }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for schema with minLength with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", minLength: 1 }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for schema with minimum with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "number", minimum: 0 }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for schema with const with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", const: "a" }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for schema with nullable with openai-strict", () => {
		const result = validateSchemaCompatibility({ type: "string", nullable: true }, "openai-strict");
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for object without additionalProperties:false with openai-strict", () => {
		const result = validateSchemaCompatibility(
			{ type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			"openai-strict",
		);
		expect(result.compatible).toBe(false);
	});
	it("returns incompatible for object with unrequired property with openai-strict", () => {
		const result = validateSchemaCompatibility(
			{
				type: "object",
				properties: { name: { type: "string" }, age: { type: "number" } },
				required: ["name"],
				additionalProperties: false,
			},
			"openai-strict",
		);
		expect(result.compatible).toBe(false);
	});
});
