/**
 * When items.length < limit, identity and no limitReached for limit 1..200.
 * Why: under-ceiling must not invent limitReached or truncate.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit items shorter than limit 1 to 200", () => {
	for (let n = 1; n <= 100; n++) {
		const items = Array.from({ length: n }, (_, i) => i);
		for (const limit of [n + 1, n + 10, n + 50, 200, 1000]) {
			if (limit <= n) continue;
			it(`n=${n} limit=${limit}`, () => {
				const r = applyListLimit(items, { limit });
				expect(r.items).toEqual(items);
				expect(r.limitReached).toBeUndefined();
				expect(r.meta.resultLimit).toBeUndefined();
			});
		}
	}
});
