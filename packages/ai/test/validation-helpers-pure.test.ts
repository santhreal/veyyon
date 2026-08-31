import { describe, expect, it } from "bun:test";
import {
	BRACKET_CHARS,
	deleteValueAtPointer,
	getValueAtPointer,
	JSON_NUMBER_PATTERN,
	looksLikeJsonContainerString,
	MAX_HEAL_DISTANCE,
	MAX_NESTED_JSON_STRING_PARSE_DEPTH,
	NUMERIC_STRING_PATTERN,
	pathToPointer,
	setValueAtPointer,
	tryCoerceForExpectedTypes,
	tryParseJsonForTypes,
} from "../src/utils/validation-helpers";

describe("JSON_NUMBER_PATTERN", () => {
	it("matches integer", () => {
		expect(JSON_NUMBER_PATTERN.test("42")).toBe(true);
	});
	it("matches decimal", () => {
		expect(JSON_NUMBER_PATTERN.test("3.14")).toBe(true);
	});
	it("matches negative", () => {
		expect(JSON_NUMBER_PATTERN.test("-5")).toBe(true);
	});
	it("matches scientific notation", () => {
		expect(JSON_NUMBER_PATTERN.test("1e10")).toBe(true);
	});
	it("matches + prefix", () => {
		expect(JSON_NUMBER_PATTERN.test("+5")).toBe(true);
	});
	it("does not match empty string", () => {
		expect(JSON_NUMBER_PATTERN.test("")).toBe(false);
	});
	it("does not match text", () => {
		expect(JSON_NUMBER_PATTERN.test("hello")).toBe(false);
	});
	it("does not match leading zeros", () => {
		expect(JSON_NUMBER_PATTERN.test("01")).toBe(false);
	});
	it("matches zero", () => {
		expect(JSON_NUMBER_PATTERN.test("0")).toBe(true);
	});
});

describe("NUMERIC_STRING_PATTERN", () => {
	it("matches integer", () => {
		expect(NUMERIC_STRING_PATTERN.test("42")).toBe(true);
	});
	it("matches decimal", () => {
		expect(NUMERIC_STRING_PATTERN.test("3.14")).toBe(true);
	});
	it("does not match text", () => {
		expect(NUMERIC_STRING_PATTERN.test("hello")).toBe(false);
	});
});

describe("MAX_HEAL_DISTANCE", () => {
	it("is 3", () => {
		expect(MAX_HEAL_DISTANCE).toBe(3);
	});
});

describe("BRACKET_CHARS", () => {
	it("contains [, ], {, }", () => {
		expect(BRACKET_CHARS).toEqual(["[", "]", "{", "}"]);
	});
});

describe("MAX_NESTED_JSON_STRING_PARSE_DEPTH", () => {
	it("is 3", () => {
		expect(MAX_NESTED_JSON_STRING_PARSE_DEPTH).toBe(3);
	});
});

describe("pathToPointer", () => {
	it("returns empty string for empty path", () => {
		expect(pathToPointer([])).toBe("");
	});
	it("returns single segment pointer", () => {
		expect(pathToPointer(["foo"])).toBe("/foo");
	});
	it("joins multiple segments", () => {
		expect(pathToPointer(["foo", "bar"])).toBe("/foo/bar");
	});
	it("escapes ~ in segment", () => {
		expect(pathToPointer(["a~b"])).toBe("/a~0b");
	});
	it("escapes / in segment", () => {
		expect(pathToPointer(["a/b"])).toBe("/a~1b");
	});
	it("handles numeric segments", () => {
		expect(pathToPointer(["items", 0])).toBe("/items/0");
	});
});

describe("getValueAtPointer", () => {
	it("returns root for empty pointer", () => {
		expect(getValueAtPointer({ a: 1 }, "")).toEqual({ a: 1 });
	});
	it("returns value at simple path", () => {
		expect(getValueAtPointer({ a: 1 }, "/a")).toBe(1);
	});
	it("returns value at nested path", () => {
		expect(getValueAtPointer({ a: { b: 2 } }, "/a/b")).toBe(2);
	});
	it("returns undefined for missing path", () => {
		expect(getValueAtPointer({ a: 1 }, "/b")).toBeUndefined();
	});
	it("returns undefined for null root", () => {
		expect(getValueAtPointer(null, "/a")).toBeUndefined();
	});
	it("navigates array indices", () => {
		expect(getValueAtPointer([10, 20, 30], "/1")).toBe(20);
	});
	it("returns undefined for non-integer array index", () => {
		expect(getValueAtPointer([10, 20], "/abc")).toBeUndefined();
	});
	it("handles escaped ~1 in pointer", () => {
		expect(getValueAtPointer({ "a/b": 1 }, "/a~1b")).toBe(1);
	});
	it("handles escaped ~0 in pointer", () => {
		expect(getValueAtPointer({ "a~b": 1 }, "/a~0b")).toBe(1);
	});
});

describe("setValueAtPointer", () => {
	it("returns value when pointer is empty", () => {
		expect(setValueAtPointer({ a: 1 }, "", 99)).toBe(99);
	});
	it("sets value at simple path", () => {
		const root = { a: 1 };
		const result = setValueAtPointer(root, "/a", 99);
		expect((result as { a: number }).a).toBe(99);
	});
	it("sets value at nested path", () => {
		const root = { a: { b: 2 } };
		const result = setValueAtPointer(root, "/a/b", 99);
		expect((result as { a: { b: number } }).a.b).toBe(99);
	});
	it("sets value at array index", () => {
		const root = [1, 2, 3];
		const result = setValueAtPointer(root, "/1", 99);
		expect((result as number[])[1]).toBe(99);
	});
	it("returns root unchanged for null root", () => {
		expect(setValueAtPointer(null, "/a", 1)).toBeNull();
	});
});

describe("deleteValueAtPointer", () => {
	it("returns root for empty pointer", () => {
		expect(deleteValueAtPointer({ a: 1 }, "")).toEqual({ a: 1 });
	});
	it("deletes value at simple path", () => {
		const root = { a: 1, b: 2 };
		const result = deleteValueAtPointer(root, "/a");
		expect("a" in (result as object)).toBe(false);
		expect((result as { b: number }).b).toBe(2);
	});
	it("returns root for missing path", () => {
		const root = { a: 1 };
		expect(deleteValueAtPointer(root, "/b")).toEqual({ a: 1 });
	});
});

describe("looksLikeJsonContainerString", () => {
	it("returns true for object-like string", () => {
		expect(looksLikeJsonContainerString('{"a":1}')).toBe(true);
	});
	it("returns true for array-like string", () => {
		expect(looksLikeJsonContainerString("[1,2,3]")).toBe(true);
	});
	it("returns false for plain string", () => {
		expect(looksLikeJsonContainerString("hello")).toBe(false);
	});
	it("returns false for number string", () => {
		expect(looksLikeJsonContainerString("42")).toBe(false);
	});
});

describe("tryCoerceForExpectedTypes", () => {
	it("returns unchanged for number value with string type", () => {
		const result = tryCoerceForExpectedTypes(42, ["string"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe("42");
	});
	it("coerces string 'true' to boolean true", () => {
		const result = tryCoerceForExpectedTypes("true", ["boolean"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(true);
	});
	it("coerces string 'false' to boolean false", () => {
		const result = tryCoerceForExpectedTypes("false", ["boolean"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(false);
	});
	it("coerces JSON string to object", () => {
		const result = tryCoerceForExpectedTypes('{"a":1}', ["object"]);
		expect(result.changed).toBe(true);
		expect(result.value).toEqual({ a: 1 });
	});
	it("coerces JSON string to array", () => {
		const result = tryCoerceForExpectedTypes("[1,2,3]", ["array"]);
		expect(result.changed).toBe(true);
		expect(result.value).toEqual([1, 2, 3]);
	});
	it("coerces numeric string to number", () => {
		const result = tryCoerceForExpectedTypes("42", ["number", "integer"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(42);
	});
	it("returns unchanged for non-matching coercion", () => {
		const result = tryCoerceForExpectedTypes("hello", ["number"]);
		expect(result.changed).toBe(false);
	});
	it("coerces boolean true to number 1", () => {
		const result = tryCoerceForExpectedTypes(true, ["number", "integer"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(1);
	});
	it("coerces boolean false to number 0", () => {
		const result = tryCoerceForExpectedTypes(false, ["number", "integer"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(0);
	});
});

describe("tryParseJsonForTypes", () => {
	it("parses JSON object string for object type", () => {
		const result = tryParseJsonForTypes('{"a":1}', ["object"]);
		expect(result.changed).toBe(true);
		expect(result.value).toEqual({ a: 1 });
	});
	it("parses JSON array string for array type", () => {
		const result = tryParseJsonForTypes("[1,2]", ["array"]);
		expect(result.changed).toBe(true);
		expect(result.value).toEqual([1, 2]);
	});
	it("parses number string for number type", () => {
		const result = tryParseJsonForTypes("42", ["number"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(42);
	});
	it("parses true literal for boolean type", () => {
		const result = tryParseJsonForTypes("true", ["boolean"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBe(true);
	});
	it("returns unchanged for empty string", () => {
		const result = tryParseJsonForTypes("", ["object"]);
		expect(result.changed).toBe(false);
	});
	it("returns unchanged for whitespace-only string", () => {
		const result = tryParseJsonForTypes("   ", ["object"]);
		expect(result.changed).toBe(false);
	});
	it("returns unchanged for non-JSON string", () => {
		const result = tryParseJsonForTypes("hello", ["object"]);
		expect(result.changed).toBe(false);
	});
	it("parses null literal for null type", () => {
		const result = tryParseJsonForTypes("null", ["null"]);
		expect(result.changed).toBe(true);
		expect(result.value).toBeNull();
	});
});
