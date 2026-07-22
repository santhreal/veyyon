/**
 * limitType match vs result: meta key branch exact for limit 1..100.
 * Why: grep match ceilings must not land under resultLimit.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit match type 1 to 100 grid", () => {
	const items = Array.from({ length: 150 }, (_, i) => i);

	for (let limit = 1; limit <= 100; limit++) {
		it(`match limit=${limit}`, () => {
			const r = applyListLimit(items, { limit, limitType: "match" });
			expect(r.items).toHaveLength(limit);
			expect(r.meta.matchLimit?.reached).toBe(limit);
			expect(r.meta.matchLimit?.suggestion).toBe(limit * 2);
			expect(r.meta.resultLimit).toBeUndefined();
		});

		it(`result limit=${limit}`, () => {
			const r = applyListLimit(items, { limit, limitType: "result" });
			expect(r.meta.resultLimit?.reached).toBe(limit);
			expect(r.meta.matchLimit).toBeUndefined();
		});
	}
});
