import { describe, expect, it } from "bun:test";
import { cosineScorer, cosineSimilarity, decodeEmbeddingJson, encodeEmbeddingJson } from "../src/core/vector-math";

// vector-math owns the single stored-embedding wire format. These tests pin the exact
// contract every persisted-embedding read path now shares (beam decodeVector, shmr
// parseEmbeddingJson, query-cache load): non-empty JSON array of finite numbers or null.

describe("embedding JSON codec", () => {
	it("round-trips an embedding through encode and decode", () => {
		const embedding = [1.5, -2, 0, 3.25, -0.125];
		const decoded = decodeEmbeddingJson(encodeEmbeddingJson(embedding));
		expect(decoded).toEqual(embedding);
	});

	it("decodes a valid blob to the exact numbers", () => {
		expect(decodeEmbeddingJson("[0.1,-0.2,3]")).toEqual([0.1, -0.2, 3]);
		expect(decodeEmbeddingJson("[-0.5,0,0.5]")).toEqual([-0.5, 0, 0.5]);
	});

	it("preserves single-element and large vectors", () => {
		expect(decodeEmbeddingJson("[42]")).toEqual([42]);
		const big = Array.from({ length: 384 }, (_, i) => (i - 192) / 100);
		expect(decodeEmbeddingJson(encodeEmbeddingJson(big))).toEqual(big);
	});

	it("rejects non-string input", () => {
		expect(decodeEmbeddingJson(null)).toBeNull();
		expect(decodeEmbeddingJson(undefined)).toBeNull();
		expect(decodeEmbeddingJson(42)).toBeNull();
		expect(decodeEmbeddingJson([1, 2, 3])).toBeNull();
		expect(decodeEmbeddingJson({})).toBeNull();
	});

	it("rejects an empty string and non-JSON text", () => {
		expect(decodeEmbeddingJson("")).toBeNull();
		expect(decodeEmbeddingJson("not json")).toBeNull();
		expect(decodeEmbeddingJson("[1,2,")).toBeNull();
	});

	it("rejects JSON that is not an array", () => {
		expect(decodeEmbeddingJson("null")).toBeNull();
		expect(decodeEmbeddingJson("{}")).toBeNull();
		expect(decodeEmbeddingJson("42")).toBeNull();
		expect(decodeEmbeddingJson('"hi"')).toBeNull();
	});

	it("rejects an empty array (an empty embedding is never valid)", () => {
		expect(decodeEmbeddingJson("[]")).toBeNull();
	});

	it("rejects an array holding a non-number element", () => {
		expect(decodeEmbeddingJson('[1,"2",3]')).toBeNull();
		expect(decodeEmbeddingJson("[1,null,2]")).toBeNull();
		expect(decodeEmbeddingJson("[1,true]")).toBeNull();
		expect(decodeEmbeddingJson("[1,[2]]")).toBeNull();
	});

	it("rejects a non-finite element (Infinity from an out-of-range literal, NaN token)", () => {
		expect(decodeEmbeddingJson("[1,1e999]")).toBeNull();
		expect(decodeEmbeddingJson("[1,NaN]")).toBeNull();
	});

	it("rejects a numeric string element rather than coercing it", () => {
		// Tightening over the pre-unification shmr parser, which coerced "1.5" -> 1.5.
		// Real embeddings are written as JSON numbers, so a string element signals a
		// corrupt row and decodes to null instead of a silently coerced value.
		expect(decodeEmbeddingJson('["1.5"]')).toBeNull();
	});
});

describe("cosine scorer", () => {
	// Deterministic pseudo-random generator (no Math.random) so the differential
	// sweep is reproducible.
	function lcg(seed: number): () => number {
		let state = seed >>> 0;
		return () => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 0x100000000;
		};
	}

	function randomVector(next: () => number, length: number): number[] {
		return Array.from({ length }, () => next() * 4 - 2);
	}

	it("is byte-identical to cosineSimilarity across a random sweep", () => {
		const next = lcg(0x9e3779b9);
		for (let trial = 0; trial < 200; trial += 1) {
			const dim = 1 + Math.trunc(next() * 16);
			const query = randomVector(next, dim);
			const score = cosineScorer(query);
			for (let c = 0; c < 5; c += 1) {
				const candidate = randomVector(next, dim);
				expect(score(candidate)).toBe(cosineSimilarity(query, candidate));
			}
		}
	});

	it("matches cosineSimilarity on length mismatch in both directions", () => {
		const query = [0.5, -0.25, 1, 2, -1.5];
		const score = cosineScorer(query);
		const shorter = [1, 2];
		const longer = [1, -1, 0.5, 3, 0.1, 9, -4];
		expect(score(shorter)).toBe(cosineSimilarity(query, shorter));
		expect(score(longer)).toBe(cosineSimilarity(query, longer));
	});

	it("matches cosineSimilarity when either side holds non-finite entries", () => {
		const query = [1, Number.NaN, 3, Number.POSITIVE_INFINITY];
		const score = cosineScorer(query);
		const candidates = [
			[1, 2, 3, 4],
			[Number.NaN, 2, Number.NEGATIVE_INFINITY, 4],
			[0, 0, 0, 0],
		];
		for (const candidate of candidates) {
			expect(score(candidate)).toBe(cosineSimilarity(query, candidate));
		}
	});

	it("returns 0 for every candidate when the query has zero norm (matching cosineSimilarity)", () => {
		const query = [0, 0, 0];
		const score = cosineScorer(query);
		for (const candidate of [
			[1, 2, 3],
			[0, 0, 0],
			[Number.NaN, 1, 2],
		]) {
			expect(score(candidate)).toBe(0);
			expect(score(candidate)).toBe(cosineSimilarity(query, candidate));
		}
	});

	it("scores an identical query and candidate as exactly 1", () => {
		// 3-4-5 keeps the norm arithmetic on exact integers, so the anchor is a clean 1.
		const v = [3, 4];
		expect(cosineScorer(v)(v)).toBe(1);
		expect(cosineScorer(v)(v)).toBe(cosineSimilarity(v, v));
	});

	it("returns 0 when both vectors are empty, before any norm arithmetic", () => {
		// max(0, 0) === 0 short-circuits the loop entirely.
		expect(cosineSimilarity([], [])).toBe(0);
		expect(cosineScorer([])([])).toBe(0);
	});
});
