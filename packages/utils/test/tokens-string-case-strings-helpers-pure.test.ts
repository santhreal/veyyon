import { describe, expect, it } from "bun:test";
import { kebabToCamel, titleCaseSentence, titleCaseWords } from "../src/string-case";
import { firstNonEmpty, nonEmptyTrimmed } from "../src/strings";
import { estimateTokensFromText } from "../src/tokens";

describe("estimateTokensFromText", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokensFromText("")).toBe(0);
	});
	it("returns ~1 token for short text", () => {
		// "hello" = 5 bytes, (5+3)>>2 = 2
		expect(estimateTokensFromText("hello")).toBe(2);
	});
	it("increases with longer text", () => {
		const short = estimateTokensFromText("hello");
		const long = estimateTokensFromText("hello ".repeat(100));
		expect(long).toBeGreaterThan(short);
	});
	it("is byte-aware for non-ASCII", () => {
		// "héllo" = 6 bytes (é is 2 bytes), (6+3)>>2 = 2
		expect(estimateTokensFromText("héllo")).toBe(2);
	});
	it("handles CJK text (3 bytes per char)", () => {
		// "日本語" = 9 bytes, (9+3)>>2 = 3
		expect(estimateTokensFromText("日本語")).toBe(3);
	});
	it("is deterministic", () => {
		expect(estimateTokensFromText("hello world")).toBe(estimateTokensFromText("hello world"));
	});
	it("handles single character", () => {
		// "a" = 1 byte, (1+3)>>2 = 1
		expect(estimateTokensFromText("a")).toBe(1);
	});
	it("handles 4-byte emoji", () => {
		// "😀" = 4 bytes, (4+3)>>2 = 1
		expect(estimateTokensFromText("😀")).toBe(1);
	});
});

describe("kebabToCamel", () => {
	it("converts kebab-case to camelCase", () => {
		expect(kebabToCamel("thinking-level")).toBe("thinkingLevel");
	});
	it("converts multi-word kebab-case", () => {
		expect(kebabToCamel("my-cool-variable")).toBe("myCoolVariable");
	});
	it("returns unchanged when no hyphen", () => {
		expect(kebabToCamel("hello")).toBe("hello");
	});
	it("only lifts lowercase after hyphen", () => {
		// "utf-8" stays "utf-8" because 8 is not [a-z]
		expect(kebabToCamel("utf-8")).toBe("utf-8");
	});
	it("does not lift uppercase after hyphen", () => {
		expect(kebabToCamel("X-Header")).toBe("X-Header");
	});
	it("handles leading hyphen", () => {
		expect(kebabToCamel("-foo")).toBe("Foo");
	});
	it("handles multiple consecutive hyphens", () => {
		// "a--b" -> regex matches -b, so result is "a-B" (first hyphen stays)
		expect(kebabToCamel("a--b")).toBe("a-B");
	});
	it("handles empty string", () => {
		expect(kebabToCamel("")).toBe("");
	});
});

describe("titleCaseWords", () => {
	it("capitalizes each word", () => {
		expect(titleCaseWords("hello world")).toBe("Hello World");
	});
	it("handles single word", () => {
		expect(titleCaseWords("hello")).toBe("Hello");
	});
	it("handles empty string", () => {
		expect(titleCaseWords("")).toBe("");
	});
	it("handles whitespace-only string", () => {
		expect(titleCaseWords("   ")).toBe("");
	});
	it("handles multiple spaces", () => {
		expect(titleCaseWords("hello   world")).toBe("Hello World");
	});
	it("preserves already-capitalized words", () => {
		expect(titleCaseWords("Hello World")).toBe("Hello World");
	});
	it("handles mixed case", () => {
		expect(titleCaseWords("hELLO wORLD")).toBe("HELLO WORLD");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes first letter only", () => {
		expect(titleCaseSentence("hello world")).toBe("Hello world");
	});
	it("handles empty string", () => {
		expect(titleCaseSentence("")).toBe("");
	});
	it("handles whitespace-only string", () => {
		expect(titleCaseSentence("   ")).toBe("");
	});
	it("trims leading whitespace", () => {
		expect(titleCaseSentence("  hello")).toBe("Hello");
	});
	it("preserves acronyms", () => {
		expect(titleCaseSentence("JSON is great")).toBe("JSON is great");
	});
	it("handles single character", () => {
		expect(titleCaseSentence("a")).toBe("A");
	});
	it("handles already capitalized", () => {
		expect(titleCaseSentence("Hello")).toBe("Hello");
	});
});

describe("firstNonEmpty", () => {
	it("returns first non-empty value", () => {
		expect(firstNonEmpty("a", "b", "c")).toBe("a");
	});
	it("skips empty strings", () => {
		expect(firstNonEmpty("", "b", "c")).toBe("b");
	});
	it("skips whitespace-only strings", () => {
		expect(firstNonEmpty("  ", "b")).toBe("b");
	});
	it("skips undefined", () => {
		expect(firstNonEmpty(undefined, "b")).toBe("b");
	});
	it("skips null", () => {
		expect(firstNonEmpty(null, "b")).toBe("b");
	});
	it("returns null when all empty", () => {
		expect(firstNonEmpty("", "  ", undefined, null)).toBeNull();
	});
	it("returns null for no arguments", () => {
		expect(firstNonEmpty()).toBeNull();
	});
	it("trims the returned value", () => {
		expect(firstNonEmpty("  hello  ")).toBe("hello");
	});
	it("handles 0 as non-empty string", () => {
		expect(firstNonEmpty("0")).toBe("0");
	});
});

describe("nonEmptyTrimmed", () => {
	it("filters out empty strings", () => {
		expect(nonEmptyTrimmed(["a", "", "b"])).toEqual(["a", "b"]);
	});
	it("filters out whitespace-only strings", () => {
		expect(nonEmptyTrimmed(["a", "  ", "b"])).toEqual(["a", "b"]);
	});
	it("filters out undefined and null", () => {
		expect(nonEmptyTrimmed(["a", undefined, null, "b"])).toEqual(["a", "b"]);
	});
	it("trims each value", () => {
		expect(nonEmptyTrimmed(["  a  ", "  b  "])).toEqual(["a", "b"]);
	});
	it("returns empty array for all empty", () => {
		expect(nonEmptyTrimmed(["", "  ", undefined])).toEqual([]);
	});
	it("returns empty array for empty input", () => {
		expect(nonEmptyTrimmed([])).toEqual([]);
	});
	it("keeps duplicates", () => {
		expect(nonEmptyTrimmed(["a", "a", "b"])).toEqual(["a", "a", "b"]);
	});
	it("handles iterable input", () => {
		expect(nonEmptyTrimmed(new Set(["a", "", "b"]))).toEqual(["a", "b"]);
	});
	it("handles '0' as non-empty", () => {
		expect(nonEmptyTrimmed(["0", ""])).toEqual(["0"]);
	});
});
