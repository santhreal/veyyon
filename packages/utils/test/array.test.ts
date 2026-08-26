import { describe, expect, it } from "bun:test";
import { batched, countWhere, IncrementalScan, partition } from "../src/array";

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

describe("countWhere", () => {
	it("counts matching elements without allocating an intermediate array", () => {
		expect(countWhere([1, 2, 3, 4, 5], x => x > 2)).toBe(3);
	});

	it("returns 0 for an empty input", () => {
		expect(countWhere([], () => true)).toBe(0);
	});

	it("returns 0 when nothing matches", () => {
		expect(countWhere([1, 2, 3], x => x > 10)).toBe(0);
	});

	it("returns the full length when everything matches", () => {
		expect(countWhere([1, 2, 3], x => x > 0)).toBe(3);
	});

	it("works with strings spread into arrays", () => {
		expect(countWhere([..."hello"], c => c === "l")).toBe(2);
	});
});

describe("partition", () => {
	it("splits matching and non-matching into two arrays", () => {
		const [evens, odds] = partition([1, 2, 3, 4, 5], x => x % 2 === 0);
		expect(evens).toEqual([2, 4]);
		expect(odds).toEqual([1, 3, 5]);
	});

	it("returns two empty arrays for an empty input", () => {
		const [yes, no] = partition([], () => true);
		expect(yes).toEqual([]);
		expect(no).toEqual([]);
	});

	it("puts everything in matching when the predicate is always true", () => {
		const [yes, no] = partition([1, 2, 3], () => true);
		expect(yes).toEqual([1, 2, 3]);
		expect(no).toEqual([]);
	});

	it("puts everything in non-matching when the predicate is always false", () => {
		const [yes, no] = partition([1, 2, 3], () => false);
		expect(yes).toEqual([]);
		expect(no).toEqual([1, 2, 3]);
	});

	it("preserves order within each partition", () => {
		const [pos, neg] = partition([3, -1, 2, -5, 0], x => x >= 0);
		expect(pos).toEqual([3, 2, 0]);
		expect(neg).toEqual([-1, -5]);
	});

	it("does not mutate the input", () => {
		const src = [1, 2, 3];
		partition(src, x => x > 1);
		expect(src).toEqual([1, 2, 3]);
	});
});

describe("IncrementalScan", () => {
	it("returns false for an empty array", () => {
		const scan = new IncrementalScan<number>(x => x > 5);
		expect(scan.check([])).toBe(false);
	});

	it("returns true when a matching element exists", () => {
		const scan = new IncrementalScan<number>(x => x > 5);
		expect(scan.check([1, 2, 6, 7])).toBe(true);
	});

	it("returns false when no element matches", () => {
		const scan = new IncrementalScan<number>(x => x > 10);
		expect(scan.check([1, 2, 3])).toBe(false);
	});

	it("caches a positive result and does not re-scan on append", () => {
		let calls = 0;
		const scan = new IncrementalScan<number>(x => {
			calls++;
			return x > 5;
		});
		const arr = [1, 2, 6];
		expect(scan.check(arr)).toBe(true);
		const firstCalls = calls;
		arr.push(7);
		expect(scan.check(arr)).toBe(true);
		// Result already true: no scanning needed at all.
		expect(calls - firstCalls).toBe(0);
	});

	it("caches a negative result and only scans new elements on append", () => {
		let calls = 0;
		const scan = new IncrementalScan<number>(x => {
			calls++;
			return x > 10;
		});
		const arr = [1, 2, 3];
		expect(scan.check(arr)).toBe(false);
		const firstCalls = calls;
		arr.push(4, 5);
		expect(scan.check(arr)).toBe(false);
		expect(calls - firstCalls).toBe(2);
	});

	it("re-scans from scratch when the reference changes", () => {
		const scan = new IncrementalScan<number>(x => x > 5);
		expect(scan.check([1, 2, 6])).toBe(true);
		expect(scan.check([1, 2, 3])).toBe(false);
	});

	it("re-scans from scratch when the array shrinks", () => {
		const scan = new IncrementalScan<number>(x => x > 5);
		const arr = [1, 2, 6];
		expect(scan.check(arr)).toBe(true);
		arr.length = 1;
		expect(scan.check(arr)).toBe(false);
	});

	it("reset clears the cache", () => {
		const scan = new IncrementalScan<number>(x => x > 5);
		expect(scan.check([1, 2, 6])).toBe(true);
		scan.reset();
		expect(scan.check([])).toBe(false);
	});
});
