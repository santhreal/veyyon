import { describe, expect, it } from "bun:test";
import { decodeEmbeddingJson, encodeEmbeddingJson } from "../src/core/vector-math";

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
