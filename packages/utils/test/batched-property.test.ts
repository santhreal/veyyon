import { describe, expect, it } from "bun:test";
import { batched } from "@veyyon/utils/array";

/**
 * batched property: covers all items, preserves order, respects size.
 */

describe("batched property-style", () => {
	it("concat of batches equals the original for many sizes", () => {
		for (let n = 0; n <= 100; n += 3) {
			const items = Array.from({ length: n }, (_, i) => i);
			for (let size = 1; size <= 20; size++) {
				const batches = [...batched(items, size)];
				expect(batches.flat()).toEqual(items);
				for (const b of batches.slice(0, -1)) {
					expect(b).toHaveLength(size);
				}
				if (batches.length > 0) {
					expect(batches[batches.length - 1]!.length).toBeGreaterThan(0);
					expect(batches[batches.length - 1]!.length).toBeLessThanOrEqual(size);
				}
			}
		}
	});

	it("throws for size 0 and negative across empty and non-empty", () => {
		for (const size of [0, -1, -10]) {
			expect(() => [...batched([1, 2, 3], size)]).toThrow(RangeError);
			expect(() => [...batched([], size)]).toThrow(RangeError);
		}
	});
});
