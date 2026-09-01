import { describe, expect, it } from "bun:test";
import {
	coerceValue,
	collectSchemaTypes,
	decodeValue,
	getArrayItemSchema,
	getObjectProperties,
	isArraySchema,
	isObjectSchema,
	isStringOnlySchema,
	jsonTypeOf,
	normalizeKimiFunctionName,
	partialSuffixOverlap,
	partialSuffixOverlapAny,
	recordOrEmpty,
} from "../src/dialect/coercion";

describe("jsonTypeOf", () => {
	it("returns 'null' for null", () => {
		expect(jsonTypeOf(null)).toBe("null");
	});
	it("returns 'number' for number", () => {
		expect(jsonTypeOf(42)).toBe("number");
	});
	it("returns 'number' for bigint", () => {
		expect(jsonTypeOf(0n)).toBe("number");
	});
	it("returns 'boolean' for boolean", () => {
		expect(jsonTypeOf(true)).toBe("boolean");
	});
	it("returns 'string' for string", () => {
		expect(jsonTypeOf("hello")).toBe("string");
	});
	it("returns 'object' for object", () => {
		expect(jsonTypeOf({})).toBe("object");
	});
	it("returns 'object' for array", () => {
		expect(jsonTypeOf([])).toBe("object");
	});
	it("returns 'object' for undefined", () => {
		expect(jsonTypeOf(undefined)).toBe("object");
	});
});

describe("collectSchemaTypes", () => {
	it("collects single type", () => {
		expect([...collectSchemaTypes({ type: "string" })]).toEqual(["string"]);
	});
	it("collects array of types", () => {
		const types = collectSchemaTypes({ type: ["string", "null"] });
		expect(types.has("string")).toBe(true);
		expect(types.has("null")).toBe(true);
	});
	it("collects from anyOf branches", () => {
		const types = collectSchemaTypes({ anyOf: [{ type: "string" }, { type: "number" }] });
		expect(types.has("string")).toBe(true);
		expect(types.has("number")).toBe(true);
	});
	it("collects from oneOf branches", () => {
		const types = collectSchemaTypes({ oneOf: [{ type: "boolean" }, { type: "null" }] });
		expect(types.has("boolean")).toBe(true);
		expect(types.has("null")).toBe(true);
	});
	it("collects from allOf branches", () => {
		const types = collectSchemaTypes({ allOf: [{ type: "object" }] });
		expect(types.has("object")).toBe(true);
	});
	it("infers from enum values when type is undefined", () => {
		const types = collectSchemaTypes({ enum: ["a", "b"] });
		expect(types.has("string")).toBe(true);
	});
	it("infers from const when type is undefined", () => {
		const types = collectSchemaTypes({ const: 42 });
		expect(types.has("number")).toBe(true);
	});
	it("returns empty set for non-record schema", () => {
		expect([...collectSchemaTypes("not a record")]).toEqual([]);
	});
	it("respects depth limit", () => {
		const deep: Record<string, unknown> = { type: "string" };
		let current: Record<string, unknown> = deep;
		for (let i = 0; i < 20; i++) {
			current = { anyOf: [current] };
		}
		const types = collectSchemaTypes(current);
		expect(types.size).toBe(0);
	});
});

describe("isStringOnlySchema", () => {
	it("returns true for string-only schema", () => {
		expect(isStringOnlySchema({ type: "string" })).toBe(true);
	});
	it("returns true for string|null schema (null deleted)", () => {
		expect(isStringOnlySchema({ type: ["string", "null"] })).toBe(true);
	});
	it("returns false for object schema", () => {
		expect(isStringOnlySchema({ type: "object" })).toBe(false);
	});
	it("returns false for mixed string+number schema", () => {
		expect(isStringOnlySchema({ type: ["string", "number"] })).toBe(false);
	});
	it("returns false for empty schema", () => {
		expect(isStringOnlySchema({})).toBe(false);
	});
});

describe("decodeValue", () => {
	it("decodes valid JSON string", () => {
		expect(decodeValue('"hello"')).toBe("hello");
	});
	it("decodes valid JSON number", () => {
		expect(decodeValue("42")).toBe(42);
	});
	it("decodes valid JSON object", () => {
		expect(decodeValue('{"key":"value"}')).toEqual({ key: "value" });
	});
	it("decodes valid JSON array", () => {
		expect(decodeValue("[1,2,3]")).toEqual([1, 2, 3]);
	});
	it("returns raw string for invalid JSON", () => {
		expect(decodeValue("hello world")).toBe("hello world");
	});
	it("returns trimmed empty string for whitespace-only input", () => {
		expect(decodeValue("   ")).toBe("");
	});
	it("decodes boolean", () => {
		expect(decodeValue("true")).toBe(true);
	});
	it("decodes null", () => {
		expect(decodeValue("null")).toBeNull();
	});
});

describe("coerceValue", () => {
	it("returns raw string for string-only schema", () => {
		expect(coerceValue("hello", { type: "string" })).toBe("hello");
	});
	it("decodes value for non-string schema", () => {
		expect(coerceValue("42", { type: "number" })).toBe(42);
	});
	it("decodes value for no schema", () => {
		expect(coerceValue('{"a":1}', {})).toEqual({ a: 1 });
	});
	it("returns raw string for string|null schema", () => {
		expect(coerceValue("hello", { type: ["string", "null"] })).toBe("hello");
	});
});

describe("isArraySchema", () => {
	it("returns true for array type", () => {
		expect(isArraySchema({ type: "array" })).toBe(true);
	});
	it("returns false for non-array type", () => {
		expect(isArraySchema({ type: "string" })).toBe(false);
	});
	it("returns true for array in anyOf", () => {
		expect(isArraySchema({ anyOf: [{ type: "array" }, { type: "string" }] })).toBe(true);
	});
});

describe("isObjectSchema", () => {
	it("returns true for object type", () => {
		expect(isObjectSchema({ type: "object" })).toBe(true);
	});
	it("returns false for non-object type", () => {
		expect(isObjectSchema({ type: "string" })).toBe(false);
	});
});

describe("getObjectProperties", () => {
	it("returns properties from schema", () => {
		const schema = { properties: { name: { type: "string" }, age: { type: "number" } } };
		expect(getObjectProperties(schema)).toEqual({
			name: { type: "string" },
			age: { type: "number" },
		});
	});
	it("returns empty object when no properties", () => {
		expect(getObjectProperties({ type: "object" })).toEqual({});
	});
	it("returns empty object for non-record schema", () => {
		expect(getObjectProperties("not a record")).toEqual({});
	});
	it("returns empty object when properties is not a record", () => {
		expect(getObjectProperties({ properties: "not a record" })).toEqual({});
	});
});

describe("getArrayItemSchema", () => {
	it("returns items from array schema", () => {
		const schema = { type: "array", items: { type: "string" } };
		expect(getArrayItemSchema(schema)).toEqual({ type: "string" });
	});
	it("returns undefined when no items", () => {
		expect(getArrayItemSchema({ type: "array" })).toBeUndefined();
	});
	it("returns undefined for non-record schema", () => {
		expect(getArrayItemSchema("not a record")).toBeUndefined();
	});
});

describe("partialSuffixOverlap", () => {
	it("returns 0 when no overlap", () => {
		expect(partialSuffixOverlap("hello", "world")).toBe(0);
	});
	it("returns 0 for empty text", () => {
		expect(partialSuffixOverlap("", "tag")).toBe(0);
	});
	it("returns overlap length for partial match at end", () => {
		expect(partialSuffixOverlap("hello<to", "<tool>")).toBe(3);
	});
	it("returns 0 when text ends with full tag (excluded)", () => {
		expect(partialSuffixOverlap("hello<tool>", "<tool>")).toBe(0);
	});
	it("returns overlap for single char", () => {
		expect(partialSuffixOverlap("hello<", "<tool>")).toBe(1);
	});
});

describe("partialSuffixOverlapAny", () => {
	it("returns best overlap across multiple tags", () => {
		expect(partialSuffixOverlapAny("hello<to", ["<tag>", "<tool>"])).toBe(3);
	});
	it("returns 0 when no overlap with any tag", () => {
		expect(partialSuffixOverlapAny("hello", ["<tag>", "<tool>"])).toBe(0);
	});
	it("returns 0 for empty tags", () => {
		expect(partialSuffixOverlapAny("hello", [])).toBe(0);
	});
});

describe("normalizeKimiFunctionName", () => {
	it("returns last part after dot", () => {
		expect(normalizeKimiFunctionName("module.function")).toBe("function");
	});
	it("returns part before colon", () => {
		expect(normalizeKimiFunctionName("function:123")).toBe("function");
	});
	it("handles combined dot and colon", () => {
		expect(normalizeKimiFunctionName("module.function:123")).toBe("function");
	});
	it("returns trimmed result for simple name", () => {
		expect(normalizeKimiFunctionName("  func  ")).toBe("func");
	});
	it("returns trimmed for name with only colon", () => {
		expect(normalizeKimiFunctionName("func:")).toBe("func");
	});
	it("handles empty string", () => {
		expect(normalizeKimiFunctionName("")).toBe("");
	});
});

describe("recordOrEmpty", () => {
	it("returns record for object input", () => {
		expect(recordOrEmpty({ key: "value" })).toEqual({ key: "value" });
	});
	it("returns empty object for null", () => {
		expect(recordOrEmpty(null)).toEqual({});
	});
	it("returns empty object for undefined", () => {
		expect(recordOrEmpty(undefined)).toEqual({});
	});
	it("returns empty object for string", () => {
		expect(recordOrEmpty("hello")).toEqual({});
	});
	it("returns empty object for array", () => {
		expect(recordOrEmpty([1, 2, 3])).toEqual({});
	});
	it("returns empty object for number", () => {
		expect(recordOrEmpty(42)).toEqual({});
	});
	it("returns the same record for empty object", () => {
		expect(recordOrEmpty({})).toEqual({});
	});
});
