import { describe, expect, it } from "bun:test";
import { buildExactVectorIndex, searchExactVectorIndex } from "../src/core/vector-index";

describe("exact vector index", () => {
	it("normalizes vectors and returns nearest ids by cosine score", () => {
		const index = buildExactVectorIndex([
			{ id: "x", vector: [1, 0] },
			{ id: "y", vector: [0, 2] },
			{ id: "z", vector: [0, 0] },
		]);

		expect(index.count).toBe(2);
		expect(searchExactVectorIndex(index, [0, 3], 2)).toEqual([
			{ id: "y", score: 1 },
			{ id: "x", score: 0 },
		]);
	});

	it("returns no hits for invalid or empty queries", () => {
		const index = buildExactVectorIndex([{ id: 1, vector: [1, 0] }]);

		expect(searchExactVectorIndex(index, [], 10)).toEqual([]);
		expect(searchExactVectorIndex(index, [Number.NaN], 10)).toEqual([]);
		expect(searchExactVectorIndex(index, [1, 0], 0)).toEqual([]);
	});

	it("drops rows whose vectors contain non-finite values or are null/empty when building", () => {
		const index = buildExactVectorIndex([
			{ id: "ok", vector: [3, 4] },
			{ id: "nan", vector: [1, Number.NaN] },
			{ id: "inf", vector: [Number.POSITIVE_INFINITY, 0] },
			{ id: "null", vector: null },
			{ id: "empty", vector: [] },
			{ id: "zero", vector: [0, 0] },
		]);

		// Only the finite, non-zero vector survives; the rest are skipped at build.
		expect(index.count).toBe(1);
		const hits = searchExactVectorIndex(index, [3, 4], 10);
		expect(hits.map(hit => hit.id)).toEqual(["ok"]);
		// A unit vector against itself scores 1 within float32 rounding.
		expect(hits[0]?.score).toBeCloseTo(1, 6);
	});
});
