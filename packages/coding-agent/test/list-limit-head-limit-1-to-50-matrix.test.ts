/**
 * applyListLimit headLimit 1..50 on 100-item array: exact slice, no limitReached.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit headLimit 1 to 50 matrix", () => {
	const items = Array.from({ length: 100 }, (_, i) => i);

	for (let h = 1; h <= 50; h++) {
		it(`headLimit=${h}`, () => {
			const r = applyListLimit(items, { headLimit: h });
			expect(r.items).toEqual(items.slice(0, h));
			expect(r.limitReached).toBeUndefined();
			expect(r.meta.headLimit?.reached).toBe(h);
			expect(r.meta.headLimit?.suggestion).toBe(h * 2);
		});
	}
});
