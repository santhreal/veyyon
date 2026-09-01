import { describe, expect, it } from "bun:test";
import { cosineScorer, cosineSimilarity, decodeEmbeddingJson, encodeEmbeddingJson } from "../src/core/vector-math";

describe("cosineSimilarity", () => {
	it("returns 0 for two empty vectors", () => {
		expect(cosineSimilarity([], [])).toBe(0);
	});
	it("returns 1 for identical vectors", () => {
		expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 10);
	});
	it("returns 0 for orthogonal vectors", () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 10);
	});
	it("returns -1 for opposite vectors", () => {
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 10);
	});
	it("returns 0 when one vector is all zeros", () => {
		expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
	});
	it("returns 0 when both vectors are all zeros", () => {
		expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
	});
	it("handles length mismatch (shorter a)", () => {
		const result = cosineSimilarity([1, 2], [1, 2, 0]);
		expect(result).toBeCloseTo(1.0, 10);
	});
	it("handles length mismatch (shorter b)", () => {
		const result = cosineSimilarity([1, 2, 0], [1, 2]);
		expect(result).toBeCloseTo(1.0, 10);
	});
	it("treats NaN entries as 0", () => {
		const result = cosineSimilarity([Number.NaN, 2, 3], [0, 2, 3]);
		expect(result).toBeCloseTo(1.0, 10);
	});
	it("treats Infinity entries as 0", () => {
		const result = cosineSimilarity([Number.POSITIVE_INFINITY, 2], [0, 2]);
		expect(result).toBeCloseTo(1.0, 10);
	});
	it("handles single-element vectors", () => {
		expect(cosineSimilarity([1], [1])).toBeCloseTo(1.0, 10);
	});
	it("handles negative values", () => {
		const result = cosineSimilarity([-1, -2, -3], [1, 2, 3]);
		expect(result).toBeCloseTo(-1.0, 10);
	});
	it("works with Float64Array", () => {
		const a = new Float64Array([1, 2, 3]);
		const b = new Float64Array([1, 2, 3]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 10);
	});
	it("works with Float32Array", () => {
		const a = new Float32Array([1, 0]);
		const b = new Float32Array([0, 1]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
	});
});

describe("cosineScorer", () => {
	it("returns identical results to cosineSimilarity", () => {
		const query = [1, 2, 3];
		const scorer = cosineScorer(query);
		const candidate = [4, 5, 6];
		expect(scorer(candidate)).toBeCloseTo(cosineSimilarity(query, candidate), 10);
	});
	it("returns 0 for all-zero query", () => {
		const scorer = cosineScorer([0, 0, 0]);
		expect(scorer([1, 2, 3])).toBe(0);
	});
	it("returns 0 for all-zero candidate", () => {
		const scorer = cosineScorer([1, 2, 3]);
		expect(scorer([0, 0, 0])).toBe(0);
	});
	it("handles length mismatch", () => {
		const scorer = cosineScorer([1, 2]);
		expect(scorer([1, 2, 3, 4])).toBeCloseTo(cosineSimilarity([1, 2], [1, 2, 3, 4]), 10);
	});
	it("handles NaN in candidate", () => {
		const scorer = cosineScorer([1, 2, 3]);
		const result = scorer([Number.NaN, 2, 3]);
		expect(result).toBeCloseTo(cosineSimilarity([1, 2, 3], [0, 2, 3]), 10);
	});
	it("handles NaN in query (treated as 0)", () => {
		const scorer = cosineScorer([Number.NaN, 2, 3]);
		const result = scorer([1, 2, 3]);
		expect(result).toBeCloseTo(cosineSimilarity([0, 2, 3], [1, 2, 3]), 10);
	});
	it("returns 1 for identical vectors", () => {
		const scorer = cosineScorer([1, 2, 3]);
		expect(scorer([1, 2, 3])).toBeCloseTo(1.0, 10);
	});
	it("works with Float64Array input", () => {
		const query = new Float64Array([1, 2, 3]);
		const scorer = cosineScorer(query);
		expect(scorer([1, 2, 3])).toBeCloseTo(1.0, 10);
	});
	it("can score multiple candidates", () => {
		const scorer = cosineScorer([1, 0]);
		expect(scorer([1, 0])).toBeCloseTo(1.0, 10);
		expect(scorer([0, 1])).toBeCloseTo(0.0, 10);
		expect(scorer([-1, 0])).toBeCloseTo(-1.0, 10);
	});
});

describe("encodeEmbeddingJson", () => {
	it("encodes array of numbers", () => {
		expect(encodeEmbeddingJson([1, 2, 3])).toBe("[1,2,3]");
	});
	it("encodes empty array", () => {
		expect(encodeEmbeddingJson([])).toBe("[]");
	});
	it("encodes floating point", () => {
		expect(encodeEmbeddingJson([1.5, 2.5])).toBe("[1.5,2.5]");
	});
	it("encodes negative numbers", () => {
		expect(encodeEmbeddingJson([-1, -2])).toBe("[-1,-2]");
	});
	it("is deterministic", () => {
		expect(encodeEmbeddingJson([1, 2, 3])).toBe(encodeEmbeddingJson([1, 2, 3]));
	});
});

describe("decodeEmbeddingJson", () => {
	it("decodes valid JSON array", () => {
		expect(decodeEmbeddingJson("[1,2,3]")).toEqual([1, 2, 3]);
	});
	it("decodes floating point", () => {
		expect(decodeEmbeddingJson("[1.5,2.5]")).toEqual([1.5, 2.5]);
	});
	it("decodes negative numbers", () => {
		expect(decodeEmbeddingJson("[-1,-2]")).toEqual([-1, -2]);
	});
	it("returns null for empty string", () => {
		expect(decodeEmbeddingJson("")).toBeNull();
	});
	it("returns null for non-string input", () => {
		expect(decodeEmbeddingJson(123)).toBeNull();
		expect(decodeEmbeddingJson(null)).toBeNull();
		expect(decodeEmbeddingJson(undefined)).toBeNull();
		expect(decodeEmbeddingJson([1, 2, 3])).toBeNull();
	});
	it("returns null for non-array JSON", () => {
		expect(decodeEmbeddingJson('{"a":1}')).toBeNull();
		expect(decodeEmbeddingJson('"hello"')).toBeNull();
		expect(decodeEmbeddingJson("42")).toBeNull();
	});
	it("returns null for empty array", () => {
		expect(decodeEmbeddingJson("[]")).toBeNull();
	});
	it("returns null for array with non-numeric elements", () => {
		expect(decodeEmbeddingJson('["a","b"]')).toBeNull();
		expect(decodeEmbeddingJson('[1,"b"]')).toBeNull();
	});
	it("returns null for array with NaN", () => {
		expect(decodeEmbeddingJson("[NaN]")).toBeNull();
	});
	it("returns null for array with Infinity", () => {
		expect(decodeEmbeddingJson("[Infinity]")).toBeNull();
	});
	it("returns null for array with null elements", () => {
		expect(decodeEmbeddingJson("[null,1]")).toBeNull();
	});
	it("returns null for array with string numbers", () => {
		expect(decodeEmbeddingJson('["1","2"]')).toBeNull();
	});
	it("returns null for invalid JSON", () => {
		expect(decodeEmbeddingJson("[1,2,")).toBeNull();
	});
	it("round-trips with encodeEmbeddingJson", () => {
		const original = [1.5, -2.3, 3.14];
		const encoded = encodeEmbeddingJson(original);
		const decoded = decodeEmbeddingJson(encoded);
		expect(decoded).toEqual(original);
	});
	it("handles single-element array", () => {
		expect(decodeEmbeddingJson("[42]")).toEqual([42]);
	});
	it("handles large array", () => {
		const large = Array.from({ length: 100 }, (_, i) => i * 0.1);
		const encoded = encodeEmbeddingJson(large);
		const decoded = decodeEmbeddingJson(encoded);
		expect(decoded).toEqual(large);
	});
});
