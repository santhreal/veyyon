import { describe, expect, it } from "bun:test";
import { clamp, clamp01, clampLow } from "../src/math";
import { kebabToCamel, titleCaseSentence, titleCaseWords } from "../src/string-case";
import { firstNonEmpty, nonEmptyTrimmed } from "../src/strings";

describe("firstNonEmpty", () => {
	it("returns first non-empty value", () => {
		expect(firstNonEmpty("hello", "world")).toBe("hello");
	});
	it("skips empty string", () => {
		expect(firstNonEmpty("", "world")).toBe("world");
	});
	it("skips whitespace-only string", () => {
		expect(firstNonEmpty("  ", "world")).toBe("world");
	});
	it("skips undefined", () => {
		expect(firstNonEmpty(undefined, "world")).toBe("world");
	});
	it("skips null", () => {
		expect(firstNonEmpty(null, "world")).toBe("world");
	});
	it("returns null when all empty", () => {
		expect(firstNonEmpty("", "  ", undefined, null)).toBeNull();
	});
	it("returns null for no args", () => {
		expect(firstNonEmpty()).toBeNull();
	});
	it("trims the returned value", () => {
		expect(firstNonEmpty("  hello  ")).toBe("hello");
	});
	it("returns trimmed first non-empty", () => {
		expect(firstNonEmpty("  ", "  world  ")).toBe("world");
	});
});

describe("nonEmptyTrimmed", () => {
	it("filters empty strings", () => {
		expect(nonEmptyTrimmed(["a", "", "b"])).toEqual(["a", "b"]);
	});
	it("filters whitespace-only strings", () => {
		expect(nonEmptyTrimmed(["a", "  ", "b"])).toEqual(["a", "b"]);
	});
	it("filters undefined", () => {
		expect(nonEmptyTrimmed(["a", undefined, "b"])).toEqual(["a", "b"]);
	});
	it("filters null", () => {
		expect(nonEmptyTrimmed(["a", null, "b"])).toEqual(["a", "b"]);
	});
	it("trims each value", () => {
		expect(nonEmptyTrimmed(["  a  ", "  b  "])).toEqual(["a", "b"]);
	});
	it("keeps duplicates", () => {
		expect(nonEmptyTrimmed(["a", "a", "b"])).toEqual(["a", "a", "b"]);
	});
	it("returns empty array for all empty", () => {
		expect(nonEmptyTrimmed(["", "  ", undefined])).toEqual([]);
	});
	it("returns empty array for empty input", () => {
		expect(nonEmptyTrimmed([])).toEqual([]);
	});
	it("preserves order", () => {
		expect(nonEmptyTrimmed(["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});
});

describe("clamp", () => {
	it("returns value when in range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});
	it("returns min when below range", () => {
		expect(clamp(-1, 0, 10)).toBe(0);
	});
	it("returns max when above range", () => {
		expect(clamp(11, 0, 10)).toBe(10);
	});
	it("returns min for NaN", () => {
		expect(clamp(Number.NaN, 0, 10)).toBe(0);
	});
	it("returns min for Infinity", () => {
		expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
	});
	it("returns min for -Infinity", () => {
		expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
	});
	it("handles negative range", () => {
		expect(clamp(-5, -10, -1)).toBe(-5);
	});
	it("handles value at boundaries", () => {
		expect(clamp(0, 0, 10)).toBe(0);
		expect(clamp(10, 0, 10)).toBe(10);
	});
});

describe("clamp01", () => {
	it("returns value when in [0,1]", () => {
		expect(clamp01(0.5)).toBe(0.5);
	});
	it("returns 0 when below 0", () => {
		expect(clamp01(-0.1)).toBe(0);
	});
	it("returns 1 when above 1", () => {
		expect(clamp01(1.1)).toBe(1);
	});
	it("returns 0 for NaN", () => {
		expect(clamp01(Number.NaN)).toBe(0);
	});
	it("returns 0 for Infinity", () => {
		expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
	});
	it("handles 0 and 1 boundaries", () => {
		expect(clamp01(0)).toBe(0);
		expect(clamp01(1)).toBe(1);
	});
});

describe("clampLow", () => {
	it("returns value when in range", () => {
		expect(clampLow(5, 0, 10)).toBe(5);
	});
	it("returns low when below range", () => {
		expect(clampLow(-1, 0, 10)).toBe(0);
	});
	it("returns high when above range", () => {
		expect(clampLow(11, 0, 10)).toBe(10);
	});
	it("returns low for NaN", () => {
		expect(clampLow(Number.NaN, 0, 10)).toBe(0);
	});
	it("returns low for Infinity", () => {
		expect(clampLow(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
	});
	it("returns low when range is empty (high < low)", () => {
		expect(clampLow(5, 0, -1)).toBe(0);
	});
	it("handles empty list index (low=0, high=-1)", () => {
		expect(clampLow(0, 0, -1)).toBe(0);
	});
});

describe("kebabToCamel", () => {
	it("converts simple kebab-case", () => {
		expect(kebabToCamel("thinking-level")).toBe("thinkingLevel");
	});
	it("returns unchanged when no hyphen", () => {
		expect(kebabToCamel("hello")).toBe("hello");
	});
	it("converts multiple hyphens", () => {
		expect(kebabToCamel("foo-bar-baz")).toBe("fooBarBaz");
	});
	it("does not lift uppercase after hyphen", () => {
		expect(kebabToCamel("X-Header")).toBe("X-Header");
	});
	it("does not lift digit after hyphen", () => {
		expect(kebabToCamel("utf-8")).toBe("utf-8");
	});
	it("handles empty string", () => {
		expect(kebabToCamel("")).toBe("");
	});
	it("handles trailing hyphen", () => {
		expect(kebabToCamel("foo-")).toBe("foo-");
	});
	it("handles leading hyphen (lifts first letter)", () => {
		expect(kebabToCamel("-foo")).toBe("Foo");
	});
});

describe("titleCaseWords", () => {
	it("capitalizes each word", () => {
		expect(titleCaseWords("hello world")).toBe("Hello World");
	});
	it("handles single word", () => {
		expect(titleCaseWords("hello")).toBe("Hello");
	});
	it("handles multiple spaces", () => {
		expect(titleCaseWords("hello   world")).toBe("Hello World");
	});
	it("handles empty string", () => {
		expect(titleCaseWords("")).toBe("");
	});
	it("handles whitespace-only string", () => {
		expect(titleCaseWords("   ")).toBe("");
	});
	it("preserves rest of word after first char", () => {
		expect(titleCaseWords("hELLO")).toBe("HELLO");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes first letter", () => {
		expect(titleCaseSentence("hello world")).toBe("Hello world");
	});
	it("trims leading whitespace", () => {
		expect(titleCaseSentence("  hello")).toBe("Hello");
	});
	it("trims trailing whitespace", () => {
		expect(titleCaseSentence("hello  ")).toBe("Hello");
	});
	it("returns empty for empty string", () => {
		expect(titleCaseSentence("")).toBe("");
	});
	it("returns empty for whitespace-only", () => {
		expect(titleCaseSentence("   ")).toBe("");
	});
	it("preserves acronyms", () => {
		expect(titleCaseSentence("XML parser")).toBe("XML parser");
	});
	it("handles single char", () => {
		expect(titleCaseSentence("a")).toBe("A");
	});
});
