import { describe, expect, it } from "bun:test";
import {
	coerceValue,
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
} from "../src/dialect/coercion";

describe("jsonTypeOf", () => {
	it("returns 'null' for null", () => {
		expect(jsonTypeOf(null)).toBe("null");
	});

	it("returns 'number' for number", () => {
		expect(jsonTypeOf(42)).toBe("number");
	});

	it("returns 'number' for bigint", () => {
		expect(jsonTypeOf(42n)).toBe("number");
	});

	it("returns 'boolean' for true", () => {
		expect(jsonTypeOf(true)).toBe("boolean");
	});

	it("returns 'boolean' for false", () => {
		expect(jsonTypeOf(false)).toBe("boolean");
	});

	it("returns 'string' for string", () => {
		expect(jsonTypeOf("hello")).toBe("string");
	});

	it("returns 'object' for plain object", () => {
		expect(jsonTypeOf({})).toBe("object");
	});

	it("returns 'object' for array", () => {
		expect(jsonTypeOf([])).toBe("object");
	});

	it("returns 'object' for undefined", () => {
		expect(jsonTypeOf(undefined)).toBe("object");
	});
});

describe("decodeValue", () => {
	it("decodes JSON string", () => {
		expect(decodeValue('"hello"')).toBe("hello");
	});

	it("decodes JSON number", () => {
		expect(decodeValue("42")).toBe(42);
	});

	it("decodes JSON boolean", () => {
		expect(decodeValue("true")).toBe(true);
	});

	it("decodes JSON null", () => {
		expect(decodeValue("null")).toBeNull();
	});

	it("decodes JSON array", () => {
		expect(decodeValue("[1, 2, 3]")).toEqual([1, 2, 3]);
	});

	it("decodes JSON object", () => {
		expect(decodeValue('{"key":"value"}')).toEqual({ key: "value" });
	});

	it("returns trimmed empty string for whitespace-only input", () => {
		expect(decodeValue("   ")).toBe("");
	});

	it("returns raw string for non-JSON input", () => {
		expect(decodeValue("not json")).toBe("not json");
	});

	it("returns raw string for incomplete JSON", () => {
		expect(decodeValue("{not closed")).toBe("{not closed");
	});

	it("trims before parsing", () => {
		expect(decodeValue('  "hello"  ')).toBe("hello");
	});
});

describe("isStringOnlySchema", () => {
	it("returns true for type: string", () => {
		expect(isStringOnlySchema({ type: "string" })).toBe(true);
	});

	it("returns true for type: ['string', 'null']", () => {
		expect(isStringOnlySchema({ type: ["string", "null"] })).toBe(true);
	});

	it("returns false for type: number", () => {
		expect(isStringOnlySchema({ type: "number" })).toBe(false);
	});

	it("returns false for type: ['string', 'number']", () => {
		expect(isStringOnlySchema({ type: ["string", "number"] })).toBe(false);
	});

	it("returns false for empty schema", () => {
		expect(isStringOnlySchema({})).toBe(false);
	});

	it("returns false for null schema", () => {
		expect(isStringOnlySchema(null)).toBe(false);
	});

	it("returns false for undefined schema", () => {
		expect(isStringOnlySchema(undefined)).toBe(false);
	});

	it("returns true for enum with all string values", () => {
		expect(isStringOnlySchema({ enum: ["a", "b", "c"] })).toBe(true);
	});

	it("returns false for enum with mixed types", () => {
		expect(isStringOnlySchema({ enum: ["a", 1, true] })).toBe(false);
	});

	it("returns true for const string", () => {
		expect(isStringOnlySchema({ const: "fixed" })).toBe(true);
	});

	it("returns false for const number", () => {
		expect(isStringOnlySchema({ const: 42 })).toBe(false);
	});
});

describe("coerceValue", () => {
	it("returns raw string for string-only schema", () => {
		expect(coerceValue("hello", { type: "string" })).toBe("hello");
	});

	it("decodes JSON for non-string schema", () => {
		expect(coerceValue("42", { type: "number" })).toBe(42);
	});

	it("decodes JSON for undefined schema", () => {
		expect(coerceValue('{"key":"value"}', undefined)).toEqual({ key: "value" });
	});

	it("returns raw for string schema even if it looks like JSON", () => {
		expect(coerceValue("123", { type: "string" })).toBe("123");
	});
});

describe("isArraySchema", () => {
	it("returns true for type: array", () => {
		expect(isArraySchema({ type: "array" })).toBe(true);
	});

	it("returns true for type: ['array', 'null']", () => {
		expect(isArraySchema({ type: ["array", "null"] })).toBe(true);
	});

	it("returns false for type: object", () => {
		expect(isArraySchema({ type: "object" })).toBe(false);
	});

	it("returns false for empty schema", () => {
		expect(isArraySchema({})).toBe(false);
	});

	it("returns false for null", () => {
		expect(isArraySchema(null)).toBe(false);
	});
});

describe("isObjectSchema", () => {
	it("returns true for type: object", () => {
		expect(isObjectSchema({ type: "object" })).toBe(true);
	});

	it("returns true for type: ['object', 'null']", () => {
		expect(isObjectSchema({ type: ["object", "null"] })).toBe(true);
	});

	it("returns false for type: array", () => {
		expect(isObjectSchema({ type: "array" })).toBe(false);
	});

	it("returns false for empty schema", () => {
		expect(isObjectSchema({})).toBe(false);
	});

	it("returns false for null", () => {
		expect(isObjectSchema(null)).toBe(false);
	});
});

describe("getObjectProperties", () => {
	it("returns properties object when present", () => {
		const props = { name: { type: "string" }, age: { type: "number" } };
		expect(getObjectProperties({ properties: props })).toEqual(props);
	});

	it("returns empty object when properties is missing", () => {
		expect(getObjectProperties({})).toEqual({});
	});

	it("returns empty object when properties is not a record", () => {
		expect(getObjectProperties({ properties: "not an object" })).toEqual({});
	});

	it("returns empty object for null schema", () => {
		expect(getObjectProperties(null)).toEqual({});
	});

	it("returns empty object for undefined schema", () => {
		expect(getObjectProperties(undefined)).toEqual({});
	});
});

describe("getArrayItemSchema", () => {
	it("returns items schema when present", () => {
		const items = { type: "string" };
		expect(getArrayItemSchema({ items })).toBe(items);
	});

	it("returns undefined when items is missing", () => {
		expect(getArrayItemSchema({})).toBeUndefined();
	});

	it("returns undefined for null schema", () => {
		expect(getArrayItemSchema(null)).toBeUndefined();
	});

	it("returns undefined for undefined schema", () => {
		expect(getArrayItemSchema(undefined)).toBeUndefined();
	});
});

describe("partialSuffixOverlap", () => {
	it("returns 0 when text does not end with any prefix of tag", () => {
		expect(partialSuffixOverlap("hello", "world")).toBe(0);
	});

	it("returns 0 for empty text", () => {
		expect(partialSuffixOverlap("", "tag")).toBe(0);
	});

	it("returns overlap length for partial tag prefix", () => {
		expect(partialSuffixOverlap("hello <to", "<tool_call>")).toBe(3);
	});

	it("returns 0 when text ends with full tag (excluded by length-1)", () => {
		// tag.length - 1 means full match is excluded
		expect(partialSuffixOverlap("hello<tool_call>", "<tool_call>")).toBe(0);
	});

	it("returns 1 for single char overlap", () => {
		expect(partialSuffixOverlap("hello<", "<tool_call>")).toBe(1);
	});

	it("returns 0 for empty tag", () => {
		expect(partialSuffixOverlap("hello", "")).toBe(0);
	});
});

describe("partialSuffixOverlapAny", () => {
	it("returns 0 when no tags overlap", () => {
		expect(partialSuffixOverlapAny("hello", ["world", "foo"])).toBe(0);
	});

	it("returns maximum overlap across all tags", () => {
		expect(partialSuffixOverlapAny("hello <to", ["<tool_call>", "<tool"])).toBe(3);
	});

	it("returns 0 for empty tags array", () => {
		expect(partialSuffixOverlapAny("hello", [])).toBe(0);
	});

	it("returns overlap for single tag", () => {
		expect(partialSuffixOverlapAny("hello <to", ["<tool_call>"])).toBe(3);
	});
});

describe("normalizeKimiFunctionName", () => {
	it("returns last segment after dot", () => {
		expect(normalizeKimiFunctionName("module.submodule.function")).toBe("function");
	});

	it("returns part before colon", () => {
		expect(normalizeKimiFunctionName("function:arg1")).toBe("function");
	});

	it("handles colon and dot together", () => {
		expect(normalizeKimiFunctionName("module.function:arg")).toBe("function");
	});

	it("returns trimmed result", () => {
		expect(normalizeKimiFunctionName("  function  ")).toBe("function");
	});

	it("returns trimmed result with dots", () => {
		expect(normalizeKimiFunctionName("  module.function  ")).toBe("function");
	});

	it("returns empty string for empty input", () => {
		expect(normalizeKimiFunctionName("")).toBe("");
	});

	it("handles single name without dots or colons", () => {
		expect(normalizeKimiFunctionName("read")).toBe("read");
	});

	it("handles colon with no dot", () => {
		expect(normalizeKimiFunctionName("read:path")).toBe("read");
	});

	it("handles multiple colons (split takes first)", () => {
		expect(normalizeKimiFunctionName("read:path:extra")).toBe("read");
	});
});
