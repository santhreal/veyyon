/**
 * applyListLimit limit=1..100 on 200-item array: exact slice and suggestion.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit limit 1 to 100 exact slice", () => {
	const items = Array.from({ length: 200 }, (_, i) => `v${i}`);

	for (let limit = 1; limit <= 100; limit++) {
		it(`limit=${limit}`, () => {
			const r = applyListLimit(items, { limit });
			expect(r.items).toEqual(items.slice(0, limit));
			expect(r.limitReached).toBe(limit);
			expect(r.meta.resultLimit?.suggestion).toBe(limit * 2);
		});
	}
});
