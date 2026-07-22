/**
 * headLimit 1..100 after limit=200: exact head slice and head suggestion.
 * Why: head stacks after result limit; suggestion always doubles head.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit head limit 1 to 100 matrix", () => {
	const items = Array.from({ length: 200 }, (_, i) => `v${i}`);

	for (let head = 1; head <= 100; head++) {
		it(`headLimit=${head}`, () => {
			const r = applyListLimit(items, { limit: 200, headLimit: head });
			expect(r.items).toEqual(items.slice(0, head));
			expect(r.meta.headLimit?.reached).toBe(head);
			expect(r.meta.headLimit?.suggestion).toBe(head * 2);
			// result limit also fired (length 200 >= 200)
			expect(r.meta.resultLimit?.reached).toBe(200);
		});
	}
});
