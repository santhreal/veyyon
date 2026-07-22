/**
 * When length < limit, limitReached unset and meta empty for limit alone.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit below ceiling", () => {
	for (const n of [1, 2, 5]) {
		it(`n=${n} limit=${n + 5}`, () => {
			const items = Array.from({ length: n }, (_, i) => i);
			const r = applyListLimit(items, { limit: n + 5 });
			expect(r.items).toEqual(items);
			expect(r.limitReached).toBeUndefined();
			expect(r.meta).toEqual({});
		});
	}
});
