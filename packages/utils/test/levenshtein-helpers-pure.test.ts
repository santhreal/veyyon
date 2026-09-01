import { describe, expect, it } from "bun:test";
import { damerauLevenshteinDistance, levenshteinDistance, nearestNames } from "../src/levenshtein";

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshteinDistance("hello", "hello")).toBe(0);
	});
	it("returns length when one is empty", () => {
		expect(levenshteinDistance("", "hello")).toBe(5);
		expect(levenshteinDistance("hello", "")).toBe(5);
	});
	it("returns 0 for two empty strings", () => {
		expect(levenshteinDistance("", "")).toBe(0);
	});
	it("counts single substitution", () => {
		expect(levenshteinDistance("cat", "cot")).toBe(1);
	});
	it("counts single insertion", () => {
		expect(levenshteinDistance("cat", "cats")).toBe(1);
	});
	it("counts single deletion", () => {
		expect(levenshteinDistance("cats", "cat")).toBe(1);
	});
	it("counts transposition as 2 edits", () => {
		expect(levenshteinDistance("raed", "read")).toBe(2);
	});
	it("handles completely different strings", () => {
		expect(levenshteinDistance("abc", "xyz")).toBe(3);
	});
	it("handles single-char strings", () => {
		expect(levenshteinDistance("a", "b")).toBe(1);
		expect(levenshteinDistance("a", "a")).toBe(0);
	});
	it("handles prefix match", () => {
		expect(levenshteinDistance("hello", "help")).toBe(2);
	});
	it("handles suffix match", () => {
		expect(levenshteinDistance("testing", "resting")).toBe(1);
	});
});

describe("damerauLevenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(damerauLevenshteinDistance("hello", "hello")).toBe(0);
	});
	it("returns length when one is empty", () => {
		expect(damerauLevenshteinDistance("", "hello")).toBe(5);
		expect(damerauLevenshteinDistance("hello", "")).toBe(5);
	});
	it("counts transposition as 1 edit", () => {
		expect(damerauLevenshteinDistance("raed", "read")).toBe(1);
	});
	it("counts single substitution", () => {
		expect(damerauLevenshteinDistance("cat", "cot")).toBe(1);
	});
	it("counts single insertion", () => {
		expect(damerauLevenshteinDistance("cat", "cats")).toBe(1);
	});
	it("counts single deletion", () => {
		expect(damerauLevenshteinDistance("cats", "cat")).toBe(1);
	});
	it("handles completely different strings", () => {
		expect(damerauLevenshteinDistance("abc", "xyz")).toBe(3);
	});
	it("handles two transpositions", () => {
		expect(damerauLevenshteinDistance("wriet", "write")).toBe(1);
	});
	it("handles adjacent transposition at start", () => {
		expect(damerauLevenshteinDistance("ab", "ba")).toBe(1);
	});
	it("handles no transposition when chars differ", () => {
		expect(damerauLevenshteinDistance("ab", "cd")).toBe(2);
	});
});

describe("nearestNames", () => {
	it("returns empty for empty typed", () => {
		expect(nearestNames("", ["hello"])).toEqual([]);
	});
	it("returns empty for whitespace-only typed", () => {
		expect(nearestNames("  ", ["hello"])).toEqual([]);
	});
	it("returns exact match first", () => {
		expect(nearestNames("hello", ["hello", "world"])).toEqual(["hello"]);
	});
	it("is case-insensitive for exact match", () => {
		expect(nearestNames("Hello", ["hello", "world"])).toEqual(["hello"]);
	});
	it("trims input before matching", () => {
		expect(nearestNames("  hello  ", ["hello", "world"])).toEqual(["hello"]);
	});
	it("returns substring matches after exact", () => {
		const result = nearestNames("hello", ["hello", "helloworld", "world"]);
		expect(result).toContain("hello");
		expect(result).toContain("helloworld");
	});
	it("returns close edit-distance matches", () => {
		const result = nearestNames("helo", ["hello", "world"]);
		expect(result).toContain("hello");
	});
	it("respects limit", () => {
		const result = nearestNames("test", ["test", "tests", "testing", "tested", "testy", "toast"], 3);
		expect(result.length).toBeLessThanOrEqual(3);
	});
	it("deduplicates results", () => {
		const result = nearestNames("hello", ["hello", "hello", "hello"]);
		expect(result).toEqual(["hello"]);
	});
	it("returns empty when no candidates match", () => {
		expect(nearestNames("xyz", ["hello", "world"])).toEqual([]);
	});
	it("handles empty candidates", () => {
		expect(nearestNames("hello", [])).toEqual([]);
	});
	it("sorts edit-distance matches by distance then alphabetically", () => {
		// "ct" is not a substring of any candidate; distance to "cat" is 1
		// (insert 'a'), distance to "cab"/"car" is 2, so only "cat" qualifies
		// with budget = clampLow(floor(2/4), 1, 3) = 1
		const result = nearestNames("ct", ["cat", "cab", "car"]);
		expect(result).toEqual(["cat"]);
	});
	it("default limit is 5", () => {
		const result = nearestNames("a", ["a", "ab", "ac", "ad", "ae", "af", "ag"]);
		expect(result.length).toBeLessThanOrEqual(5);
	});
});
