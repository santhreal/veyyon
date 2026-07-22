/**
 * applyListLimit match vs result limitType: suggestion is always 2× limit.
 * Why: UI "load more" doubles the ceiling; wrong meta key breaks match vs result UX.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit match type suggestion grid", () => {
	for (let limit = 1; limit <= 30; limit++) {
		it(`match limit=${limit}`, () => {
			const items = Array.from({ length: limit + 3 }, (_, i) => i);
			const r = applyListLimit(items, { limit, limitType: "match" });
			expect(r.items).toEqual(items.slice(0, limit));
			expect(r.limitReached).toBe(limit);
			expect(r.meta.matchLimit).toEqual({ reached: limit, suggestion: limit * 2 });
			expect(r.meta.resultLimit).toBeUndefined();
		});

		it(`result limit=${limit}`, () => {
			const items = Array.from({ length: limit + 3 }, (_, i) => i);
			const r = applyListLimit(items, { limit, limitType: "result" });
			expect(r.meta.resultLimit).toEqual({ reached: limit, suggestion: limit * 2 });
			expect(r.meta.matchLimit).toBeUndefined();
		});
	}
});
