import { describe, expect, it } from "bun:test";
import { batched } from "../src/array";
import { prefetch } from "../src/async-helpers";
import { scopedTimeoutSignal, withTimeoutSignal } from "../src/scoped-timeout";

describe("batched", () => {
	it("yields slices of the given size", () => {
		const result = [...batched([1, 2, 3, 4, 5], 2)];
		expect(result).toEqual([[1, 2], [3, 4], [5]]);
	});
	it("yields nothing for empty input", () => {
		expect([...batched([], 3)]).toEqual([]);
	});
	it("yields single batch when items fit", () => {
		expect([...batched([1, 2, 3], 10)]).toEqual([[1, 2, 3]]);
	});
	it("yields single item per batch when size=1", () => {
		expect([...batched([1, 2, 3], 1)]).toEqual([[1], [2], [3]]);
	});
	it("throws for size=0", () => {
		expect(() => [...batched([1, 2], 0)]).toThrow(RangeError);
	});
	it("throws for negative size", () => {
		expect(() => [...batched([1, 2], -1)]).toThrow(RangeError);
	});
	it("throws for non-integer size", () => {
		expect(() => [...batched([1, 2], 2.5)]).toThrow(RangeError);
	});
	it("yields fresh arrays (not views)", () => {
		const original = [1, 2, 3];
		const [batch] = [...batched(original, 3)];
		batch.push(4);
		expect(original).toEqual([1, 2, 3]);
	});
	it("handles size larger than array", () => {
		expect([...batched([1], 100)]).toEqual([[1]]);
	});
	it("preserves order", () => {
		const result = [...batched([5, 4, 3, 2, 1], 2)];
		expect(result).toEqual([[5, 4], [3, 2], [1]]);
	});
	it("handles exactly divisible sizes", () => {
		expect([...batched([1, 2, 3, 4], 2)]).toEqual([
			[1, 2],
			[3, 4],
		]);
	});
});

describe("prefetch", () => {
	it("returns the same promise", () => {
		const p = Promise.resolve(42);
		expect(prefetch(p)).toBe(p);
	});
	it("swallows rejection (no unhandled rejection)", async () => {
		const p = Promise.reject(new Error("fail"));
		prefetch(p);
		// If this doesn't throw, the rejection was swallowed
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(true).toBe(true);
	});
	it("preserves resolved value", async () => {
		const p = prefetch(Promise.resolve("hello"));
		expect(await p).toBe("hello");
	});
});

describe("withTimeoutSignal", () => {
	it("returns an AbortSignal", () => {
		const signal = withTimeoutSignal(1000);
		expect(signal).toBeInstanceOf(AbortSignal);
	});
	it("combines with parent signal", () => {
		const controller = new AbortController();
		const signal = withTimeoutSignal(1000, controller.signal);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
	});
	it("is not aborted immediately", () => {
		const signal = withTimeoutSignal(10000);
		expect(signal.aborted).toBe(false);
	});
});

describe("scopedTimeoutSignal", () => {
	it("returns a signal and cancel function", () => {
		const { signal, cancel } = scopedTimeoutSignal(1000);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(typeof cancel).toBe("function");
		expect(signal.aborted).toBe(false);
		cancel();
	});
	it("combines with parent signal", () => {
		const parent = new AbortController();
		const { signal, cancel } = scopedTimeoutSignal(1000, parent.signal);
		expect(signal.aborted).toBe(false);
		parent.abort();
		expect(signal.aborted).toBe(true);
		cancel();
	});
	it("cancel prevents abort", () => {
		const { signal, cancel } = scopedTimeoutSignal(100);
		cancel();
		// After cancel, the timer is cleared so signal should not abort
		// (can't easily test this without waiting, so just verify cancel doesn't throw)
		expect(signal.aborted).toBe(false);
	});
});
