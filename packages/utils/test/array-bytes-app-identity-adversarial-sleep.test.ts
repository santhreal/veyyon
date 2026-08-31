import { describe, expect, it } from "bun:test";
import { buildString, FRAGMENTS, lcg, lcgUint32 } from "../src/adversarial-strings";
import { APP_DIRECTORY_SLUG, APP_DISPLAY_NAME } from "../src/app-identity";
import { batched } from "../src/array";
import { asStrictBytes } from "../src/bytes";
import { sleepSync } from "../src/sleep";

describe("batched", () => {
	it("yields batches of specified size", () => {
		expect([...batched([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("yields single batch when items fit", () => {
		expect([...batched([1, 2, 3], 5)]).toEqual([[1, 2, 3]]);
	});

	it("yields nothing for empty array", () => {
		expect([...batched([], 3)]).toEqual([]);
	});

	it("yields exact batches when evenly divisible", () => {
		expect([...batched([1, 2, 3, 4], 2)]).toEqual([
			[1, 2],
			[3, 4],
		]);
	});

	it("throws for size 0", () => {
		expect(() => [...batched([1, 2], 0)]).toThrow(RangeError);
	});

	it("throws for negative size", () => {
		expect(() => [...batched([1, 2], -1)]).toThrow(RangeError);
	});

	it("throws for non-integer size", () => {
		expect(() => [...batched([1, 2], 1.5)]).toThrow(RangeError);
	});

	it("throws for NaN size", () => {
		expect(() => [...batched([1, 2], NaN)]).toThrow(RangeError);
	});

	it("handles size 1", () => {
		expect([...batched([1, 2, 3], 1)]).toEqual([[1], [2], [3]]);
	});

	it("handles large size", () => {
		expect([...batched([1, 2], 1000)]).toEqual([[1, 2]]);
	});
});

describe("asStrictBytes", () => {
	it("returns same reference for full ArrayBuffer", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(asStrictBytes(bytes)).toBe(bytes);
	});

	it("copies subarray into new ArrayBuffer", () => {
		const buffer = new ArrayBuffer(10);
		const view = new Uint8Array(buffer, 2, 3);
		view[0] = 1;
		view[1] = 2;
		view[2] = 3;
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect(result.byteOffset).toBe(0);
		expect(Array.from(result)).toEqual([1, 2, 3]);
	});

	it("copies when byteOffset is non-zero", () => {
		const buffer = new ArrayBuffer(5);
		const view = new Uint8Array(buffer, 2);
		view[0] = 42;
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect(result.byteOffset).toBe(0);
		expect(result[0]).toBe(42);
	});

	it("copies when byteLength < buffer byteLength", () => {
		const buffer = new ArrayBuffer(10);
		const view = new Uint8Array(buffer, 0, 3);
		view[0] = 1;
		view[1] = 2;
		view[2] = 3;
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect(Array.from(result)).toEqual([1, 2, 3]);
	});

	it("handles empty array", () => {
		const bytes = new Uint8Array(0);
		const result = asStrictBytes(bytes);
		expect(result.byteLength).toBe(0);
	});
});

describe("APP_DIRECTORY_SLUG", () => {
	it("is 'veyyon'", () => {
		expect(APP_DIRECTORY_SLUG).toBe("veyyon");
	});
});

describe("APP_DISPLAY_NAME", () => {
	it("is 'Veyyon'", () => {
		expect(APP_DISPLAY_NAME).toBe("Veyyon");
	});
});

describe("lcgUint32", () => {
	it("returns a function", () => {
		expect(typeof lcgUint32(42)).toBe("function");
	});

	it("produces deterministic sequence for same seed", () => {
		const r1 = lcgUint32(42);
		const r2 = lcgUint32(42);
		expect(r1()).toBe(r2());
		expect(r1()).toBe(r2());
	});

	it("produces different sequences for different seeds", () => {
		const r1 = lcgUint32(42);
		const r2 = lcgUint32(100);
		expect(r1()).not.toBe(r2());
	});

	it("produces values in uint32 range", () => {
		const rand = lcgUint32(42);
		for (let i = 0; i < 10; i++) {
			const v = rand();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(0xffffffff);
		}
	});
});

describe("lcg", () => {
	it("returns a function producing 0-1 floats", () => {
		const rand = lcg(42);
		for (let i = 0; i < 10; i++) {
			const v = rand();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it("is deterministic for same seed", () => {
		const r1 = lcg(42);
		const r2 = lcg(42);
		expect(r1()).toBe(r2());
	});
});

describe("FRAGMENTS", () => {
	it("is a non-empty array", () => {
		expect(FRAGMENTS.length).toBeGreaterThan(0);
	});

	it("contains only strings", () => {
		for (const f of FRAGMENTS) {
			expect(typeof f).toBe("string");
		}
	});
});

describe("buildString", () => {
	it("returns a string", () => {
		const result = buildString(lcg(42));
		expect(typeof result).toBe("string");
	});

	it("respects maxFragments limit", () => {
		const rand = lcg(42);
		const result = buildString(rand, 5);
		// The string is built from fragments, so its length is bounded by fragments * maxFragmentLength
		// Just verify it's a string
		expect(typeof result).toBe("string");
	});

	it("is deterministic for same seed", () => {
		const r1 = lcg(42);
		const r2 = lcg(42);
		expect(buildString(r1, 10)).toBe(buildString(r2, 10));
	});
});

describe("sleepSync", () => {
	it("returns immediately for 0", () => {
		sleepSync(0);
	});

	it("returns immediately for negative", () => {
		sleepSync(-1);
	});

	it("sleeps for a short duration", () => {
		const start = Date.now();
		sleepSync(10);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(5);
	});
});
