/**
 * When items.length === limit, limitReached fires.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit equals length marks reached", () => {
	for (const n of [1, 2, 3, 5, 10]) {
		it(`n=${n}`, () => {
			const items = Array.from({ length: n }, (_, i) => i);
			const r = applyListLimit(items, { limit: n });
			expect(r.items).toEqual(items);
			expect(r.limitReached).toBe(n);
			expect(r.meta.resultLimit?.reached).toBe(n);
			expect(r.meta.resultLimit?.suggestion).toBe(n * 2);
		});
	}
});
