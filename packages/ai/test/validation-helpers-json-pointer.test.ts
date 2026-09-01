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
} from "../src/utils/validation-helpers";

describe("JSON_NUMBER_PATTERN", () => {
	it("matches integer", () => {
		expect(JSON_NUMBER_PATTERN.test("42")).toBe(true);
	});
	it("matches negative integer", () => {
		expect(JSON_NUMBER_PATTERN.test("-42")).toBe(true);
	});
	it("matches decimal", () => {
		expect(JSON_NUMBER_PATTERN.test("3.14")).toBe(true);
	});
	it("matches exponent", () => {
		expect(JSON_NUMBER_PATTERN.test("1e10")).toBe(true);
		expect(JSON_NUMBER_PATTERN.test("1.5e-3")).toBe(true);
	});
	it("matches zero", () => {
		expect(JSON_NUMBER_PATTERN.test("0")).toBe(true);
	});
	it("does not match leading zeros", () => {
		expect(JSON_NUMBER_PATTERN.test("01")).toBe(false);
	});
	it("does not match empty string", () => {
		expect(JSON_NUMBER_PATTERN.test("")).toBe(false);
	});
	it("does not match non-numeric", () => {
		expect(JSON_NUMBER_PATTERN.test("abc")).toBe(false);
	});
});

describe("NUMERIC_STRING_PATTERN", () => {
	it("matches integer", () => {
		expect(NUMERIC_STRING_PATTERN.test("42")).toBe(true);
	});
	it("matches negative integer", () => {
		expect(NUMERIC_STRING_PATTERN.test("-42")).toBe(true);
	});
	it("matches decimal", () => {
		expect(NUMERIC_STRING_PATTERN.test("3.14")).toBe(true);
	});
	it("matches exponent", () => {
		expect(NUMERIC_STRING_PATTERN.test("1e10")).toBe(true);
	});
});

describe("constants", () => {
	it("MAX_HEAL_DISTANCE is 3", () => {
		expect(MAX_HEAL_DISTANCE).toBe(3);
	});
	it("BRACKET_CHARS contains [ ] { }", () => {
		expect(BRACKET_CHARS).toEqual(["[", "]", "{", "}"]);
	});
	it("MAX_NESTED_JSON_STRING_PARSE_DEPTH is 3", () => {
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
	it("returns multi-segment pointer", () => {
		expect(pathToPointer(["foo", "bar", "baz"])).toBe("/foo/bar/baz");
	});
	it("escapes ~ as ~0", () => {
		expect(pathToPointer(["a~b"])).toBe("/a~0b");
	});
	it("escapes / as ~1", () => {
		expect(pathToPointer(["a/b"])).toBe("/a~1b");
	});
	it("escapes both ~ and /", () => {
		expect(pathToPointer(["a~/b"])).toBe("/a~0~1b");
	});
	it("handles numeric segments", () => {
		expect(pathToPointer([0, 1, 2])).toBe("/0/1/2");
	});
});

describe("getValueAtPointer", () => {
	it("returns root for empty pointer", () => {
		const root = { foo: "bar" };
		expect(getValueAtPointer(root, "")).toBe(root);
	});
	it("returns value at single segment", () => {
		expect(getValueAtPointer({ foo: "bar" }, "/foo")).toBe("bar");
	});
	it("returns value at nested path", () => {
		expect(getValueAtPointer({ a: { b: { c: 42 } } }, "/a/b/c")).toBe(42);
	});
	it("returns undefined for missing key", () => {
		expect(getValueAtPointer({ foo: "bar" }, "/baz")).toBeUndefined();
	});
	it("returns undefined for null intermediate", () => {
		expect(getValueAtPointer({ a: null }, "/a/b")).toBeUndefined();
	});
	it("returns undefined for undefined intermediate", () => {
		expect(getValueAtPointer({ a: undefined }, "/a/b")).toBeUndefined();
	});
	it("navigates array by index", () => {
		expect(getValueAtPointer([10, 20, 30], "/1")).toBe(20);
	});
	it("navigates nested array", () => {
		expect(getValueAtPointer({ arr: [{ x: 1 }, { x: 2 }] }, "/arr/1/x")).toBe(2);
	});
	it("returns undefined for non-integer array index", () => {
		expect(getValueAtPointer([1, 2, 3], "/foo")).toBeUndefined();
	});
	it("returns undefined for non-object intermediate", () => {
		expect(getValueAtPointer("string", "/foo")).toBeUndefined();
	});
	it("decodes ~0 as ~", () => {
		expect(getValueAtPointer({ "a~b": 42 }, "/a~0b")).toBe(42);
	});
	it("decodes ~1 as /", () => {
		expect(getValueAtPointer({ "a/b": 42 }, "/a~1b")).toBe(42);
	});
});

describe("setValueAtPointer", () => {
	it("returns value for empty pointer", () => {
		expect(setValueAtPointer({ foo: "bar" }, "", 42)).toBe(42);
	});
	it("sets value at single segment", () => {
		const root = { foo: "bar" };
		const result = setValueAtPointer(root, "/foo", "baz");
		expect(result).toBe(root);
		expect(root.foo).toBe("baz");
	});
	it("sets value at nested path", () => {
		const root = { a: { b: { c: 1 } } };
		const result = setValueAtPointer(root, "/a/b/c", 42);
		expect(result).toBe(root);
		expect(root.a.b.c).toBe(42);
	});
	it("sets value in array", () => {
		const root = [1, 2, 3];
		const result = setValueAtPointer(root, "/1", 42);
		expect(result).toBe(root);
		expect(root[1]).toBe(42);
	});
	it("returns root when intermediate is null", () => {
		const root = { a: null };
		const result = setValueAtPointer(root, "/a/b", 42);
		expect(result).toBe(root);
	});
	it("returns root when intermediate is non-object", () => {
		const root = { a: "string" };
		const result = setValueAtPointer(root, "/a/b", 42);
		expect(result).toBe(root);
	});
});

describe("deleteValueAtPointer", () => {
	it("returns root for empty pointer", () => {
		const root = { foo: "bar" };
		expect(deleteValueAtPointer(root, "")).toBe(root);
	});
	it("deletes single key", () => {
		const root = { foo: "bar", baz: "qux" };
		const result = deleteValueAtPointer(root, "/foo");
		expect(result).toEqual({ baz: "qux" });
	});
	it("deletes nested key", () => {
		const root = { a: { b: { c: 1, d: 2 } } };
		const result = deleteValueAtPointer(root, "/a/b/c");
		expect(result).toEqual({ a: { b: { d: 2 } } });
	});
	it("deletes array element by index", () => {
		const root = [1, 2, 3];
		const result = deleteValueAtPointer(root, "/1");
		expect(result).toEqual([1, 3]);
	});
	it("returns root when key does not exist", () => {
		const root = { foo: "bar" };
		const result = deleteValueAtPointer(root, "/baz");
		expect(result).toBe(root);
	});
	it("returns root for non-object", () => {
		expect(deleteValueAtPointer("string", "/foo")).toBe("string");
	});
	it("preserves original root when deleting (immutability)", () => {
		const root = { foo: "bar", baz: "qux" };
		deleteValueAtPointer(root, "/foo");
		expect(root.foo).toBe("bar");
	});
});

describe("looksLikeJsonContainerString", () => {
	it("returns false for non-string", () => {
		expect(looksLikeJsonContainerString(42)).toBe(false);
		expect(looksLikeJsonContainerString(null)).toBe(false);
		expect(looksLikeJsonContainerString(undefined)).toBe(false);
	});
	it("returns false for plain string", () => {
		expect(looksLikeJsonContainerString("hello")).toBe(false);
	});
	it("returns true for empty object", () => {
		expect(looksLikeJsonContainerString("{}")).toBe(true);
	});
	it("returns true for object with key", () => {
		expect(looksLikeJsonContainerString('{"key": "value"}')).toBe(true);
	});
	it("returns true for object with colon", () => {
		expect(looksLikeJsonContainerString("{ something: else }")).toBe(true);
	});
	it("returns true for empty array", () => {
		expect(looksLikeJsonContainerString("[]")).toBe(true);
	});
	it("returns true for array with string", () => {
		expect(looksLikeJsonContainerString('["hello"]')).toBe(true);
	});
	it("returns true for array with number", () => {
		expect(looksLikeJsonContainerString("[42]")).toBe(true);
	});
	it("returns true for array with nested array", () => {
		expect(looksLikeJsonContainerString("[[1, 2]]")).toBe(true);
	});
	it("returns true for array with nested object", () => {
		expect(looksLikeJsonContainerString('[{"a": 1}]')).toBe(true);
	});
	it("returns true for array with true", () => {
		expect(looksLikeJsonContainerString("[true]")).toBe(true);
	});
	it("returns true for array with false", () => {
		expect(looksLikeJsonContainerString("[false]")).toBe(true);
	});
	it("returns true for array with null", () => {
		expect(looksLikeJsonContainerString("[null]")).toBe(true);
	});
	it("returns false for string starting with { but no JSON structure", () => {
		expect(looksLikeJsonContainerString("{not json")).toBe(false);
	});
	it("returns false for string starting with [ but no JSON content", () => {
		expect(looksLikeJsonContainerString("[not json")).toBe(false);
	});
	it("trims leading whitespace", () => {
		expect(looksLikeJsonContainerString('  {"key": "value"}')).toBe(true);
	});
});
