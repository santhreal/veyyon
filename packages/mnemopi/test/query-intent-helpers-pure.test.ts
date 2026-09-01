import { describe, expect, it } from "bun:test";
import { adjustWeights, classifyIntent, INTENT_PATTERNS, INTENT_WEIGHTS } from "../src/core/query-intent";

describe("INTENT_PATTERNS", () => {
	it("has patterns for temporal, factual, entity, preference, procedural", () => {
		const categories = INTENT_PATTERNS.map(([cat]) => cat);
		expect(categories).toContain("temporal");
		expect(categories).toContain("factual");
		expect(categories).toContain("entity");
		expect(categories).toContain("preference");
		expect(categories).toContain("procedural");
	});
	it("each pattern group has at least one regex", () => {
		for (const [, patterns] of INTENT_PATTERNS) {
			expect(patterns.length).toBeGreaterThan(0);
		}
	});
});

describe("INTENT_WEIGHTS", () => {
	it("has weights for all categories including general", () => {
		expect(INTENT_WEIGHTS.temporal).toBeDefined();
		expect(INTENT_WEIGHTS.factual).toBeDefined();
		expect(INTENT_WEIGHTS.entity).toBeDefined();
		expect(INTENT_WEIGHTS.preference).toBeDefined();
		expect(INTENT_WEIGHTS.procedural).toBeDefined();
		expect(INTENT_WEIGHTS.general).toBeDefined();
	});
	it("each weight has vec_bias, fts_bias, importance_bias", () => {
		for (const key in INTENT_WEIGHTS) {
			const w = INTENT_WEIGHTS[key as keyof typeof INTENT_WEIGHTS];
			expect(typeof w.vec_bias).toBe("number");
			expect(typeof w.fts_bias).toBe("number");
			expect(typeof w.importance_bias).toBe("number");
		}
	});
	it("general weights are all 1.0", () => {
		expect(INTENT_WEIGHTS.general.vec_bias).toBe(1.0);
		expect(INTENT_WEIGHTS.general.fts_bias).toBe(1.0);
		expect(INTENT_WEIGHTS.general.importance_bias).toBe(1.0);
	});
});

describe("classifyIntent", () => {
	it("returns general for empty string", () => {
		const result = classifyIntent("");
		expect(result.category).toBe("general");
		expect(result.confidence).toBe(0.0);
		expect(result.signals).toEqual([]);
	});
	it("returns general for non-matching text", () => {
		const result = classifyIntent("hello world");
		expect(result.category).toBe("general");
		expect(result.confidence).toBe(0.0);
	});
	it("classifies temporal queries", () => {
		const result = classifyIntent("when was the last deployment?");
		expect(result.category).toBe("temporal");
		expect(result.confidence).toBeGreaterThan(0);
		expect(result.signals).toContain("temporal");
	});
	it("classifies factual queries", () => {
		const result = classifyIntent("what is the meaning of life?");
		expect(result.category).toBe("factual");
		expect(result.signals).toContain("factual");
	});
	it("classifies entity queries", () => {
		const result = classifyIntent("tell me about the database");
		expect(result.category).toBe("entity");
		expect(result.signals).toContain("entity");
	});
	it("classifies preference queries", () => {
		const result = classifyIntent("which database should i prefer?");
		expect(result.category).toBe("preference");
		expect(result.signals).toContain("preference");
	});
	it("classifies procedural queries", () => {
		const result = classifyIntent("how to deploy the server");
		expect(result.category).toBe("procedural");
		expect(result.signals).toContain("procedural");
	});
	it("confidence increases with more pattern matches", () => {
		const single = classifyIntent("when was it?");
		const multi = classifyIntent("when was the last deployment yesterday?");
		expect(multi.confidence).toBeGreaterThanOrEqual(single.confidence);
	});
	it("confidence is capped at 1.0", () => {
		const result = classifyIntent("when was yesterday today tomorrow last week january 2024-01-01");
		expect(result.confidence).toBeLessThanOrEqual(1.0);
	});
	it("returns biases from INTENT_WEIGHTS", () => {
		const result = classifyIntent("when was it?");
		expect(result.vec_bias).toBe(INTENT_WEIGHTS.temporal.vec_bias);
		expect(result.fts_bias).toBe(INTENT_WEIGHTS.temporal.fts_bias);
		expect(result.importance_bias).toBe(INTENT_WEIGHTS.temporal.importance_bias);
	});
	it("handles multi-signal queries", () => {
		const result = classifyIntent("when should i deploy the server?");
		expect(result.signals).toContain("temporal");
		expect(result.signals).toContain("preference");
	});
	it("lowercases query before matching", () => {
		const upper = classifyIntent("WHAT IS this?");
		const lower = classifyIntent("what is this?");
		expect(upper.category).toBe(lower.category);
	});
});

describe("adjustWeights", () => {
	it("returns default weights when no intent provided", () => {
		const [v, f, i] = adjustWeights();
		expect(v).toBeCloseTo(0.5, 10);
		expect(f).toBeCloseTo(0.3, 10);
		expect(i).toBeCloseTo(0.2, 10);
	});
	it("normalizes weights to sum to 1", () => {
		const [v, f, i] = adjustWeights(0.5, 0.3, 0.2);
		expect(v + f + i).toBeCloseTo(1.0, 10);
	});
	it("applies intent biases", () => {
		const intent = {
			category: "temporal" as const,
			confidence: 0.5,
			signals: ["temporal"],
			vec_bias: 2.0,
			fts_bias: 1.0,
			importance_bias: 1.0,
		};
		const [v] = adjustWeights(0.5, 0.3, 0.2, intent);
		expect(v).toBeCloseTo((0.5 * 2.0) / (0.5 * 2.0 + 0.3 + 0.2), 10);
	});
	it("handles zero base weights", () => {
		const [v, f, i] = adjustWeights(0, 0, 0);
		expect(v).toBe(0);
		expect(f).toBe(0);
		expect(i).toBe(0);
	});
	it("handles negative base weights (total > 0 still normalizes)", () => {
		const [v, f, i] = adjustWeights(-0.1, 0.5, 0.3);
		const total = v + f + i;
		expect(total).toBeCloseTo(1.0, 10);
	});
	it("handles all-negative weights (total <= 0, no normalization)", () => {
		const [v, f, i] = adjustWeights(-0.5, -0.3, -0.2);
		expect(v + f + i).toBeCloseTo(-1.0, 10);
	});
	it("uses general intent biases when intent is null", () => {
		const [v1, f1, i1] = adjustWeights(0.5, 0.3, 0.2, null);
		const [v2, f2, i2] = adjustWeights(0.5, 0.3, 0.2);
		expect(v1).toBeCloseTo(v2, 10);
		expect(f1).toBeCloseTo(f2, 10);
		expect(i1).toBeCloseTo(i2, 10);
	});
});
