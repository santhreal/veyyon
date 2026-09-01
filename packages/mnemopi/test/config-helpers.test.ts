import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DB_FILENAME,
	DEFAULT_EMBEDDING_API_URL,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_LLM_MODEL_FILE,
	DEFAULT_LLM_MODEL_REPO,
	DEFAULT_RECALL_WEIGHTS,
	EMBEDDING_DIMS,
	FALLBACK_EMBEDDING_DIM,
	normalizedRecallWeights,
	recencyHalflifeHours,
	VERACITY_WEIGHT_DEFAULTS,
	type VecType,
	vecType,
} from "../src/config";

describe("DEFAULT_DB_FILENAME", () => {
	it("is mnemopi.db", () => {
		expect(DEFAULT_DB_FILENAME).toBe("mnemopi.db");
	});
});

describe("DEFAULT_EMBEDDING_MODEL", () => {
	it("is BAAI/bge-small-en-v1.5", () => {
		expect(DEFAULT_EMBEDDING_MODEL).toBe("BAAI/bge-small-en-v1.5");
	});
});

describe("DEFAULT_EMBEDDING_API_URL", () => {
	it("is openrouter endpoint", () => {
		expect(DEFAULT_EMBEDDING_API_URL).toBe("https://openrouter.ai/api/v1");
	});
});

describe("DEFAULT_LLM_MODEL_REPO", () => {
	it("is TinyLlama repo", () => {
		expect(DEFAULT_LLM_MODEL_REPO).toContain("TinyLlama");
	});
});

describe("DEFAULT_LLM_MODEL_FILE", () => {
	it("is gguf file", () => {
		expect(DEFAULT_LLM_MODEL_FILE).toMatch(/\.gguf$/);
	});
});

describe("FALLBACK_EMBEDDING_DIM", () => {
	it("is 384", () => {
		expect(FALLBACK_EMBEDDING_DIM).toBe(384);
	});
});

describe("EMBEDDING_DIMS", () => {
	it("has entry for default model", () => {
		expect(EMBEDDING_DIMS[DEFAULT_EMBEDDING_MODEL]).toBe(384);
	});
	it("has entry for bge-base-en-v1.5", () => {
		expect(EMBEDDING_DIMS["BAAI/bge-base-en-v1.5"]).toBe(768);
	});
	it("has entry for bge-large-en-v1.5", () => {
		expect(EMBEDDING_DIMS["BAAI/bge-large-en-v1.5"]).toBe(1024);
	});
	it("has entry for text-embedding-3-small", () => {
		expect(EMBEDDING_DIMS["text-embedding-3-small"]).toBe(1536);
	});
	it("has entry for text-embedding-3-large", () => {
		expect(EMBEDDING_DIMS["text-embedding-3-large"]).toBe(3072);
	});
	it("has entry for bge-m3", () => {
		expect(EMBEDDING_DIMS["BAAI/bge-m3"]).toBe(1024);
	});
	it("every entry is a positive number", () => {
		for (const dim of Object.values(EMBEDDING_DIMS)) {
			expect(dim).toBeGreaterThan(0);
		}
	});
});

describe("VERACITY_WEIGHT_DEFAULTS", () => {
	it("has stated weight", () => {
		expect(VERACITY_WEIGHT_DEFAULTS.stated).toBeGreaterThan(0);
	});
	it("has inferred weight", () => {
		expect(VERACITY_WEIGHT_DEFAULTS.inferred).toBeGreaterThan(0);
	});
	it("has tool weight", () => {
		expect(VERACITY_WEIGHT_DEFAULTS.tool).toBeGreaterThan(0);
	});
	it("has imported weight", () => {
		expect(VERACITY_WEIGHT_DEFAULTS.imported).toBeGreaterThan(0);
	});
	it("has unknown weight", () => {
		expect(VERACITY_WEIGHT_DEFAULTS.unknown).toBeGreaterThanOrEqual(0);
	});
});

describe("DEFAULT_RECALL_WEIGHTS", () => {
	it("has 3 weights", () => {
		expect(DEFAULT_RECALL_WEIGHTS).toHaveLength(3);
	});
	it("weights sum to 1", () => {
		const sum = DEFAULT_RECALL_WEIGHTS.reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(1);
	});
	it("vec weight is 0.5", () => {
		expect(DEFAULT_RECALL_WEIGHTS[0]).toBe(0.5);
	});
	it("fts weight is 0.3", () => {
		expect(DEFAULT_RECALL_WEIGHTS[1]).toBe(0.3);
	});
	it("importance weight is 0.2", () => {
		expect(DEFAULT_RECALL_WEIGHTS[2]).toBe(0.2);
	});
});

describe("normalizedRecallWeights", () => {
	it("returns default when all weights are 0", () => {
		expect(normalizedRecallWeights(0, 0, 0)).toEqual(DEFAULT_RECALL_WEIGHTS);
	});
	it("returns weights as-is when they sum to 1", () => {
		const result = normalizedRecallWeights(0.5, 0.3, 0.2);
		expect(result).toEqual([0.5, 0.3, 0.2]);
	});
	it("normalizes weights that don't sum to 1", () => {
		const result = normalizedRecallWeights(2, 2, 2);
		expect(result[0]).toBeCloseTo(1 / 3);
		expect(result[1]).toBeCloseTo(1 / 3);
		expect(result[2]).toBeCloseTo(1 / 3);
	});
	it("handles null values by using defaults", () => {
		const result = normalizedRecallWeights(null, null, null);
		expect(result).toEqual(DEFAULT_RECALL_WEIGHTS);
	});
	it("handles undefined values", () => {
		const result = normalizedRecallWeights(undefined, undefined, undefined);
		expect(result).toEqual(DEFAULT_RECALL_WEIGHTS);
	});
	it("handles negative weights as 0", () => {
		const result = normalizedRecallWeights(-1, 0.5, 0.5);
		expect(result[0]).toBe(0);
		expect(result[1]).toBeCloseTo(0.5);
		expect(result[2]).toBeCloseTo(0.5);
	});
	it("handles NaN as 0", () => {
		const result = normalizedRecallWeights(NaN, 0.5, 0.5);
		expect(result[0]).toBe(0);
	});
	it("handles Infinity as 0", () => {
		const result = normalizedRecallWeights(Infinity, 0.5, 0.5);
		expect(result[0]).toBe(0);
	});
	it("returns 3-element tuple", () => {
		const result = normalizedRecallWeights(0.5, 0.3, 0.2);
		expect(result).toHaveLength(3);
	});
});

describe("recencyHalflifeHours", () => {
	it("returns default 168", () => {
		expect(recencyHalflifeHours()).toBe(168);
	});
});

describe("vecType", () => {
	it("returns int8 by default", () => {
		expect(vecType()).toBe("int8");
	});
	it("returns a valid VecType", () => {
		const result: VecType = vecType();
		expect(["float32", "int8", "bit"]).toContain(result);
	});
});
