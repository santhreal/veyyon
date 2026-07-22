/**
 * limitReached fires when length >= limit (inclusive ceiling), not only when
 * strictly greater. Suggestion is always 2×.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

describe("applyListLimit inclusive ceiling", () => {
	for (const n of [1, 2, 5, 10, 100]) {
		it(`n=${n} equals limit fires`, () => {
			const items = Array.from({ length: n }, (_, i) => i);
			const r = applyListLimit(items, { limit: n });
			expect(r.limitReached).toBe(n);
			expect(r.items).toHaveLength(n);
			expect(r.meta.resultLimit?.suggestion).toBe(n * 2);
		});

		it(`n=${n} length n-1 does not fire`, () => {
			if (n === 1) return;
			const items = Array.from({ length: n - 1 }, (_, i) => i);
			const r = applyListLimit(items, { limit: n });
			expect(r.limitReached).toBeUndefined();
			expect(r.meta.resultLimit).toBeUndefined();
		});
	}
});
