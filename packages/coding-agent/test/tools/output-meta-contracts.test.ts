import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/core/list-limit";
import { outputMeta } from "@veyyon/coding-agent/tools/core/output-meta";

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

	it("records match, result and head limits under their own keys, and skips a limit that did not fire", () => {
		expect(outputMeta().limits({ matchLimit: 3, resultLimit: 5, headLimit: 7 }).get()).toEqual({
			limits: {
				matchLimit: { reached: 3, suggestion: 6 },
				resultLimit: { reached: 5, suggestion: 10 },
				headLimit: { reached: 7, suggestion: 14 },
			},
		});
		expect(outputMeta().resultLimit(4, 9).headLimit(0).matchLimit(-1).get()).toEqual({
			limits: { resultLimit: { reached: 4, suggestion: 9 } },
		});
	});
});
