/**
 * WHY THIS SUITE DEFENDS BINOMIAL UNCERTAINTY AND REGIME PINNING CONTRACTS.
 *
 * Normal standard errors collapse to ±0.00 at boundary rates (0% or 100% pass),
 * falsely claiming certainty. Wilson score intervals report honest uncertainty
 * bounds that reflect sample size, aggregate repeated cells accurately, and enforce
 * greedy temperature regime pinning to eliminate provider default drift.
 *
 * What this does not catch: systemic correlation between repeated trials from shared container state.
 */

import { describe, expect, test } from "bun:test";
import { effectiveTemperature, PINNED_TEMPERATURE } from "../../../suites/deep-swe/aggregate/merge";
import { renderReport } from "../../../suites/deep-swe/aggregate/report-render";
import { summarizeCell, wilsonInterval } from "../../../suites/deep-swe/aggregate/stats";
import type { ArmResult } from "../../../suites/deep-swe/aggregate/types";
import { res } from "./aggregate-test-helpers";

describe("summarizeCell — pass rate and standard error", () => {
	test("all passes gives rate 1 and zero standard error", () => {
		const s = summarizeCell([res({ reward: 1 }), res({ reward: 1 }), res({ reward: 1 })]);
		expect(s.n).toBe(3);
		expect(s.passes).toBe(3);
		expect(s.passRate).toBe(1);
		expect(s.stdErr).toBe(0);
	});

	test("half passes gives rate 0.5 and the exact binomial standard error", () => {
		// p=0.5, n=4 → se = sqrt(0.25/4) = 0.25. A wrong formula (e.g. dividing by
		// n-1, or forgetting the sqrt) would not land on this exact value.
		const s = summarizeCell([res({ reward: 1 }), res({ reward: 1 }), res({ reward: 0 }), res({ reward: 0 })]);
		expect(s.passRate).toBe(0.5);
		expect(s.stdErr).toBeCloseTo(0.25, 12);
	});

	test("a reward of 0.5 (partial credit) is NOT a pass", () => {
		// The pass rate is reward===1 exactly; partial credit must not inflate it.
		// Only the mean reward reflects the 0.5.
		const s = summarizeCell([res({ reward: 1 }), res({ reward: 0.5 })]);
		expect(s.passes).toBe(1);
		expect(s.passRate).toBe(0.5);
		expect(s.meanReward).toBeCloseTo(0.75, 12);
	});
});

describe("effectiveTemperature — the bench pins a stable regime and stamps overrides", () => {
	// Why this exists: the bench must run every arm at one fixed temperature so
	// --repeats measures a stable regime, and it must record the value so two runs
	// stay longitudinally comparable. The trap is veyyon's own default of -1 ("use the
	// provider default"), which can drift silently between runs; the bench treats any
	// negative/unset temperature as unpinned and substitutes PINNED_TEMPERATURE. An arm
	// that sets a real temperature (a deliberate temperature-as-IV experiment) keeps it.

	test("the pinned default is greedy (0), not the drifting provider default (-1)", () => {
		expect(PINNED_TEMPERATURE).toBe(0);
	});

	test("an arm that sets no temperature runs at the pinned default", () => {
		expect(effectiveTemperature({ argot: { enabled: false } })).toBe(0);
		expect(effectiveTemperature({})).toBe(0);
	});

	test("a config of -1 (provider default) is treated as unset and pinned, not passed through", () => {
		// This is the exact silent-drift value the pin exists to eliminate.
		expect(effectiveTemperature({ temperature: -1 })).toBe(0);
	});

	test("an explicit non-negative temperature is respected (a temperature-as-IV arm)", () => {
		expect(effectiveTemperature({ temperature: 0.7 })).toBe(0.7);
		expect(effectiveTemperature({ temperature: 0 })).toBe(0);
		expect(effectiveTemperature({ temperature: 1 })).toBe(1);
	});

	test("a non-number or non-finite temperature falls back to the pin, never NaN", () => {
		expect(effectiveTemperature({ temperature: "hot" })).toBe(0);
		expect(effectiveTemperature({ temperature: Number.NaN })).toBe(0);
		expect(effectiveTemperature(null)).toBe(0);
		expect(effectiveTemperature(undefined)).toBe(0);
	});

	test("the pinned default is a parameter, so a caller can pin a different regime", () => {
		expect(effectiveTemperature({}, 0.2)).toBe(0.2);
		expect(effectiveTemperature({ temperature: 0.9 }, 0.2)).toBe(0.9);
	});
});

describe("wilsonInterval — honest uncertainty at the boundary the normal SE hides", () => {
	// Why this exists: with --repeats small, an all-pass or all-fail cell is common,
	// and the normal-approximation standard error sqrt(p(1-p)/n) is exactly 0 there,
	// so a `3/3` cell would render `1.00 ±0.00` and read as certainty. The Wilson
	// interval keeps real width in exactly that regime. These lock the boundary
	// behavior and the closed-form values so a future refactor cannot silently swap
	// back to the degenerate SE or mis-transcribe the formula.

	test("an all-pass cell (3/3) is NOT [1,1] — it stays honestly wide", () => {
		const { low, high } = wilsonInterval(3, 3);
		expect(high).toBe(1); // upper bound clamps at 1
		expect(low).toBeLessThan(1); // but the lower bound is well below 1
		// Closed-form Wilson lower bound for 3/3 at z=1.959963984540054.
		expect(low).toBeCloseTo(0.4385, 3);
	});

	test("an all-fail cell (0/4) is NOT [0,0] — the upper bound admits real doubt", () => {
		const { low, high } = wilsonInterval(0, 4);
		expect(low).toBe(0); // lower bound clamps at 0
		expect(high).toBeGreaterThan(0);
		expect(high).toBeCloseTo(0.4899, 3);
	});

	test("a balanced cell (2/4) is centered near 0.5 and symmetric about it", () => {
		const { low, high } = wilsonInterval(2, 4);
		// p=0.5 is a fixed point of the Wilson center, so the interval is symmetric.
		expect((low as number) + (high as number)).toBeCloseTo(1, 12);
		expect(low).toBeCloseTo(0.1502, 3);
		expect(high).toBeCloseTo(0.8498, 3);
	});

	test("the interval tightens as n grows for the same proportion", () => {
		const small = wilsonInterval(5, 10);
		const large = wilsonInterval(50, 100);
		const widthSmall = (small.high as number) - (small.low as number);
		const widthLarge = (large.high as number) - (large.low as number);
		expect(widthLarge).toBeLessThan(widthSmall);
	});

	test("n of 0 yields null bounds, never a fake [0,0]", () => {
		expect(wilsonInterval(0, 0)).toEqual({ low: null, high: null });
	});
});

describe("renderReport — the pass cell shows the Wilson interval, not ±se", () => {
	// The visible contract: the report must print the honest interval. A regression
	// to the old ` ±0.00` string on an all-pass cell is exactly the false-certainty
	// bug this guards, so assert both that the interval renders and that the
	// degenerate ` ±0.00` is gone.
	const STAMP = "2026-07-23T00:00:00.000Z";

	test("a 3/3 cell renders `[..–1.00]`, not `±0.00`", () => {
		const results: ArmResult[] = [
			res({ arm: "full", task: "t1", repeat: 0, reward: 1 }),
			res({ arm: "full", task: "t1", repeat: 1, reward: 1 }),
			res({ arm: "full", task: "t1", repeat: 2, reward: 1 }),
		];
		const report = renderReport(results, "m", STAMP, 3);
		expect(report).toContain("1.00 [0.44–1.00] (3/3)");
		expect(report).not.toContain("±0.00");
		expect(report).not.toContain("±");
	});
});

describe("renderReport — aggregates repeated cells rather than showing one sample", () => {
	const STAMP = "2026-07-23T00:00:00.000Z";

	function summaryFor(report: string): void {
		expect(report).toContain("Repeats/cell: 3");
	}

	test("a 3-repeat cell renders its pass rate, not just the first run", () => {
		// The old per-task table used results.find(), which returned only the first
		// sample of a cell and silently ignored the other repeats. This asserts all
		// three are folded into one rate. Two passes of three → 0.67 (2/3).
		const results: ArmResult[] = [
			res({ arm: "full", task: "t1", repeat: 0, reward: 1, outputTokens: 100, costUsd: 0.1 }),
			res({ arm: "full", task: "t1", repeat: 1, reward: 0, outputTokens: 100, costUsd: 0.1 }),
			res({ arm: "full", task: "t1", repeat: 2, reward: 1, outputTokens: 100, costUsd: 0.1 }),
		];
		const report = renderReport(results, "google-antigravity/gemini-3.6-flash", STAMP, 3);
		summaryFor(report);
		// The cell shows the aggregated rate with its (passes/n) tally.
		expect(report).toContain("0.67");
		expect(report).toContain("(2/3)");
		// Header states the model and the repeat count so the run is self-describing.
		expect(report).toContain("google-antigravity/gemini-3.6-flash");
	});

	test("an all-errored task cell renders ERR, and the header still names the repeat count", () => {
		const results: ArmResult[] = [
			res({ arm: "full", task: "t1", repeat: 0, error: "boom" }),
			res({ arm: "full", task: "t1", repeat: 1, error: "boom" }),
			res({ arm: "full", task: "t1", repeat: 2, error: "boom" }),
		];
		const report = renderReport(results, "m", STAMP, 3);
		summaryFor(report);
		expect(report).toContain("| t1 | ERR |");
	});
});
