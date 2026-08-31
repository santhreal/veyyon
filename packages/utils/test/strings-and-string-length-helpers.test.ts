import { describe, expect, it } from "bun:test";
import { codePointLength, isWellFormedUtf16, utf8ByteLength } from "../src/string-length";
import { firstNonEmpty, nonEmptyTrimmed } from "../src/strings";

describe("firstNonEmpty", () => {
	it("returns first non-empty value", () => {
		expect(firstNonEmpty("", "  ", "hello", "world")).toBe("hello");
	});
	it("returns null when all empty", () => {
		expect(firstNonEmpty("", "  ", undefined, null)).toBeNull();
	});
	it("returns null when no arguments", () => {
		expect(firstNonEmpty()).toBeNull();
	});
	it("returns first value when it is non-empty", () => {
		expect(firstNonEmpty("first", "second")).toBe("first");
	});
	it("trims returned value", () => {
		expect(firstNonEmpty("  hello  ")).toBe("hello");
	});
	it("skips undefined values", () => {
		expect(firstNonEmpty(undefined, undefined, "found")).toBe("found");
	});
	it("skips null values", () => {
		expect(firstNonEmpty(null, null, "found")).toBe("found");
	});
	it("returns null for all undefined", () => {
		expect(firstNonEmpty(undefined, undefined)).toBeNull();
	});
});

describe("nonEmptyTrimmed", () => {
	it("returns empty array for empty input", () => {
		expect(nonEmptyTrimmed([])).toEqual([]);
	});
	it("filters out empty strings", () => {
		expect(nonEmptyTrimmed(["", "hello", ""])).toEqual(["hello"]);
	});
	it("trims each value", () => {
		expect(nonEmptyTrimmed(["  a  ", "  b  "])).toEqual(["a", "b"]);
	});
	it("filters out whitespace-only strings", () => {
		expect(nonEmptyTrimmed(["   ", "hello", "  "])).toEqual(["hello"]);
	});
	it("filters out undefined values", () => {
		expect(nonEmptyTrimmed([undefined, "hello", undefined])).toEqual(["hello"]);
	});
	it("filters out null values", () => {
		expect(nonEmptyTrimmed([null, "hello", null])).toEqual(["hello"]);
	});
	it("handles all empty input", () => {
		expect(nonEmptyTrimmed(["", "  ", undefined, null])).toEqual([]);
	});
	it("preserves order", () => {
		expect(nonEmptyTrimmed(["c", "a", "b"])).toEqual(["c", "a", "b"]);
	});
});

describe("codePointLength", () => {
	it("returns 0 for empty string", () => {
		expect(codePointLength("")).toBe(0);
	});
	it("returns length for ASCII string", () => {
		expect(codePointLength("hello")).toBe(5);
	});
	it("counts surrogate pairs as single code point", () => {
		expect(codePointLength("a\uD83D\uDE00b")).toBe(3);
	});
	it("counts multi-byte CJK as single code point", () => {
		expect(codePointLength("你好")).toBe(2);
	});
	it("counts emoji as single code point", () => {
		expect(codePointLength("🎉")).toBe(1);
	});
	it("handles mixed content", () => {
		expect(codePointLength("a🎉b你好c")).toBe(6);
	});
	it("handles string with only ASCII", () => {
		expect(codePointLength("abcdef")).toBe(6);
	});
});

describe("utf8ByteLength", () => {
	it("returns 0 for empty string", () => {
		expect(utf8ByteLength("")).toBe(0);
	});
	it("returns 1 byte per ASCII character", () => {
		expect(utf8ByteLength("hello")).toBe(5);
	});
	it("returns 2 bytes for Latin-1 supplement", () => {
		expect(utf8ByteLength("é")).toBe(2);
	});
	it("returns 3 bytes for CJK characters", () => {
		expect(utf8ByteLength("你好")).toBe(6);
	});
	it("returns 4 bytes for emoji", () => {
		expect(utf8ByteLength("🎉")).toBe(4);
	});
	it("handles mixed content", () => {
		// a(1) + emoji(4) + b(1) = 6
		expect(utf8ByteLength("a🎉b")).toBe(6);
	});
	it("respects start parameter", () => {
		expect(utf8ByteLength("hello", 2)).toBe(3);
	});
	it("respects end parameter", () => {
		expect(utf8ByteLength("hello", 0, 3)).toBe(3);
	});
	it("handles lone high surrogate", () => {
		expect(utf8ByteLength("\uD83D")).toBe(3);
	});
	it("handles lone low surrogate", () => {
		expect(utf8ByteLength("\uDE00")).toBe(3);
	});
});

describe("isWellFormedUtf16", () => {
	it("returns true for empty string", () => {
		expect(isWellFormedUtf16("")).toBe(true);
	});
	it("returns true for ASCII string", () => {
		expect(isWellFormedUtf16("hello")).toBe(true);
	});
	it("returns true for properly paired surrogates", () => {
		expect(isWellFormedUtf16("a\uD83D\uDE00b")).toBe(true);
	});
	it("returns false for lone high surrogate", () => {
		expect(isWellFormedUtf16("\uD83D")).toBe(false);
	});
	it("returns false for lone low surrogate", () => {
		expect(isWellFormedUtf16("\uDE00")).toBe(false);
	});
	it("returns false for high surrogate followed by non-low", () => {
		expect(isWellFormedUtf16("\uD83Da")).toBe(false);
	});
	it("returns true for CJK characters", () => {
		expect(isWellFormedUtf16("你好")).toBe(true);
	});
	it("returns true for mixed content with valid pairs", () => {
		expect(isWellFormedUtf16("hello\uD83D\uDE00world")).toBe(true);
	});
	it("returns false for high surrogate at end of string", () => {
		expect(isWellFormedUtf16("hello\uD83D")).toBe(false);
	});
});
