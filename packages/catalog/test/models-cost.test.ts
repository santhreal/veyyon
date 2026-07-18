import { describe, expect, it } from "bun:test";
import { calculateCost, modelsAreEqual } from "../src/models";
import type { Api, Model, Usage } from "../src/types";

const model = {
	id: "test-model",
	provider: "test-provider",
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as unknown as Model<Api>;

function usage(partial: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...partial,
	} as Usage;
}

describe("calculateCost", () => {
	it("prices each bucket at per-million rates and totals them", () => {
		const u = usage({ input: 1_000_000, output: 200_000, cacheRead: 500_000, cacheWrite: 100_000 });
		const cost = calculateCost(model, u);
		expect(cost.input).toBeCloseTo(3, 10);
		expect(cost.output).toBeCloseTo(3, 10); // 0.2M * $15
		expect(cost.cacheRead).toBeCloseTo(0.15, 10);
		expect(cost.cacheWrite).toBeCloseTo(0.375, 10);
		expect(cost.total).toBeCloseTo(3 + 3 + 0.15 + 0.375, 10);
		expect(u.cost).toBe(cost); // mutates in place
	});

	it("adds orchestration tokens to input/output/cacheRead but never cacheWrite", () => {
		const withOrchestration = usage({
			input: 1_000_000,
			orchestration: { input: 1_000_000, output: 100_000, cacheRead: 1_000_000 },
		});
		const cost = calculateCost(model, withOrchestration);
		expect(cost.input).toBeCloseTo(6, 10); // 2M billed input
		expect(cost.output).toBeCloseTo(1.5, 10);
		expect(cost.cacheRead).toBeCloseTo(0.3, 10);
		expect(cost.cacheWrite).toBe(0);
	});

	it("prices zero usage as zero", () => {
		expect(calculateCost(model, usage({})).total).toBe(0);
	});
});

describe("modelsAreEqual", () => {
	const other = { ...model, provider: "different-provider" } as unknown as Model<Api>;

	it("compares by id AND provider", () => {
		expect(modelsAreEqual(model, { ...model } as Model<Api>)).toBe(true);
		expect(modelsAreEqual(model, other)).toBe(false);
		expect(modelsAreEqual(model, { ...model, id: "other-id" } as Model<Api>)).toBe(false);
	});

	it("is false when either side is null or undefined", () => {
		expect(modelsAreEqual(null, model)).toBe(false);
		expect(modelsAreEqual(model, undefined)).toBe(false);
		expect(modelsAreEqual(null, undefined)).toBe(false);
	});
});
