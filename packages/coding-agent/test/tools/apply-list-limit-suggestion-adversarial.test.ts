import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

/**
 * applyListLimit suggestion field is 2x the reached limit.
 */

describe("applyListLimit suggestion adversarial", () => {
	it("resultLimit suggestion is 2x reached for many limits", () => {
		const items = Array.from({ length: 1000 }, (_, i) => i);
		for (const limit of [1, 2, 5, 10, 25, 50, 100]) {
			const result = applyListLimit(items, { limit, limitType: "result" });
			expect(result.meta.resultLimit?.reached).toBe(limit);
			expect(result.meta.resultLimit?.suggestion).toBe(limit * 2);
		}
	});

	it("matchLimit suggestion is 2x reached", () => {
		const items = Array.from({ length: 100 }, (_, i) => i);
		const result = applyListLimit(items, { limit: 7, limitType: "match" });
		expect(result.meta.matchLimit?.reached).toBe(7);
		expect(result.meta.matchLimit?.suggestion).toBe(14);
	});

	it("headLimit suggestion is 2x headLimit", () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		const result = applyListLimit(items, { limit: 40, headLimit: 6 });
		expect(result.meta.headLimit?.reached).toBe(6);
		expect(result.meta.headLimit?.suggestion).toBe(12);
		expect(result.items).toHaveLength(6);
	});
});
