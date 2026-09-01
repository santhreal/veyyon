import { describe, expect, it } from "bun:test";
import { jaccardIndex, jaccardWordSimilarity, overlapScore, wordSet } from "../src/util/text-similarity";

describe("wordSet", () => {
	it("splits text into lowercased word set", () => {
		expect(wordSet("Hello World")).toEqual(new Set(["hello", "world"]));
	});
	it("handles empty string", () => {
		expect(wordSet("")).toEqual(new Set());
	});
	it("handles whitespace-only string", () => {
		expect(wordSet("   ")).toEqual(new Set());
	});
	it("deduplicates repeated words", () => {
		expect(wordSet("hello hello world")).toEqual(new Set(["hello", "world"]));
	});
	it("lowercases all words", () => {
		const result = wordSet("ABC abc Abc");
		expect(result).toEqual(new Set(["abc"]));
	});
	it("handles tabs and newlines", () => {
		expect(wordSet("hello\tworld\nfoo")).toEqual(new Set(["hello", "world", "foo"]));
	});
});

describe("jaccardIndex", () => {
	it("returns 0 when either set is empty", () => {
		expect(jaccardIndex(new Set(), new Set(["a"]))).toBe(0);
		expect(jaccardIndex(new Set(["a"]), new Set())).toBe(0);
	});
	it("returns 0 when both sets are empty", () => {
		expect(jaccardIndex(new Set(), new Set())).toBe(0);
	});
	it("returns 1 for identical sets", () => {
		expect(jaccardIndex(new Set(["a", "b"]), new Set(["a", "b"]))).toBeCloseTo(1.0, 10);
	});
	it("returns 0 for disjoint sets", () => {
		expect(jaccardIndex(new Set(["a"]), new Set(["b"]))).toBeCloseTo(0.0, 10);
	});
	it("returns 0.5 for half-overlapping sets", () => {
		// |{a,b} ∩ {a,c}| / |{a,b,c}| = 1/3
		const result = jaccardIndex(new Set(["a", "b"]), new Set(["a", "c"]));
		expect(result).toBeCloseTo(1 / 3, 10);
	});
	it("returns correct value for subset", () => {
		// |{a} ∩ {a,b}| / |{a,b}| = 1/2
		expect(jaccardIndex(new Set(["a"]), new Set(["a", "b"]))).toBeCloseTo(0.5, 10);
	});
});

describe("overlapScore", () => {
	it("returns 0 when either set is empty", () => {
		expect(overlapScore(new Set(), new Set(["a"]))).toBe(0);
		expect(overlapScore(new Set(["a"]), new Set())).toBe(0);
	});
	it("returns 1 for identical sets", () => {
		expect(overlapScore(new Set(["a", "b"]), new Set(["a", "b"]))).toBeCloseTo(1.0, 10);
	});
	it("returns 0 for disjoint sets", () => {
		expect(overlapScore(new Set(["a"]), new Set(["b"]))).toBeCloseTo(0.0, 10);
	});
	it("divides by max size (stricter than overlap coefficient)", () => {
		// |{a} ∩ {a,b}| / max(1,2) = 1/2
		expect(overlapScore(new Set(["a"]), new Set(["a", "b"]))).toBeCloseTo(0.5, 10);
	});
	it("returns correct value for partial overlap", () => {
		// |{a,b,c} ∩ {a,b,d}| / max(3,3) = 2/3
		expect(overlapScore(new Set(["a", "b", "c"]), new Set(["a", "b", "d"]))).toBeCloseTo(2 / 3, 10);
	});
});

describe("jaccardWordSimilarity", () => {
	it("returns 1 for identical text", () => {
		expect(jaccardWordSimilarity("hello world", "hello world")).toBeCloseTo(1.0, 10);
	});
	it("returns 0 for completely different text", () => {
		expect(jaccardWordSimilarity("hello world", "foo bar")).toBeCloseTo(0.0, 10);
	});
	it("returns 0 for empty strings", () => {
		expect(jaccardWordSimilarity("", "")).toBe(0);
	});
	it("is case-insensitive", () => {
		expect(jaccardWordSimilarity("Hello World", "hello world")).toBeCloseTo(1.0, 10);
	});
	it("handles partial word overlap", () => {
		// |{hello,world} ∩ {hello,foo}| / |{hello,world,foo}| = 1/3
		expect(jaccardWordSimilarity("hello world", "hello foo")).toBeCloseTo(1 / 3, 10);
	});
	it("handles repeated words (set dedup)", () => {
		expect(jaccardWordSimilarity("hello hello", "hello")).toBeCloseTo(1.0, 10);
	});
});
