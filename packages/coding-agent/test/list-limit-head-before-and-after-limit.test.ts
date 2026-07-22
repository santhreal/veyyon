/**
 * headLimit interacts with limit: limit truncates first, then headLimit.
 * Why: order of application is a contract for suggestion meta and item count.
 */
import { describe, expect, it } from "bun:test";
import { applyListLimit } from "../src/tools/list-limit";

describe("list-limit head before and after limit order", () => {
	const items = Array.from({ length: 100 }, (_, i) => i);

	for (let limit = 5; limit <= 30; limit += 5) {
		for (let head = 1; head <= 10; head++) {
			it(`limit=${limit} headLimit=${head}`, () => {
				const r = applyListLimit(items, { limit, headLimit: head });
				const afterLimit = items.slice(0, limit);
				const expected = afterLimit.slice(0, Math.min(head, afterLimit.length));
				expect(r.items).toEqual(expected);
				expect(r.limitReached).toBe(limit);
				if (afterLimit.length > head) {
					expect(r.meta.headLimit?.reached).toBe(head);
					expect(r.meta.headLimit?.suggestion).toBe(head * 2);
				}
			});
		}
	}

	it("headLimit alone never sets limitReached", () => {
		const r = applyListLimit(items, { headLimit: 7 });
		expect(r.items).toEqual(items.slice(0, 7));
		expect(r.limitReached).toBeUndefined();
		expect(r.meta.headLimit?.reached).toBe(7);
		expect(r.meta.resultLimit).toBeUndefined();
	});
});
