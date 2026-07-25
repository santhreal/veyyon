/**
 * The autoresearch loop renders a percent change against a baseline in ONE place.
 *
 * WHY THIS SUITE EXISTS. The computation and its three guards were written out five times: three
 * in `dashboard.ts` (the best-run line, the secondary-metric cell, the secondary-metric summary)
 * and twice in `tools/log-experiment.ts` (the run report and its secondary metrics). Five copies of
 * `((value - baseline) / baseline) * 100`, five copies of `delta > 0 ? "+" : ""`, five copies of
 * `toFixed(1)`, and five hand-written checks for the cases where a delta must not be shown at all.
 * The dashboard the operator watches and the tool report the model reads were two places to change
 * one format, and they were one edit away from disagreeing.
 *
 * `formatPercentChange` owns it now. These tests pin the format and — more importantly — the three
 * NON-answers, because that is where copies drift: a missing baseline, a zero baseline (the division
 * has no meaning), and a value equal to its baseline (`+0.0%` beside an unchanged number is noise).
 * The rendered lines are asserted as exact strings too, since "delegates to the owner" is only worth
 * anything if the bytes the operator sees are unchanged.
 */

import { describe, expect, it } from "bun:test";
import { formatNum, formatPercentChange } from "@veyyon/coding-agent/autoresearch/helpers";

describe("formatPercentChange", () => {
	it("signs an improvement explicitly", () => {
		// The `+` is deliberate: the reader is comparing runs, and a bare `12.3%` beside a
		// metric reads as the metric's own percentage rather than a change in it.
		expect(formatPercentChange(112.3, 100)).toBe("+12.3%");
		expect(formatPercentChange(200, 100)).toBe("+100.0%");
	});

	it("carries the sign of a regression without adding one", () => {
		expect(formatPercentChange(96, 100)).toBe("-4.0%");
		expect(formatPercentChange(0, 100)).toBe("-100.0%");
	});

	it("says nothing when there is no baseline to compare against", () => {
		// The first run of a segment has no baseline, and both `null` and `undefined`
		// arrive in practice: the dashboard holds `number | undefined` for a secondary
		// metric and `number | null` for the primary.
		expect(formatPercentChange(42, undefined)).toBeUndefined();
		expect(formatPercentChange(42, null)).toBeUndefined();
	});

	it("says nothing when the baseline is zero, because the division has no meaning", () => {
		// A zero baseline would render `Infinity%` or `NaN%`. Each of the five copies
		// guarded this by hand, which is exactly the kind of guard a sixth copy forgets.
		expect(formatPercentChange(42, 0)).toBeUndefined();
		expect(formatPercentChange(0, 0)).toBeUndefined();
	});

	it("says nothing when the value equals its baseline", () => {
		// `+0.0%` next to an unchanged number is noise on a line the operator scans.
		expect(formatPercentChange(100, 100)).toBeUndefined();
		expect(formatPercentChange(-3.5, -3.5)).toBeUndefined();
	});

	it("handles a negative baseline without inverting the direction", () => {
		// A metric can be negative (a loss, a delta-from-target). Going from -100 to -50
		// is an increase in the value, and the sign must describe the value's movement
		// rather than its magnitude.
		expect(formatPercentChange(-50, -100)).toBe("-50.0%");
		expect(formatPercentChange(-150, -100)).toBe("+50.0%");
	});

	it("keeps one decimal place, rounding as the float lands", () => {
		// One decimal is the format every one of the five copies used, so this is what
		// keeps the rendered lines byte-identical after the unification.
		expect(formatPercentChange(100.05, 100)).toBe("+0.0%");
		expect(formatPercentChange(100.06, 100)).toBe("+0.1%");
		expect(formatPercentChange(133.333, 100)).toBe("+33.3%");
	});

	it("renders a change far larger than the baseline in full, without clamping", () => {
		// An early autoresearch run can improve a metric by orders of magnitude. Clamping
		// would hide the result the loop exists to find.
		expect(formatPercentChange(10_000, 100)).toBe("+9900.0%");
	});
});

describe("the lines the five call sites build from it", () => {
	/** The dashboard's secondary-metric cell: `formatNum` then the change, space-separated. */
	function secondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
		if (value === undefined) return "-";
		const formatted = formatNum(value, unit);
		const change = formatPercentChange(value, baseline);
		return change ? `${formatted} ${change}` : formatted;
	}

	/** The log-experiment report's secondary-metric part: the change in parentheses. */
	function reportPart(name: string, value: number, unit: string, baseline: number | undefined): string {
		const change = formatPercentChange(value, baseline);
		return change ? `${name}: ${formatNum(value, unit)} (${change})` : `${name}: ${formatNum(value, unit)}`;
	}

	it("renders the dashboard cell exactly as it did before the unification", () => {
		expect(secondaryCell(112.5, "ms", 100)).toBe("112.50ms +12.5%");
		expect(secondaryCell(100, "ms", 100)).toBe("100ms");
		expect(secondaryCell(100, "ms", undefined)).toBe("100ms");
		expect(secondaryCell(100, "ms", 0)).toBe("100ms");
		expect(secondaryCell(undefined, "ms", 100)).toBe("-");
	});

	it("renders the tool report part exactly as it did before, with the change in parentheses", () => {
		// Two surfaces, one format, different punctuation around it — which is the reason
		// the owner returns the change alone and leaves the framing to the caller.
		expect(reportPart("latency", 96, "ms", 100)).toBe("latency: 96ms (-4.0%)");
		expect(reportPart("latency", 100, "ms", 100)).toBe("latency: 100ms");
		expect(reportPart("latency", 96, "ms", undefined)).toBe("latency: 96ms");
	});

	it("keeps the unit attached to the number and away from the change", () => {
		// A regression worth pinning: `formatNum` appends the unit, so a caller that
		// concatenated in the wrong order would produce `96 -4.0%ms`.
		expect(reportPart("throughput", 1_250, "/s", 1_000)).toBe("throughput: 1,250/s (+25.0%)");
	});
});
