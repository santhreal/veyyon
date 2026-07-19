import { describe, expect, it } from "bun:test";
import { batched } from "../src/array";

describe("batched", () => {
	it("splits into full batches with an exact multiple", () => {
		expect([...batched([1, 2, 3, 4], 2)]).toEqual([
			[1, 2],
			[3, 4],
		]);
	});

	it("leaves a short final batch when the length is not a multiple", () => {
		expect([...batched([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("yields a single batch when size exceeds the length", () => {
		expect([...batched([1, 2, 3], 10)]).toEqual([[1, 2, 3]]);
	});

	it("yields one batch per element when size is 1", () => {
		expect([...batched(["a", "b", "c"], 1)]).toEqual([["a"], ["b"], ["c"]]);
	});

	it("yields nothing for an empty input", () => {
		expect([...batched([], 3)]).toEqual([]);
	});

	it("returns fresh arrays that do not alias or mutate the input", () => {
		const source = [1, 2, 3, 4];
		const batches = [...batched(source, 2)];
		batches[0]!.push(99);
		expect(source).toEqual([1, 2, 3, 4]);
		expect(batches[0]).toEqual([1, 2, 99]);
	});

	it("is lazy: it does not slice past the point the caller stops consuming", () => {
		const seen: number[] = [];
		for (const batch of batched([1, 2, 3, 4, 5, 6], 2)) {
			seen.push(batch[0]!);
			if (batch[0] === 3) break;
		}
		// Only the first two batches were produced; the third (starting at 5) never ran.
		expect(seen).toEqual([1, 3]);
	});

	it("throws instead of spinning forever on a non-positive or non-integer size", () => {
		expect(() => [...batched([1, 2], 0)]).toThrow(RangeError);
		expect(() => [...batched([1, 2], -1)]).toThrow(RangeError);
		expect(() => [...batched([1, 2], 1.5)]).toThrow(RangeError);
		expect(() => [...batched([1, 2], Number.NaN)]).toThrow(RangeError);
	});
});
