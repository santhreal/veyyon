/**
 * applyListLimit: limit 0/negative/undefined never truncates; head same.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit undefined and zero head matrix", () => {
	const items = Array.from({ length: 50 }, (_, i) => i);

	for (const limit of [undefined, 0, -1, -100]) {
		it(`limit=${limit}`, () => {
			const r = applyListLimit(items, { limit: limit as never });
			expect(r.items).toEqual(items);
			expect(r.limitReached).toBeUndefined();
		});
	}

	for (const head of [undefined, 0, -1, -50]) {
		it(`headLimit=${head}`, () => {
			const r = applyListLimit(items, { headLimit: head as never });
			expect(r.items).toEqual(items);
			expect(r.meta.headLimit).toBeUndefined();
		});
	}

	it("limit 0 with head 10 does not apply head after empty limit path", () => {
		const r = applyListLimit(items, { limit: 0, headLimit: 10 });
		// limit 0 ignored; head 10 applies
		expect(r.items).toEqual(items.slice(0, 10));
		expect(r.meta.headLimit?.reached).toBe(10);
	});
});
