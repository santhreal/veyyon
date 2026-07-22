import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

/**
 * Residual tool-matrix depth for truncation meta used by glob/grep/search
 * tool results. Complements list-limit unit tests with adversarial stacks:
 * limit + headLimit + match type together never invent negative suggestions.
 */

describe("tool output limit meta contracts", () => {
	it("never produces non-positive suggestions when limits fire", () => {
		const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
		const cases = [
			{ limit: 1, headLimit: 1, limitType: "match" as const },
			{ limit: 10, headLimit: 3, limitType: "result" as const },
			{ limit: 50, headLimit: 50, limitType: "result" as const },
		];
		for (const opts of cases) {
			const result = applyListLimit(items, opts);
			if (result.meta.matchLimit) {
				expect(result.meta.matchLimit.reached).toBeGreaterThan(0);
				expect(result.meta.matchLimit.suggestion).toBe(result.meta.matchLimit.reached * 2);
			}
			if (result.meta.resultLimit) {
				expect(result.meta.resultLimit.reached).toBeGreaterThan(0);
				expect(result.meta.resultLimit.suggestion).toBe(result.meta.resultLimit.reached * 2);
			}
			if (result.meta.headLimit) {
				expect(result.meta.headLimit.reached).toBeGreaterThan(0);
				expect(result.meta.headLimit.suggestion).toBe(result.meta.headLimit.reached * 2);
			}
			expect(result.items.length).toBeLessThanOrEqual(opts.headLimit);
		}
	});

	it("preserves item identity (no map/clone of element values)", () => {
		const obj = { id: 1 };
		const result = applyListLimit([obj, { id: 2 }], { limit: 1 });
		expect(result.items[0]).toBe(obj);
		expect(result.items[0]).toEqual({ id: 1 });
	});
});
