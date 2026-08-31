import { describe, expect, it } from "bun:test";
import {
	fuzzyMatch,
	isSubsequenceMatch,
	normalizeForSearch,
	prepareQuery,
	subsequenceScore,
} from "../src/fuzzy-helpers";

describe("normalizeForSearch", () => {
	it("lowercases simple text", () => {
		expect(normalizeForSearch("Hello")).toBe("hello");
	});
	it("splits camelCase", () => {
		expect(normalizeForSearch("helloWorld")).toBe("hello world");
	});
	it("splits PascalCase", () => {
		expect(normalizeForSearch("HelloWorld")).toBe("hello world");
	});
	it("splits ALLCAPS followed by lowercase", () => {
		expect(normalizeForSearch("HTTPRequest")).toBe("http request");
	});
	it("replaces non-alphanumeric with spaces", () => {
		expect(normalizeForSearch("hello-world_test")).toBe("hello world test");
	});
	it("trims leading/trailing whitespace", () => {
		expect(normalizeForSearch("  hello  ")).toBe("hello");
	});
	it("collapses multiple spaces", () => {
		expect(normalizeForSearch("hello   world")).toBe("hello world");
	});
	it("handles empty string", () => {
		expect(normalizeForSearch("")).toBe("");
	});
	it("handles numbers", () => {
		expect(normalizeForSearch("test123")).toBe("test123");
	});
	it("handles unicode letters", () => {
		expect(normalizeForSearch("café")).toBe("café");
	});
	it("handles special characters", () => {
		expect(normalizeForSearch("hello@world!")).toBe("hello world");
	});
	it("handles underscores", () => {
		expect(normalizeForSearch("hello_world")).toBe("hello world");
	});
});

describe("prepareQuery", () => {
	it("returns null for empty query", () => {
		expect(prepareQuery("")).toBeNull();
	});
	it("returns null for whitespace-only query", () => {
		expect(prepareQuery("   ")).toBeNull();
	});
	it("returns prepared query with normalized, tokens, and compact", () => {
		const pq = prepareQuery("hello world");
		expect(pq).not.toBeNull();
		expect(pq!.normalized).toBe("hello world");
		expect(pq!.tokens).toEqual(["hello", "world"]);
		expect(pq!.compact).toBe("helloworld");
	});
	it("handles single word", () => {
		const pq = prepareQuery("hello");
		expect(pq!.tokens).toEqual(["hello"]);
		expect(pq!.compact).toBe("hello");
	});
	it("normalizes camelCase in query", () => {
		const pq = prepareQuery("helloWorld");
		expect(pq!.normalized).toBe("hello world");
		expect(pq!.tokens).toEqual(["hello", "world"]);
	});
});

describe("isSubsequenceMatch", () => {
	it("returns true for empty query", () => {
		expect(isSubsequenceMatch("", "target")).toBe(true);
	});
	it("returns true for exact match", () => {
		expect(isSubsequenceMatch("abc", "abc")).toBe(true);
	});
	it("returns true for subsequence", () => {
		expect(isSubsequenceMatch("ac", "abc")).toBe(true);
	});
	it("returns true for scattered subsequence", () => {
		expect(isSubsequenceMatch("ace", "abcde")).toBe(true);
	});
	it("returns false when query longer than target", () => {
		expect(isSubsequenceMatch("abcd", "abc")).toBe(false);
	});
	it("returns false when characters not in order", () => {
		expect(isSubsequenceMatch("ba", "abc")).toBe(false);
	});
	it("returns false for non-matching characters", () => {
		expect(isSubsequenceMatch("xyz", "abc")).toBe(false);
	});
	it("handles single character query", () => {
		expect(isSubsequenceMatch("a", "abc")).toBe(true);
		expect(isSubsequenceMatch("d", "abc")).toBe(false);
	});
	it("handles empty target", () => {
		expect(isSubsequenceMatch("", "")).toBe(true);
		expect(isSubsequenceMatch("a", "")).toBe(false);
	});
	it("handles repeated characters", () => {
		expect(isSubsequenceMatch("aa", "aaa")).toBe(true);
		expect(isSubsequenceMatch("aaa", "aa")).toBe(false);
	});
});

describe("subsequenceScore", () => {
	it("returns 1 for empty query", () => {
		expect(subsequenceScore("", "target")).toBe(1);
	});
	it("returns 100 for exact match", () => {
		expect(subsequenceScore("abc", "abc")).toBe(100);
	});
	it("returns 80 for prefix match", () => {
		expect(subsequenceScore("ab", "abc")).toBe(80);
	});
	it("returns 60 for substring match", () => {
		expect(subsequenceScore("bc", "abc")).toBe(60);
	});
	it("returns 0 for non-matching", () => {
		expect(subsequenceScore("xyz", "abc")).toBe(0);
	});
	it("returns positive score for subsequence with gaps", () => {
		const score = subsequenceScore("ac", "abc");
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(60);
	});
	it("returns lower score for more gaps", () => {
		const fewGaps = subsequenceScore("ac", "abc");
		const moreGaps = subsequenceScore("af", "abcdef");
		expect(moreGaps).toBeLessThanOrEqual(fewGaps);
	});
	it("handles empty target with empty query", () => {
		expect(subsequenceScore("", "")).toBe(1);
	});
});

describe("fuzzyMatch", () => {
	it("returns match with score 0 for empty query", () => {
		const result = fuzzyMatch("", "hello world");
		expect(result.matches).toBe(true);
		expect(result.score).toBe(0);
	});
	it("returns match for exact text", () => {
		const result = fuzzyMatch("hello", "hello");
		expect(result.matches).toBe(true);
	});
	it("returns match for partial query", () => {
		const result = fuzzyMatch("hel", "hello");
		expect(result.matches).toBe(true);
	});
	it("returns no match for non-existent text", () => {
		const result = fuzzyMatch("xyz", "hello");
		expect(result.matches).toBe(false);
	});
	it("returns match for multi-word query", () => {
		const result = fuzzyMatch("hello world", "hello world");
		expect(result.matches).toBe(true);
	});
	it("returns no match for empty text", () => {
		const result = fuzzyMatch("hello", "");
		expect(result.matches).toBe(false);
	});
	it("returns match for whitespace-only query", () => {
		const result = fuzzyMatch("   ", "hello");
		expect(result.matches).toBe(true);
		expect(result.score).toBe(0);
	});
});
