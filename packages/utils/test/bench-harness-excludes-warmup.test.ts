/**
 * The bench harness must not time its warmup, and must say how much it skipped.
 *
 * WHY THIS SUITE EXISTS. `makeBench` used to time the FIRST iteration along with the rest, so every figure
 * any bench in this repository published included JIT tier-up. That is not a rounding error where these
 * benches are aimed: at functions costing hundreds of nanoseconds, a few hundred microseconds of warmup is
 * a large fraction of the whole run, and it was enough to make the same native-versus-TypeScript comparison
 * read one way in one bench script and the opposite way in another.
 *
 * A benchmark's own arithmetic is the last place a difference should be allowed to hide, which is why the
 * loop is tested rather than trusted. The warmup is checked by COUNTING calls, since counting is the only
 * way to state "these iterations happened and were not measured" without asserting on wall-clock timing,
 * which no test should do.
 *
 * The printed count is part of the contract too: two numbers being compared are only comparable if a reader
 * can see what was excluded from each, and a warmup that ran silently would be the same measurement lie in
 * a new place.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { defaultWarmup, makeBench } from "@veyyon/utils/bench-harness";

/** Run a bench with `console.log` captured, returning the call count and the printed line. */
function runBench(iterations: number, options?: { warmup?: number }): { calls: number; line: string; elapsed: number } {
	let calls = 0;
	const lines: string[] = [];
	const logSpy = spyOn(console, "log").mockImplementation((message?: unknown) => {
		lines.push(String(message));
	});
	try {
		const bench = makeBench(iterations, options ?? {});
		const elapsed = bench("subject", () => {
			calls += 1;
		});
		return { calls, line: lines.join("\n"), elapsed };
	} finally {
		logSpy.mockRestore();
	}
}

describe("the warmup runs and is not counted as an iteration", () => {
	/**
	 * The regression this suite exists for. The function is called `iterations + warmup` times, and the
	 * per-op figure divides by `iterations` alone: a warmup folded into the divisor would understate the
	 * per-operation cost instead of excluding the cold call, which is a different lie rather than a fix.
	 */
	it("calls the function once per iteration plus once per warmup", () => {
		const { calls } = runBench(100, { warmup: 7 });

		expect(calls).toBe(107);
	});

	/** An explicit zero is honoured, because a caller measuring cold-start cost is measuring something real. */
	it("runs no warmup when asked for none", () => {
		const { calls } = runBench(50, { warmup: 0 });

		expect(calls).toBe(50);
	});

	/** A negative or fractional count cannot produce a fractional loop, so it is floored at a whole number. */
	it.each([
		[-5, 50],
		[3.7, 53],
	])("treats a warmup of %p as %p total calls", (warmup, expected) => {
		const { calls } = runBench(50, { warmup });

		expect(calls).toBe(expected);
	});
});

describe("the default warmup", () => {
	/**
	 * A tenth of the iterations, which is enough for the JIT to tier up a small function without spending
	 * most of a large run warming up.
	 */
	it("is a tenth of the iterations", () => {
		expect(defaultWarmup(2000)).toBe(200);
		expect(defaultWarmup(100)).toBe(10);
	});

	/** At least one, so even a single-iteration bench never times a genuinely cold first call. */
	it.each([1, 5, 9])("is at least one warmup for %p iterations", iterations => {
		expect(defaultWarmup(iterations)).toBe(1);
	});

	/**
	 * And at most a thousand, so a million-iteration bench does not spend a tenth of its time in a warmup
	 * that stopped buying anything after the first few hundred calls.
	 */
	it("is capped at a thousand", () => {
		expect(defaultWarmup(1_000_000)).toBe(1000);
		expect(defaultWarmup(10_000)).toBe(1000);
	});

	/** The default is what `makeBench` actually applies, not merely what the helper reports. */
	it("is what makeBench applies when no warmup is given", () => {
		const { calls } = runBench(200);

		expect(calls).toBe(200 + defaultWarmup(200));
	});
});

describe("the reported line", () => {
	/**
	 * The warmup count is printed, because a reader comparing two figures has to know what was excluded from
	 * each. `docs/internal/porting-to-natives.md` quotes this exact shape, so a format change has to update
	 * that page in the same commit.
	 */
	it("names the iteration total, the per-op cost and the warmup", () => {
		const { line } = runBench(100, { warmup: 7 });

		expect(line).toMatch(/^subject: \d+\.\d{2}ms total \(\d+\.\d{6}ms\/op, 7 warmup\)$/);
	});

	/** A zero warmup is printed as zero rather than omitted: absent and none must not look alike. */
	it("says zero rather than leaving the warmup out", () => {
		const { line } = runBench(10, { warmup: 0 });

		expect(line).toContain("0 warmup");
	});

	/**
	 * The return value stays the total elapsed milliseconds, which is what every caller divides to get a
	 * ratio between two runs. Asserted as a finite non-negative number rather than against a duration,
	 * because a test that asserts on wall-clock time is a test that fails on a loaded machine.
	 */
	it("returns the elapsed milliseconds of the timed loop", () => {
		const { elapsed } = runBench(100, { warmup: 5 });

		expect(Number.isFinite(elapsed)).toBe(true);
		expect(elapsed).toBeGreaterThanOrEqual(0);
	});
});
