import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jaccardIndex, jaccardWordSimilarity, overlapScore, wordSet } from "../src/util/text-similarity";

describe("jaccardIndex", () => {
	it("computes intersection over union", () => {
		expect(jaccardIndex(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
		expect(jaccardIndex(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
		expect(jaccardIndex(new Set(["a"]), new Set(["b", "c", "d"]))).toBe(0);
	});

	it("returns 0 when either set is empty", () => {
		expect(jaccardIndex(new Set(), new Set(["a"]))).toBe(0);
		expect(jaccardIndex(new Set(["a"]), new Set())).toBe(0);
		expect(jaccardIndex(new Set(), new Set())).toBe(0);
	});
});

describe("overlapScore", () => {
	it("divides the intersection by the larger set size", () => {
		expect(overlapScore(new Set(["a", "b", "c"]), new Set(["b", "c"]))).toBe(2 / 3);
		expect(overlapScore(new Set(["a"]), new Set(["a", "b", "c", "d"]))).toBe(0.25);
		expect(overlapScore(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
	});

	it("returns 0 when either set is empty", () => {
		expect(overlapScore(new Set(), new Set(["a"]))).toBe(0);
		expect(overlapScore(new Set(["a"]), new Set())).toBe(0);
	});
});

describe("wordSet", () => {
	it("lowercases, splits on whitespace, and drops empty and duplicate tokens", () => {
		expect([...wordSet("The  quick BROWN")].sort()).toEqual(["brown", "quick", "the"]);
		expect([...wordSet("hi hi hi")]).toEqual(["hi"]);
		expect(wordSet("   ").size).toBe(0);
		expect(wordSet("").size).toBe(0);
	});
});

describe("jaccardWordSimilarity", () => {
	it("compares two texts at the word level", () => {
		expect(jaccardWordSimilarity("the cat sat", "the dog sat")).toBe(0.5);
		expect(jaccardWordSimilarity("hello world", "hello world")).toBe(1);
		expect(jaccardWordSimilarity("alpha", "beta")).toBe(0);
		expect(jaccardWordSimilarity("", "anything")).toBe(0);
	});
});

describe("jaccard formula has one owner", () => {
	// ONE PLACE lock: the Jaccard denominator idiom `... - intersection)` must appear
	// only in text-similarity.ts. If a consumer re-hand-rolls the formula this fails.
	it("no consumer re-implements the set-jaccard formula inline", () => {
		const coreDir = join(import.meta.dir, "..", "src", "core");
		for (const file of ["mmr.ts", "episodic-graph.ts", "query-cache.ts"]) {
			const source = readFileSync(join(coreDir, file), "utf-8");
			expect(source).not.toContain("- intersection)");
		}
	});
});
