import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapWithConcurrencyLimit, normalizeConcurrencyLimit } from "@veyyon/coding-agent/task/parallel";

/**
 * `mapWithConcurrencyLimit` is the single owner of veyyon's bounded worker pool.
 * The commit map-reduce phase used to hand-roll its own copy, whose `Math.min`
 * limit math silently diverged: `maxConcurrency = 0` spawned ZERO workers (every
 * result left an undefined hole that later crashed the reduce phase), and a
 * negative limit threw `RangeError: Invalid array length`. Both were reachable
 * from the unbounded `commit.mapReduceMaxConcurrency` setting. The copy was
 * deleted in favor of this owner, which follows the shared
 * `task.maxConcurrency = 0` = "Unlimited" convention. These tests pin that
 * normalization so the owner cannot regress the behavior the map phase relies on,
 * and lock the map phase to the owner so a second pool cannot reappear.
 */

describe("mapWithConcurrencyLimit result contract", () => {
	it("preserves input order in the results array regardless of completion order", async () => {
		const { results, aborted } = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async n => n * 10);
		expect(results).toEqual([10, 20, 30, 40, 50]);
		expect(aborted).toBe(false);
	});

	it("returns an empty result set for empty input without invoking the worker", async () => {
		let calls = 0;
		const { results } = await mapWithConcurrencyLimit<number, number>([], 4, async n => {
			calls += 1;
			return n;
		});
		expect(results).toEqual([]);
		expect(calls).toBe(0);
	});
});

describe("mapWithConcurrencyLimit limit normalization", () => {
	it("fills every slot with no undefined holes when the limit is 0 (unbounded)", async () => {
		const items = Array.from({ length: 8 }, (_, i) => i);
		const { results } = await mapWithConcurrencyLimit(items, 0, async n => `v${n}`);
		expect(results).toEqual(items.map(n => `v${n}`));
		expect(results.some(r => r === undefined)).toBe(false);
	});

	it("treats a negative limit as unbounded instead of throwing RangeError", async () => {
		const items = [0, 1, 2, 3];
		const { results } = await mapWithConcurrencyLimit(items, -5, async n => n);
		expect(results).toEqual([0, 1, 2, 3]);
	});

	it("treats a non-finite (NaN) limit as unbounded", async () => {
		const items = [0, 1, 2];
		const { results } = await mapWithConcurrencyLimit(items, Number.NaN, async n => n);
		expect(results).toEqual([0, 1, 2]);
	});
});

describe("mapWithConcurrencyLimit in-flight bound", () => {
	it("never exceeds a positive limit and does parallelize up to it", async () => {
		let active = 0;
		let peak = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);
		await mapWithConcurrencyLimit(items, 3, async () => {
			active += 1;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active -= 1;
		});
		// Three workers each grab an item synchronously before the first sleep
		// yields, so the peak is exactly the requested ceiling.
		expect(peak).toBe(3);
	});

	it("runs every item at once when unbounded (peak in-flight equals item count)", async () => {
		let active = 0;
		let peak = 0;
		const items = Array.from({ length: 6 }, (_, i) => i);
		await mapWithConcurrencyLimit(items, 0, async () => {
			active += 1;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active -= 1;
		});
		expect(peak).toBe(6);
	});
});

describe("mapWithConcurrencyLimit failure propagation", () => {
	it("fails fast and rejects when a worker throws with no abort signal", async () => {
		await expect(
			mapWithConcurrencyLimit([1, 2, 3], 2, async n => {
				if (n === 2) throw new Error("boom");
				return n;
			}),
		).rejects.toThrow("boom");
	});
});

/**
 * `normalizeConcurrencyLimit` is the pure clamp behind the `task.maxConcurrency = 0` = "Unlimited"
 * convention (settings issue #3305). It is consumed by `Semaphore`'s constructor/`resize`, where the
 * returned 0 is turned into `Number.POSITIVE_INFINITY` (unbounded). The `Semaphore` suites exercise it
 * only indirectly through positive caps, so its normalization edges had no direct assertion. The
 * subtle contract: a positive value is truncated toward zero (5.9 -> 5), and EVERYTHING that is not a
 * finite positive integer collapses to 0 = unbounded — including `Infinity`, which is not "the largest
 * cap" but the sentinel for no cap. A regression that let `Infinity` fall through as a finite ceiling,
 * or that rounded 5.9 up to 6, would silently change how many workers run.
 */
describe("normalizeConcurrencyLimit", () => {
	it("passes a positive integer through unchanged", () => {
		expect(normalizeConcurrencyLimit(1)).toBe(1);
		expect(normalizeConcurrencyLimit(5)).toBe(5);
		expect(normalizeConcurrencyLimit(1_000_000_000)).toBe(1_000_000_000);
	});

	it("truncates a positive fraction toward zero rather than rounding up", () => {
		expect(normalizeConcurrencyLimit(5.9)).toBe(5);
		expect(normalizeConcurrencyLimit(2.0001)).toBe(2);
	});

	it("collapses zero and negatives to 0 (unbounded)", () => {
		expect(normalizeConcurrencyLimit(0)).toBe(0);
		expect(normalizeConcurrencyLimit(-3)).toBe(0);
		expect(normalizeConcurrencyLimit(-0.5)).toBe(0);
	});

	it("collapses every non-finite input to 0, so Infinity means unbounded, not a huge cap", () => {
		expect(normalizeConcurrencyLimit(Number.NaN)).toBe(0);
		expect(normalizeConcurrencyLimit(Number.POSITIVE_INFINITY)).toBe(0);
		expect(normalizeConcurrencyLimit(Number.NEGATIVE_INFINITY)).toBe(0);
	});
});

describe("map-phase single-owner lock", () => {
	it("delegates to the shared pool and no longer hand-rolls its own worker loop", () => {
		const src = readFileSync(join(import.meta.dir, "..", "..", "src/commit/map-reduce/map-phase.ts"), "utf8");
		expect(src).toContain("mapWithConcurrencyLimit");
		expect(src).not.toContain("function runWithConcurrency");
	});
});
