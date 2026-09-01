import { describe, expect, it } from "bun:test";
import { damerauLevenshteinDistance, levenshteinDistance, nearestNames } from "../src/levenshtein";
import { clamp, clamp01, clampLow } from "../src/math";

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshteinDistance("hello", "hello")).toBe(0);
	});
	it("returns length of b for empty a", () => {
		expect(levenshteinDistance("", "hello")).toBe(5);
	});
	it("returns length of a for empty b", () => {
		expect(levenshteinDistance("hello", "")).toBe(5);
	});
	it("returns 0 for both empty", () => {
		expect(levenshteinDistance("", "")).toBe(0);
	});
	it("returns 1 for single substitution", () => {
		expect(levenshteinDistance("cat", "bat")).toBe(1);
	});
	it("returns 1 for single insertion", () => {
		expect(levenshteinDistance("cat", "cats")).toBe(1);
	});
	it("returns 1 for single deletion", () => {
		expect(levenshteinDistance("cats", "cat")).toBe(1);
	});
	it("computes multi-edit distance", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
	});
	it("computes distance for completely different strings", () => {
		expect(levenshteinDistance("abc", "xyz")).toBe(3);
	});
	it("handles case sensitivity", () => {
		expect(levenshteinDistance("Hello", "hello")).toBe(1);
	});
});

describe("damerauLevenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(damerauLevenshteinDistance("hello", "hello")).toBe(0);
	});
	it("returns length for empty a", () => {
		expect(damerauLevenshteinDistance("", "test")).toBe(4);
	});
	it("returns length for empty b", () => {
		expect(damerauLevenshteinDistance("test", "")).toBe(4);
	});
	it("returns 0 for both empty", () => {
		expect(damerauLevenshteinDistance("", "")).toBe(0);
	});
	it("returns 1 for single substitution", () => {
		expect(damerauLevenshteinDistance("cat", "bat")).toBe(1);
	});
	it("returns 1 for single insertion", () => {
		expect(damerauLevenshteinDistance("cat", "cats")).toBe(1);
	});
	it("returns 1 for transposition", () => {
		expect(damerauLevenshteinDistance("ca", "ac")).toBe(1);
	});
	it("returns 2 for non-adjacent transposition", () => {
		expect(damerauLevenshteinDistance("abc", "cba")).toBe(2);
	});
	it("computes multi-edit distance", () => {
		expect(damerauLevenshteinDistance("kitten", "sitting")).toBe(3);
	});
});

describe("nearestNames", () => {
	it("returns empty array for empty needle", () => {
		expect(nearestNames("", ["foo", "bar"])).toEqual([]);
	});
	it("returns empty array for whitespace-only needle", () => {
		expect(nearestNames("   ", ["foo", "bar"])).toEqual([]);
	});
	it("returns exact match first", () => {
		expect(nearestNames("foo", ["foo", "bar"])).toContain("foo");
	});
	it("returns case-insensitive exact match", () => {
		expect(nearestNames("FOO", ["foo", "bar"])).toContain("foo");
	});
	it("returns substring matches", () => {
		expect(nearestNames("oo", ["foo", "bar"])).toContain("foo");
	});
	it("returns fuzzy matches within budget", () => {
		expect(nearestNames("fooo", ["foo", "bar"])).toContain("foo");
	});
	it("respects limit parameter", () => {
		const result = nearestNames("a", ["a", "ab", "ac", "ad", "ae", "af"], 3);
		expect(result.length).toBeLessThanOrEqual(3);
	});
	it("deduplicates results", () => {
		const result = nearestNames("foo", ["foo", "foo", "foo"]);
		expect(result).toEqual(["foo"]);
	});
	it("returns empty array when no matches", () => {
		expect(nearestNames("xyz", ["foo", "bar"])).toEqual([]);
	});
	it("handles empty candidates", () => {
		expect(nearestNames("foo", [])).toEqual([]);
	});
});

describe("clamp", () => {
	it("returns value when within range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});
	it("returns min when below range", () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});
	it("returns max when above range", () => {
		expect(clamp(15, 0, 10)).toBe(10);
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
		expect(clamp(-15, -10, -5)).toBe(-10);
	});
	it("returns value at boundary", () => {
		expect(clamp(0, 0, 10)).toBe(0);
		expect(clamp(10, 0, 10)).toBe(10);
	});
});

describe("clamp01", () => {
	it("returns value when within 0-1", () => {
		expect(clamp01(0.5)).toBe(0.5);
	});
	it("returns 0 for negative", () => {
		expect(clamp01(-1)).toBe(0);
	});
	it("returns 1 for above 1", () => {
		expect(clamp01(2)).toBe(1);
	});
	it("returns 0 for NaN", () => {
		expect(clamp01(Number.NaN)).toBe(0);
	});
	it("handles 0 boundary", () => {
		expect(clamp01(0)).toBe(0);
	});
	it("handles 1 boundary", () => {
		expect(clamp01(1)).toBe(1);
	});
});

describe("clampLow", () => {
	it("returns value when within range", () => {
		expect(clampLow(5, 0, 10)).toBe(5);
	});
	it("returns low when below low", () => {
		expect(clampLow(-5, 0, 10)).toBe(0);
	});
	it("returns high when above high", () => {
		expect(clampLow(15, 0, 10)).toBe(10);
	});
	it("returns low for NaN", () => {
		expect(clampLow(Number.NaN, 0, 10)).toBe(0);
	});
	it("returns low for Infinity", () => {
		expect(clampLow(Number.POSITIVE_INFINITY, 0, 10)).toBe(0);
	});
	it("handles equal low and high", () => {
		expect(clampLow(5, 3, 3)).toBe(3);
	});
	it("returns value at boundaries", () => {
		expect(clampLow(0, 0, 10)).toBe(0);
		expect(clampLow(10, 0, 10)).toBe(10);
	});
});
