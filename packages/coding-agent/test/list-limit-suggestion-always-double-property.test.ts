/**
 * applyListLimit suggestion is always 2× reached for limit and headLimit.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

describe("applyListLimit suggestion always double", () => {
	for (const limit of [1, 2, 5, 10, 50, 100]) {
		it(`limit=${limit} suggestion=${limit * 2}`, () => {
			const items = Array.from({ length: limit + 3 }, (_, i) => i);
			const r = applyListLimit(items, { limit });
			expect(r.limitReached).toBe(limit);
			expect(r.meta.resultLimit?.suggestion).toBe(limit * 2);
			expect(r.meta.resultLimit?.reached).toBe(limit);
		});

		it(`match limitType limit=${limit}`, () => {
			const items = Array.from({ length: limit }, (_, i) => i);
			const r = applyListLimit(items, { limit, limitType: "match" });
			expect(r.meta.matchLimit?.suggestion).toBe(limit * 2);
		});
	}

	for (const head of [1, 3, 7, 20]) {
		it(`headLimit=${head} suggestion=${head * 2}`, () => {
			const items = Array.from({ length: head + 5 }, (_, i) => i);
			const r = applyListLimit(items, { headLimit: head });
			expect(r.meta.headLimit?.reached).toBe(head);
			expect(r.meta.headLimit?.suggestion).toBe(head * 2);
			expect(r.items).toHaveLength(head);
		});
	}
});
