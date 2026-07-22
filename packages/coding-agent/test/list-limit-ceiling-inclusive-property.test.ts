/**
 * applyListLimit inclusive ceiling: length === limit marks reached; length-1 does not.
 * Why: off-by-one on the inclusive boundary silently drops limitReached meta.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit ceiling inclusive property", () => {
	for (let limit = 1; limit <= 40; limit++) {
		it(`limit=${limit} length=limit marks reached`, () => {
			const items = Array.from({ length: limit }, (_, i) => i);
			const r = applyListLimit(items, { limit });
			expect(r.items).toEqual(items);
			expect(r.limitReached).toBe(limit);
			expect(r.meta.resultLimit?.reached).toBe(limit);
			expect(r.meta.resultLimit?.suggestion).toBe(limit * 2);
		});

		it(`limit=${limit} length=limit-1 when limit>1 no mark`, () => {
			if (limit === 1) {
				const r = applyListLimit([], { limit });
				expect(r.items).toEqual([]);
				expect(r.limitReached).toBeUndefined();
				return;
			}
			const items = Array.from({ length: limit - 1 }, (_, i) => i);
			const r = applyListLimit(items, { limit });
			expect(r.items).toEqual(items);
			expect(r.limitReached).toBeUndefined();
			expect(r.meta).toEqual({});
		});

		it(`limit=${limit} length=limit+5 truncates exact`, () => {
			const items = Array.from({ length: limit + 5 }, (_, i) => `v${i}`);
			const r = applyListLimit(items, { limit });
			expect(r.items).toEqual(items.slice(0, limit));
			expect(r.limitReached).toBe(limit);
		});
	}

	it("headLimit after result limit stacks", () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		const r = applyListLimit(items, { limit: 10, headLimit: 3 });
		expect(r.items).toEqual([0, 1, 2]);
		expect(r.limitReached).toBe(10);
		expect(r.meta.headLimit?.reached).toBe(3);
		expect(r.meta.headLimit?.suggestion).toBe(6);
		expect(r.meta.resultLimit?.reached).toBe(10);
	});

	for (const limitType of ["match", "result"] as const) {
		it(`limitType=${limitType} keys only that meta`, () => {
			const r = applyListLimit([1, 2, 3], { limit: 3, limitType });
			if (limitType === "match") {
				expect(r.meta.matchLimit?.reached).toBe(3);
				expect(r.meta.resultLimit).toBeUndefined();
			} else {
				expect(r.meta.resultLimit?.reached).toBe(3);
				expect(r.meta.matchLimit).toBeUndefined();
			}
		});
	}
});
