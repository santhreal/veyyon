/**
 * applyListLimit limit=101..300 on 500-item array: exact slice and suggestion*2.
 * Why: ceiling arithmetic must stay exact past the prior 100-band coverage.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit limit 101 to 300 exact slice", () => {
	const items = Array.from({ length: 500 }, (_, i) => `v${i}`);

	for (let limit = 101; limit <= 300; limit++) {
		it(`limit=${limit}`, () => {
			const r = applyListLimit(items, { limit });
			expect(r.items).toEqual(items.slice(0, limit));
			expect(r.limitReached).toBe(limit);
			expect(r.meta.resultLimit?.suggestion).toBe(limit * 2);
			expect(r.meta.resultLimit?.reached).toBe(limit);
		});
	}
});
