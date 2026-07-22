/**
 * limit === items.length marks reached for n=1..200.
 * Why: inclusive ceiling must fire when length equals limit.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit equals length 1 to 200 matrix", () => {
	for (let n = 1; n <= 200; n++) {
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
