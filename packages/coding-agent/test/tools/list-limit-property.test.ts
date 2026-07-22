import { describe, expect, it } from "bun:test";
import { applyListLimit } from "@veyyon/coding-agent/tools/list-limit";

/**
 * Property-style contracts for applyListLimit over many sizes.
 * Still exact asserts: length bounds, prefix identity, no mutation.
 */

describe("applyListLimit property-style", () => {
	it("for every n in 0..200 and limit in 1..50, result length is min(n, limit)", () => {
		for (let n = 0; n <= 200; n += 7) {
			const items = Array.from({ length: n }, (_, i) => i);
			for (let limit = 1; limit <= 50; limit += 5) {
				const result = applyListLimit(items, { limit });
				const expectedLen = Math.min(n, limit);
				// When n >= limit, limitReached is set and length is limit.
				// When n < limit, all items returned.
				if (n >= limit) {
					expect(result.items).toHaveLength(limit);
					expect(result.limitReached).toBe(limit);
				} else {
					expect(result.items).toHaveLength(n);
					expect(result.limitReached ?? null).toBeNull();
				}
				expect(result.items).toEqual(items.slice(0, expectedLen));
				// Source not mutated.
				expect(items).toHaveLength(n);
			}
		}
	});

	it("headLimit after limit never exceeds headLimit", () => {
		for (let limit = 5; limit <= 40; limit += 5) {
			for (let head = 1; head <= limit; head += 2) {
				const items = Array.from({ length: 100 }, (_, i) => `i${i}`);
				const result = applyListLimit(items, { limit, headLimit: head });
				expect(result.items.length).toBeLessThanOrEqual(head);
				expect(result.items).toEqual(items.slice(0, Math.min(limit, head, 100)));
			}
		}
	});
});
