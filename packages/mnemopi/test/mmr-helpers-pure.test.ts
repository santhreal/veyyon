import { describe, expect, it } from "bun:test";
import { jaccardSimilarity, type MmrResult, mmrRerank } from "../src/core/mmr";

describe("jaccardSimilarity", () => {
	it("returns 1 for identical text", () => {
		expect(jaccardSimilarity("hello world", "hello world")).toBeCloseTo(1.0, 10);
	});
	it("returns 0 for disjoint text", () => {
		expect(jaccardSimilarity("hello", "foo")).toBeCloseTo(0.0, 10);
	});
	it("returns 0 for empty strings", () => {
		expect(jaccardSimilarity("", "")).toBe(0);
	});
	it("is case-insensitive", () => {
		expect(jaccardSimilarity("Hello", "hello")).toBeCloseTo(1.0, 10);
	});
});

describe("mmrRerank", () => {
	const makeResults = (items: Array<{ content: string; score: number }>): MmrResult[] =>
		items.map(item => ({ ...item }));

	it("returns empty array for topK=0", () => {
		expect(mmrRerank(makeResults([{ content: "a", score: 1 }]), 0.7, 0)).toEqual([]);
	});
	it("returns empty array for negative topK", () => {
		expect(mmrRerank(makeResults([{ content: "a", score: 1 }]), 0.7, -5)).toEqual([]);
	});
	it("returns single result as-is", () => {
		const results = makeResults([{ content: "hello", score: 1.0 }]);
		const reranked = mmrRerank(results, 0.7, 10);
		expect(reranked.length).toBe(1);
		expect(reranked[0]?.content).toBe("hello");
	});
	it("returns empty for empty input", () => {
		expect(mmrRerank([], 0.7, 10)).toEqual([]);
	});
	it("selects highest score first", () => {
		const results = makeResults([
			{ content: "low", score: 0.1 },
			{ content: "high", score: 0.9 },
			{ content: "mid", score: 0.5 },
		]);
		const reranked = mmrRerank(results, 0.7, 10);
		expect(reranked[0]?.content).toBe("high");
	});
	it("respects topK limit", () => {
		const results = makeResults([
			{ content: "a", score: 1.0 },
			{ content: "b", score: 0.8 },
			{ content: "c", score: 0.6 },
		]);
		const reranked = mmrRerank(results, 0.7, 2);
		expect(reranked.length).toBe(2);
	});
	it("promotes diverse results with low lambda", () => {
		const results = makeResults([
			{ content: "hello world foo", score: 0.9 },
			{ content: "hello world bar", score: 0.85 },
			{ content: "completely different text", score: 0.5 },
		]);
		// With low lambda, diversity matters more; the different text should be
		// promoted over the similar "hello world bar"
		const reranked = mmrRerank(results, 0.1, 3);
		expect(reranked.length).toBe(3);
		expect(reranked[0]?.content).toBe("hello world foo");
		// The diverse result should come before the similar one
		const diverseIdx = reranked.findIndex(r => r.content === "completely different text");
		const similarIdx = reranked.findIndex(r => r.content === "hello world bar");
		expect(diverseIdx).toBeLessThan(similarIdx);
	});
	it("promotes relevant results with high lambda", () => {
		const results = makeResults([
			{ content: "hello world foo", score: 0.9 },
			{ content: "hello world bar", score: 0.85 },
			{ content: "completely different text", score: 0.5 },
		]);
		const reranked = mmrRerank(results, 0.99, 3);
		// With high lambda, relevance dominates; "hello world bar" (score 0.85)
		// should come before "completely different text" (score 0.5)
		const similarIdx = reranked.findIndex(r => r.content === "hello world bar");
		const diverseIdx = reranked.findIndex(r => r.content === "completely different text");
		expect(similarIdx).toBeLessThan(diverseIdx);
	});
	it("handles results without score (defaults to 0)", () => {
		const results: MmrResult[] = [{ content: "no score" }, { content: "has score", score: 1.0 }];
		const reranked = mmrRerank(results, 0.7, 10);
		expect(reranked[0]?.content).toBe("has score");
	});
	it("handles results without content (defaults to empty string)", () => {
		const results: MmrResult[] = [{ score: 1.0 }, { content: "has content", score: 0.5 }];
		const reranked = mmrRerank(results, 0.7, 10);
		expect(reranked.length).toBe(2);
	});
	it("uses custom similarity function", () => {
		const customSim = (_a: string, _b: string): number => 0.5;
		const results = makeResults([
			{ content: "a", score: 0.9 },
			{ content: "b", score: 0.8 },
		]);
		const reranked = mmrRerank(results, 0.7, 2, customSim);
		expect(reranked.length).toBe(2);
		expect(reranked[0]?.content).toBe("a");
	});
	it("truncates topK to integer", () => {
		const results = makeResults([
			{ content: "a", score: 1.0 },
			{ content: "b", score: 0.8 },
		]);
		const reranked = mmrRerank(results, 0.7, 1.9);
		expect(reranked.length).toBe(1);
	});
	it("does not mutate input array", () => {
		const results = makeResults([
			{ content: "a", score: 1.0 },
			{ content: "b", score: 0.8 },
		]);
		const original = results.slice();
		mmrRerank(results, 0.7, 10);
		expect(results).toEqual(original);
	});
});
