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
	it("returns 'boolean' for true", () => {
		expect(jsonTypeOf(true)).toBe("boolean");
	});
	it("returns 'boolean' for false", () => {
		expect(jsonTypeOf(false)).toBe("boolean");
	});
	it("returns 'string' for string", () => {
		expect(jsonTypeOf("hello")).toBe("string");
	});
	it("returns 'object' for array", () => {
		expect(jsonTypeOf([1, 2])).toBe("object");
	});
	it("returns 'object' for plain object", () => {
		expect(jsonTypeOf({ a: 1 })).toBe("object");
	});
	it("returns 'object' for undefined", () => {
		expect(jsonTypeOf(undefined)).toBe("object");
	});
});

describe("decodeValue", () => {
	it("decodes JSON object string", () => {
		expect(decodeValue('{"a":1}')).toEqual({ a: 1 });
	});
	it("decodes JSON array string", () => {
		expect(decodeValue("[1,2,3]")).toEqual([1, 2, 3]);
	});
	it("decodes JSON number string", () => {
		expect(decodeValue("42")).toBe(42);
	});
	it("decodes JSON boolean string", () => {
		expect(decodeValue("true")).toBe(true);
	});
	it("returns string for non-JSON text", () => {
		expect(decodeValue("hello")).toBe("hello");
	});
	it("decodes JSON null string", () => {
		expect(decodeValue("null")).toBeNull();
	});
});

describe("coerceValue", () => {
	it("returns raw string for string-only schema", () => {
		expect(coerceValue("hello", { type: "string" })).toBe("hello");
	});
	it("decodes JSON for non-string schema", () => {
		expect(coerceValue('{"a":1}', { type: "object" })).toEqual({ a: 1 });
	});
	it("returns raw for string-only schema even if JSON-like", () => {
		expect(coerceValue('{"a":1}', { type: "string" })).toBe('{"a":1}');
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
});

describe("isArraySchema", () => {
	it("returns true for type: array", () => {
		expect(isArraySchema({ type: "array" })).toBe(true);
	});
	it("returns false for type: object", () => {
		expect(isArraySchema({ type: "object" })).toBe(false);
	});
});

describe("isObjectSchema", () => {
	it("returns true for type: object", () => {
		expect(isObjectSchema({ type: "object" })).toBe(true);
	});
	it("returns false for type: array", () => {
		expect(isObjectSchema({ type: "array" })).toBe(false);
	});
});

describe("getObjectProperties", () => {
	it("returns properties from schema", () => {
		const props = { a: { type: "string" }, b: { type: "number" } };
		expect(getObjectProperties({ properties: props })).toEqual(props);
	});
	it("returns empty object for missing properties", () => {
		expect(getObjectProperties({})).toEqual({});
	});
	it("returns empty object for non-record schema", () => {
		expect(getObjectProperties("hello")).toEqual({});
	});
});

describe("getArrayItemSchema", () => {
	it("returns items from schema", () => {
		const items = { type: "string" };
		expect(getArrayItemSchema({ items })).toBe(items);
	});
	it("returns undefined for missing items", () => {
		expect(getArrayItemSchema({})).toBeUndefined();
	});
	it("returns undefined for non-record schema", () => {
		expect(getArrayItemSchema("hello")).toBeUndefined();
	});
});

describe("partialSuffixOverlap", () => {
	it("returns 0 for no overlap", () => {
		expect(partialSuffixOverlap("hello", "world")).toBe(0);
	});
	it("returns overlap length for partial tag at end", () => {
		expect(partialSuffixOverlap("hello<thi", "<think>")).toBe(4);
	});
	it("returns 0 for exact match (excluded)", () => {
		expect(partialSuffixOverlap("hello<think>", "<think>")).toBe(0);
	});
	it("returns 0 for empty text", () => {
		expect(partialSuffixOverlap("", "<think>")).toBe(0);
	});
	it("returns 1 for single char overlap", () => {
		expect(partialSuffixOverlap("hello<", "<think>")).toBe(1);
	});
});

describe("partialSuffixOverlapAny", () => {
	it("returns 0 for no overlap with any tag", () => {
		expect(partialSuffixOverlapAny("hello", ["<think>", "</think>"])).toBe(0);
	});
	it("returns max overlap across tags", () => {
		expect(partialSuffixOverlapAny("hello<thi", ["<think>", "</think>"])).toBe(4);
	});
	it("returns overlap for second tag", () => {
		expect(partialSuffixOverlapAny("hello</thi", ["<think>", "</think>"])).toBe(5);
	});
});

describe("normalizeKimiFunctionName", () => {
	it("returns simple name unchanged", () => {
		expect(normalizeKimiFunctionName("getWeather")).toBe("getWeather");
	});
	it("strips namespace prefix with dot", () => {
		expect(normalizeKimiFunctionName("tools.getWeather")).toBe("getWeather");
	});
	it("strips colon suffix", () => {
		expect(normalizeKimiFunctionName("getWeather:extra")).toBe("getWeather");
	});
	it("strips both dot and colon", () => {
		expect(normalizeKimiFunctionName("ns.getWeather:extra")).toBe("getWeather");
	});
	it("handles empty string", () => {
		expect(normalizeKimiFunctionName("")).toBe("");
	});
	it("trims whitespace", () => {
		expect(normalizeKimiFunctionName("  getWeather  ")).toBe("getWeather");
	});
	it("handles multiple dots", () => {
		expect(normalizeKimiFunctionName("a.b.getWeather")).toBe("getWeather");
	});
});

describe("recordOrEmpty", () => {
	it("returns record for object", () => {
		const obj = { a: 1 };
		expect(recordOrEmpty(obj)).toBe(obj);
	});
	it("returns empty object for null", () => {
		expect(recordOrEmpty(null)).toEqual({});
	});
	it("returns empty object for string", () => {
		expect(recordOrEmpty("hello")).toEqual({});
	});
	it("returns empty object for array", () => {
		expect(recordOrEmpty([1, 2])).toEqual({});
	});
	it("returns empty object for undefined", () => {
		expect(recordOrEmpty(undefined)).toEqual({});
	});
});
