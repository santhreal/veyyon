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
		expect(jsonTypeOf(42n)).toBe("number");
	});

	it("returns 'boolean' for boolean", () => {
		expect(jsonTypeOf(true)).toBe("boolean");
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

	it("returns 'object' for function", () => {
		expect(jsonTypeOf(() => {})).toBe("object");
	});
});

describe("decodeValue", () => {
	it("returns trimmed empty string for whitespace-only input", () => {
		expect(decodeValue("   ")).toBe("");
	});

	it("parses valid JSON object", () => {
		expect(decodeValue('{"a":1}')).toEqual({ a: 1 });
	});

	it("parses valid JSON array", () => {
		expect(decodeValue("[1,2,3]")).toEqual([1, 2, 3]);
	});

	it("parses valid JSON number", () => {
		expect(decodeValue("42")).toBe(42);
	});

	it("parses valid JSON boolean", () => {
		expect(decodeValue("true")).toBe(true);
	});

	it("parses valid JSON null", () => {
		expect(decodeValue("null")).toBeNull();
	});

	it("returns raw string for invalid JSON", () => {
		expect(decodeValue("not json")).toBe("not json");
	});

	it("returns raw string for partial JSON", () => {
		expect(decodeValue('{"a":')).toBe('{"a":');
	});

	it("trims before parsing", () => {
		expect(decodeValue('  {"a":1}  ')).toEqual({ a: 1 });
	});
});

describe("coerceValue", () => {
	it("returns raw string for string-only schema", () => {
		expect(coerceValue("hello", { type: "string" })).toBe("hello");
	});

	it("decodes value for non-string schema", () => {
		expect(coerceValue('{"a":1}', { type: "object" })).toEqual({ a: 1 });
	});

	it("decodes value for unknown schema", () => {
		expect(coerceValue("42", undefined)).toBe(42);
	});

	it("returns raw for string schema with null union", () => {
		// null is deleted from types, leaving only string
		expect(coerceValue("hello", { type: ["string", "null"] })).toBe("hello");
	});
});

describe("isStringOnlySchema", () => {
	it("returns true for type: string", () => {
		expect(isStringOnlySchema({ type: "string" })).toBe(true);
	});

	it("returns true for type: ['string', 'null']", () => {
		expect(isStringOnlySchema({ type: ["string", "null"] })).toBe(true);
	});

	it("returns false for type: object", () => {
		expect(isStringOnlySchema({ type: "object" })).toBe(false);
	});

	it("returns false for type: number", () => {
		expect(isStringOnlySchema({ type: "number" })).toBe(false);
	});

	it("returns false for type: ['string', 'number']", () => {
		expect(isStringOnlySchema({ type: ["string", "number"] })).toBe(false);
	});

	it("returns false for undefined schema", () => {
		expect(isStringOnlySchema(undefined)).toBe(false);
	});

	it("returns false for null schema", () => {
		expect(isStringOnlySchema(null)).toBe(false);
	});

	it("returns true for enum with all string values", () => {
		expect(isStringOnlySchema({ enum: ["a", "b", "c"] })).toBe(true);
	});

	it("returns false for enum with mixed types", () => {
		expect(isStringOnlySchema({ enum: ["a", 1] })).toBe(false);
	});

	it("returns true for const string", () => {
		expect(isStringOnlySchema({ const: "fixed" })).toBe(true);
	});

	it("returns false for const number", () => {
		expect(isStringOnlySchema({ const: 42 })).toBe(false);
	});
});

describe("isArraySchema", () => {
	it("returns true for type: array", () => {
		expect(isArraySchema({ type: "array" })).toBe(true);
	});

	it("returns false for type: object", () => {
		expect(isArraySchema({ type: "object" })).toBe(false);
	});

	it("returns true for type: ['array', 'null']", () => {
		expect(isArraySchema({ type: ["array", "null"] })).toBe(true);
	});

	it("returns false for undefined", () => {
		expect(isArraySchema(undefined)).toBe(false);
	});
});

describe("isObjectSchema", () => {
	it("returns true for type: object", () => {
		expect(isObjectSchema({ type: "object" })).toBe(true);
	});

	it("returns false for type: array", () => {
		expect(isObjectSchema({ type: "array" })).toBe(false);
	});

	it("returns true for type: ['object', 'null']", () => {
		expect(isObjectSchema({ type: ["object", "null"] })).toBe(true);
	});

	it("returns false for undefined", () => {
		expect(isObjectSchema(undefined)).toBe(false);
	});
});

describe("getObjectProperties", () => {
	it("returns properties object when present", () => {
		const props = { a: { type: "string" } };
		expect(getObjectProperties({ properties: props })).toBe(props);
	});

	it("returns empty object for schema without properties", () => {
		expect(getObjectProperties({ type: "object" })).toEqual({});
	});

	it("returns empty object for non-record schema", () => {
		expect(getObjectProperties("string")).toEqual({});
	});

	it("returns empty object for null", () => {
		expect(getObjectProperties(null)).toEqual({});
	});

	it("returns empty object when properties is not a record", () => {
		expect(getObjectProperties({ properties: "not a record" })).toEqual({});
	});
});

describe("getArrayItemSchema", () => {
	it("returns items when present", () => {
		const items = { type: "string" };
		expect(getArrayItemSchema({ items })).toBe(items);
	});

	it("returns undefined for schema without items", () => {
		expect(getArrayItemSchema({ type: "array" })).toBeUndefined();
	});

	it("returns undefined for non-record schema", () => {
		expect(getArrayItemSchema("string")).toBeUndefined();
	});

	it("returns undefined for null", () => {
		expect(getArrayItemSchema(null)).toBeUndefined();
	});
});

describe("partialSuffixOverlap", () => {
	it("returns 0 when text does not overlap with tag prefix", () => {
		expect(partialSuffixOverlap("hello", "world")).toBe(0);
	});

	it("returns overlap length when text ends with tag prefix", () => {
		expect(partialSuffixOverlap("<too", "<tool_call>")).toBe(4);
	});

	it("returns 0 for empty text", () => {
		expect(partialSuffixOverlap("", "<tool_call>")).toBe(0);
	});

	it("returns 0 for empty tag", () => {
		expect(partialSuffixOverlap("hello", "")).toBe(0);
	});

	it("returns 0 when text is longer than tag", () => {
		expect(partialSuffixOverlap("this is a long text", "<tool")).toBe(0);
	});

	it("returns partial overlap for single character", () => {
		expect(partialSuffixOverlap("<", "<tool_call>")).toBe(1);
	});

	it("returns 0 for no overlap at all", () => {
		expect(partialSuffixOverlap("abc", "xyz")).toBe(0);
	});

	it("handles exact prefix match up to tag.length - 1", () => {
		expect(partialSuffixOverlap("<tool_call", "<tool_call>")).toBe(10);
	});

	it("returns 0 when text equals full tag (only partial prefixes match)", () => {
		// text = "<tool_call>" (11 chars), tag = "<tool_call>" (11 chars)
		// max = min(11, 10) = 10, tag.slice(0,10) = "<tool_call"
		// text.endsWith("<tool_call") = false (text ends with ">")
		expect(partialSuffixOverlap("<tool_call>", "<tool_call>")).toBe(0);
	});
});

describe("partialSuffixOverlapAny", () => {
	it("returns 0 for no overlap with any tag", () => {
		expect(partialSuffixOverlapAny("hello", ["world", "foo"])).toBe(0);
	});

	it("returns best overlap across multiple tags", () => {
		expect(partialSuffixOverlapAny("<too", ["<tool_call>", "<tool_result>"])).toBe(4);
	});

	it("returns 0 for empty tags array", () => {
		expect(partialSuffixOverlapAny("hello", [])).toBe(0);
	});
	it("returns max overlap when multiple tags match", () => {
		expect(partialSuffixOverlapAny("<tool_r", ["<tool", "<tool_result>"])).toBe(7);
	});
});

describe("normalizeKimiFunctionName", () => {
	it("returns last segment after dot", () => {
		expect(normalizeKimiFunctionName("module.submodule.function")).toBe("function");
	});

	it("returns name before colon", () => {
		expect(normalizeKimiFunctionName("function:123")).toBe("function");
	});

	it("handles dot and colon together", () => {
		expect(normalizeKimiFunctionName("module.function:123")).toBe("function");
	});

	it("returns trimmed result", () => {
		expect(normalizeKimiFunctionName("  function  ")).toBe("function");
	});

	it("returns trimmed last segment", () => {
		expect(normalizeKimiFunctionName("module.  function  ")).toBe("function");
	});

	it("handles single name", () => {
		expect(normalizeKimiFunctionName("function")).toBe("function");
	});

	it("handles empty string", () => {
		expect(normalizeKimiFunctionName("")).toBe("");
	});

	it("handles just a colon", () => {
		expect(normalizeKimiFunctionName(":123")).toBe("");
	});
});

describe("recordOrEmpty", () => {
	it("returns the value when it is a record", () => {
		const obj = { a: 1 };
		expect(recordOrEmpty(obj)).toBe(obj);
	});

	it("returns empty object for null", () => {
		expect(recordOrEmpty(null)).toEqual({});
	});

	it("returns empty object for undefined", () => {
		expect(recordOrEmpty(undefined)).toEqual({});
	});

	it("returns empty object for string", () => {
		expect(recordOrEmpty("string")).toEqual({});
	});

	it("returns empty object for number", () => {
		expect(recordOrEmpty(42)).toEqual({});
	});

	it("returns empty object for array", () => {
		expect(recordOrEmpty([1, 2])).toEqual({});
	});
});
