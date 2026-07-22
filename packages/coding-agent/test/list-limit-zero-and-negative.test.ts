/**
 * applyListLimit ignores non-positive limit and headLimit.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("applyListLimit non-positive ignored", () => {
	const items = ["a", "b", "c"];
	for (const limit of [0, -1, -100]) {
		it(`limit=${limit}`, () => {
			const r = applyListLimit(items, { limit });
			expect(r.items).toEqual(items);
			expect(r.meta).toEqual({});
		});
	}
	for (const headLimit of [0, -1, -5]) {
		it(`headLimit=${headLimit}`, () => {
			const r = applyListLimit(items, { headLimit });
			expect(r.items).toEqual(items);
			expect(r.meta).toEqual({});
		});
	}
});
