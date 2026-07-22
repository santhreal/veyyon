/**
 * applyListLimit on large item arrays: exact slice lengths and meta.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit large n property", () => {
	for (const n of [100, 500, 1000, 5000]) {
		it(`n=${n} limit half`, () => {
			const items = Array.from({ length: n }, (_, i) => i);
			const limit = Math.floor(n / 2);
			const r = applyListLimit(items, { limit });
			expect(r.items).toHaveLength(limit);
			expect(r.items[0]).toBe(0);
			expect(r.items[limit - 1]).toBe(limit - 1);
			expect(r.limitReached).toBe(limit);
			expect(r.meta.resultLimit?.suggestion).toBe(limit * 2);
		});

		it(`n=${n} headLimit 10`, () => {
			const items = Array.from({ length: n }, (_, i) => i);
			const r = applyListLimit(items, { headLimit: 10 });
			expect(r.items).toEqual(items.slice(0, 10));
			expect(r.limitReached).toBeUndefined();
			expect(r.meta.headLimit?.reached).toBe(10);
		});
	}
});
