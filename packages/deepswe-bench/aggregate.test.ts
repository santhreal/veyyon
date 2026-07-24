/**
 * Proves the bench's statistical aggregation. With --repeats > 1 a cell holds
 * several stochastic samples, and the whole point of repeating is to report a rate
 * with an honest uncertainty instead of a single lucky (or unlucky) pass/fail. The
 * bugs this suite locks out are the ones that would silently mislead every future
 * comparison: counting errored runs as failures (which drags a real pass rate
 * down), a wrong binomial standard-error formula (which makes noise look like
 * signal or hides a real gap), and a per-task table that shows only the first
 * sample of a repeated cell instead of aggregating them.
 */

import { describe, expect, test } from "bun:test";
import {
	type ArmResult,
	effectiveTemperature,
	jobNameOf,
	PINNED_TEMPERATURE,
	parseJobName,
	renderReport,
	selectTasks,
	summarizeCell,
	wilsonInterval,
} from "./aggregate";

/** Build an ArmResult with sane defaults, overriding only what a test cares about. */
function res(over: Partial<ArmResult>): ArmResult {
	return {
		arm: "a",
		task: "t",
		repeat: 0,
		reward: null,
		partial: null,
		f2p: null,
		p2p: null,
		inputTokens: null,
		outputTokens: null,
		cacheTokens: null,
		costUsd: null,
		agentSeconds: null,
		argotLoadCalls: null,
		assistantMsgsWithSigil: null,
		toolCalls: null,
		error: null,
		...over,
	};
}

describe("jobNameOf / parseJobName — the reaggregate round-trip", () => {
	// reaggregate rebuilds results from job-name strings alone, so a mismatch
	// between how a name is written and how it is read would silently file a
	// sample under the wrong task or repeat. These lock the two functions as exact
	// inverses across the shapes the bench actually produces.

	test("a single-sample run keeps the historic arm__task name (no suffix)", () => {
		// Backward compatibility: runs produced before --repeats existed have no
		// suffix and must still parse to repeat 0, or old runs stop reaggregating.
		expect(jobNameOf("full", "koota-query-predicates", 0, 1)).toBe("full__koota-query-predicates");
		expect(parseJobName("full__koota-query-predicates")).toEqual({
			arm: "full",
			task: "koota-query-predicates",
			repeat: 0,
		});
	});

	test("a repeated run appends __r<n> and parses it back to the repeat index", () => {
		expect(jobNameOf("baseline", "etree-xml-diff-patch", 2, 3)).toBe("baseline__etree-xml-diff-patch__r2");
		expect(parseJobName("baseline__etree-xml-diff-patch__r2")).toEqual({
			arm: "baseline",
			task: "etree-xml-diff-patch",
			repeat: 2,
		});
	});

	test("round-trips every cell of a small grid so no sample is misfiled", () => {
		for (const arm of ["baseline", "argot-setting-only", "candidate-argot-nudge"]) {
			for (const task of ["fastapi-implicit-head-options", "ytt-jsonpath-query-api"]) {
				for (const repeats of [1, 5]) {
					for (let repeat = 0; repeat < repeats; repeat++) {
						const name = jobNameOf(arm, task, repeat, repeats);
						expect(parseJobName(name)).toEqual({ arm, task, repeat: repeats > 1 ? repeat : 0 });
					}
				}
			}
		}
	});

	test("a two-digit repeat index (K > 9) still parses", () => {
		// The suffix regex is \d+, not a single digit; K=20 must not truncate r10.
		expect(parseJobName(jobNameOf("full", "some-task", 10, 20))).toEqual({
			arm: "full",
			task: "some-task",
			repeat: 10,
		});
	});
});

describe("selectTasks — a --limit subsample must be representative, not the alphabetical head", () => {
	// The bug this locks out: `sorted.slice(0, limit)`. DeepSWE task names are
	// repo-prefixed, so the first N cluster on one repo and a pass rate over them is
	// a biased estimate of the whole-suite rate. selectTasks must spread the picks
	// across the sorted range while staying fully deterministic (a limited run has to
	// stay reproducible and reaggregatable).

	const suite = Array.from({ length: 100 }, (_, i) => `task-${String(i).padStart(3, "0")}`);

	test("returns the whole set (a copy) when no limit is given", () => {
		const picked = selectTasks(suite, undefined);
		expect(picked).toEqual(suite);
		expect(picked).not.toBe(suite); // a copy, so callers can mutate without aliasing
	});

	test("returns the whole set when the limit meets or exceeds the size", () => {
		expect(selectTasks(suite, 100)).toEqual(suite);
		expect(selectTasks(suite, 1000)).toEqual(suite);
	});

	test("spans the whole range instead of clustering at the head (the anti-bias property)", () => {
		// slice(0,10) would return task-000..task-009 (all clustered). Even stride over
		// 100 tasks at limit 10 lands one pick per contiguous decile, so the last pick is
		// near the end of the suite, not the start.
		const picked = selectTasks(suite, 10);
		expect(picked).toEqual([
			"task-000",
			"task-010",
			"task-020",
			"task-030",
			"task-040",
			"task-050",
			"task-060",
			"task-070",
			"task-080",
			"task-090",
		]);
		// Concretely: this is NOT the biased head slice.
		expect(picked).not.toEqual(suite.slice(0, 10));
	});

	test("is deterministic: the same limit always selects the same tasks", () => {
		expect(selectTasks(suite, 7)).toEqual(selectTasks(suite, 7));
	});

	test("picks distinct, in-range tasks and never duplicates or overflows", () => {
		for (const limit of [1, 2, 3, 13, 37, 99]) {
			const picked = selectTasks(suite, limit);
			expect(picked).toHaveLength(limit);
			expect(new Set(picked).size).toBe(limit); // no repeats
			for (const t of picked) expect(suite).toContain(t); // every pick is a real task
		}
	});

	test("limit of zero or below selects nothing (guarded upstream, defended here)", () => {
		expect(selectTasks(suite, 0)).toEqual([]);
		expect(selectTasks(suite, -5)).toEqual([]);
	});
});

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

describe("summarizeCell — errors are excluded, not counted as failures", () => {
	test("an errored sample drops out of n and the rate, but is counted in errors", () => {
		// The bug: treating a container that never produced a trial as a task failure.
		// Two OK passes plus one error must read as rate 1.0 over n=2, with 1 error —
		// not rate 0.67 over 3. A dead container is missing data, not a wrong answer.
		const s = summarizeCell([res({ reward: 1 }), res({ reward: 1 }), res({ error: "boom" })]);
		expect(s.total).toBe(3);
		expect(s.errors).toBe(1);
		expect(s.n).toBe(2);
		expect(s.passRate).toBe(1);
	});

	test("an all-errored cell has n 0 and null rate/se, never a fake 0", () => {
		const s = summarizeCell([res({ error: "x" }), res({ error: "y" })]);
		expect(s.n).toBe(0);
		expect(s.passRate).toBeNull();
		expect(s.stdErr).toBeNull();
		expect(s.errors).toBe(2);
	});

	test("token and cost means are over OK samples only, but sums include what exists", () => {
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 100, costUsd: 0.2 }),
			res({ reward: 0, outputTokens: 200, costUsd: 0.4 }),
			res({ error: "x", outputTokens: null, costUsd: null }),
		]);
		expect(s.meanOutputTokens).toBe(150);
		expect(s.meanCostUsd).toBeCloseTo(0.3, 12);
		expect(s.sumOutputTokens).toBe(300);
		expect(s.sumCostUsd).toBeCloseTo(0.6, 12);
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
