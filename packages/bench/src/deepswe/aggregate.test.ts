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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARGOT_PREAMBLE, renderPreamble } from "argot";
import {
	ARGOT_PREAMBLE_HEADING,
	type ArmResult,
	blockContainsSigil,
	ceilingBelowNoise,
	classifyError,
	collectEmittedText,
	costIsUnpriced,
	effectiveTemperature,
	efficiencyDeltaAttribution,
	emptyArmResult,
	encodeHeadroom,
	finishedWithoutPatch,
	fmtCost,
	holmBonferroni,
	interpretEncodeArm,
	isAgentTimeout,
	isHardError,
	jobNameOf,
	mostCommonAgentReason,
	NO_REWARD_ERROR,
	noRewardError,
	OBSERVED_TYPEABLE_EMISSION_RATE,
	PINNED_TEMPERATURE,
	pairwiseArmDeltas,
	pairwiseMetricDeltas,
	parseJobName,
	parseTaskListProvenance,
	providerFinishReason,
	providerQuotaStop,
	quotaStopMarker,
	relativeSpreadPct,
	renderQuotaTruncationBanner,
	renderReport,
	renderTaskSetProvenanceBanner,
	rewardDeltaAttribution,
	selectTasks,
	shouldTripCanary,
	signTestPValue,
	summarizeCell,
	sweepCanReachSignificance,
	systemPromptTeachesArgot,
	TIMEOUT_UNATTRIBUTABLE_VERDICT,
	tallyUsage,
	timeoutAttributionBanner,
	timeoutRate,
	typeableHandleMass,
	wilsonInterval,
	withinTaskSpreadPct,
} from "./aggregate";

/**
 * Build an ArmResult with sane defaults, overriding only what a test cares about.
 *
 * Built from the same `emptyArmResult` the runner uses, deliberately. A private
 * copy of the blank shape would let the fixture keep a field the production
 * factory had dropped, so the suite would still exercise data the real pipeline
 * no longer produces.
 */
function res(over: Partial<ArmResult>): ArmResult {
	return { ...emptyArmResult("a", "t", 0), ...over };
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

describe("signTestPValue — exact two-sided sign test for a paired arm comparison", () => {
	// Why this exists: the honest arm-vs-arm verdict must use the paired structure
	// (both arms ran the same tasks) and must not understate uncertainty at small
	// task counts. The exact sign test does both. These pin the exact closed-form
	// probabilities so a refactor cannot silently swap in a normal approximation
	// (which would call a 5-0 sweep "significant" when it is not) or misbuild the CDF.

	test("no decisive tasks (all ties) is no evidence — p = 1", () => {
		expect(signTestPValue(0, 0)).toBe(1);
	});

	test("a 5-0 sweep is NOT significant at 0.05 (exact p = 0.0625)", () => {
		// The classic small-sample trap: five straight wins looks decisive but the
		// exact two-sided sign test says p=2*(1/2)^5=0.0625. A normal approximation
		// would wrongly cross 0.05 here.
		expect(signTestPValue(5, 0)).toBeCloseTo(0.0625, 12);
	});

	test("a 6-0 sweep clears 0.05 (exact p = 0.03125)", () => {
		expect(signTestPValue(6, 0)).toBeCloseTo(0.03125, 12);
	});

	test("an 8-1 split is significant (exact p = 0.0390625)", () => {
		expect(signTestPValue(8, 1)).toBeCloseTo(0.0390625, 12);
	});

	test("an even split is maximally inconclusive — p = 1", () => {
		expect(signTestPValue(3, 3)).toBe(1);
	});

	test("is symmetric in wins and losses (direction does not change the p-value)", () => {
		for (const [w, l] of [
			[7, 2],
			[10, 4],
			[1, 9],
		]) {
			expect(signTestPValue(w as number, l as number)).toBeCloseTo(signTestPValue(l as number, w as number), 12);
		}
	});

	test("stays numerically sane at a large, lopsided task count (no overflow)", () => {
		// 100 tasks, 100-0: 2 * 0.5^100, a tiny but finite, positive probability.
		const p = signTestPValue(100, 0);
		expect(p).toBeGreaterThan(0);
		expect(p).toBeLessThan(1e-29);
		expect(Number.isFinite(p)).toBe(true);
	});
});

describe("pairwiseArmDeltas — arms are compared PAIRED by task, not by overlapping intervals", () => {
	// Why this exists: comparing two arms' independent Wilson intervals ignores that
	// both ran the same tasks, where task difficulty is the dominant variance. Pairing
	// by task removes it. These lock the paired bookkeeping: only tasks with OK samples
	// in BOTH arms are paired, the delta is B minus A, and wins/losses/ties feed the
	// sign test.

	test("pairs only tasks both arms ran, and reports B-minus-A per-task deltas", () => {
		const results: ArmResult[] = [
			// t1: A fails, B passes (a win for B). t2: A fails, B passes (win).
			// t3: both pass (tie). t4: B errored, so the pair is dropped entirely.
			res({ arm: "A", task: "t1", reward: 0 }),
			res({ arm: "B", task: "t1", reward: 1 }),
			res({ arm: "A", task: "t2", reward: 0 }),
			res({ arm: "B", task: "t2", reward: 1 }),
			res({ arm: "A", task: "t3", reward: 1 }),
			res({ arm: "B", task: "t3", reward: 1 }),
			res({ arm: "A", task: "t4", reward: 1 }),
			res({ arm: "B", task: "t4", error: "boom" }), // B has no OK sample on t4
		];
		const [d] = pairwiseArmDeltas(results);
		expect(d?.armA).toBe("A");
		expect(d?.armB).toBe("B");
		expect(d?.nTasks).toBe(3); // t4 excluded — unpaired
		expect(d?.wins).toBe(2);
		expect(d?.losses).toBe(0);
		expect(d?.ties).toBe(1);
		expect(d?.meanDelta).toBeCloseTo((1 + 1 + 0) / 3, 12);
		// The CI brackets the mean and, with only 3 tasks, is wide.
		expect(d?.ciLow).not.toBeNull();
		expect(d?.ciLow as number).toBeLessThan(d?.meanDelta as number);
		expect(d?.ciHigh as number).toBeGreaterThan(d?.meanDelta as number);
		// 2-0 is not significant (exact sign-test p = 0.5), so the report must NOT
		// crown a winner off two lucky tasks.
		expect(d?.signTestP).toBeCloseTo(0.5, 12);
	});

	test("with repeats, a per-task delta uses each arm's aggregated pass rate, not one sample", () => {
		// A on t1: 1 of 2 passes → 0.5. B on t1: 2 of 2 → 1.0. Delta = +0.5.
		const results: ArmResult[] = [
			res({ arm: "A", task: "t1", repeat: 0, reward: 1 }),
			res({ arm: "A", task: "t1", repeat: 1, reward: 0 }),
			res({ arm: "B", task: "t1", repeat: 0, reward: 1 }),
			res({ arm: "B", task: "t1", repeat: 1, reward: 1 }),
		];
		const [d] = pairwiseArmDeltas(results);
		expect(d?.nTasks).toBe(1);
		expect(d?.meanDelta).toBeCloseTo(0.5, 12);
		expect(d?.wins).toBe(1);
		expect(d?.ciLow).toBeNull(); // nTasks < 2: no spread to estimate
	});

	test("every unordered arm pair is compared, in first-seen order", () => {
		const results: ArmResult[] = [
			res({ arm: "baseline", task: "t1", reward: 0 }),
			res({ arm: "cand1", task: "t1", reward: 1 }),
			res({ arm: "cand2", task: "t1", reward: 1 }),
		];
		const pairs = pairwiseArmDeltas(results).map(d => `${d.armA}->${d.armB}`);
		expect(pairs).toEqual(["baseline->cand1", "baseline->cand2", "cand1->cand2"]);
	});

	test("no pair has a null-crowned winner when all tasks are unpaired", () => {
		const results: ArmResult[] = [
			res({ arm: "A", task: "t1", reward: 1 }),
			res({ arm: "B", task: "t1", error: "x" }),
		];
		const [d] = pairwiseArmDeltas(results);
		expect(d?.nTasks).toBe(0);
		expect(d?.meanDelta).toBeNull();
		expect(d?.signTestP).toBe(1);
	});
});

describe("pairwiseMetricDeltas — argot's real claim: fewer tokens, measured paired", () => {
	// Why this exists: argot's promise is FEWER output tokens at equal reward, so the
	// eval must compare a cost metric paired by task, not just pass rate. These lock
	// the direction (B cheaper => negative delta), the paired unit rule, and that a
	// metric-null cell drops the task from the pair.

	test("B cheaper than A yields a negative mean delta and counts as a 'neg' task", () => {
		// t1: A=200 tok, B=100 tok → delta -100. t2: A=300, B=150 → -150.
		const results: ArmResult[] = [
			res({ arm: "A", task: "t1", reward: 1, outputTokens: 200 }),
			res({ arm: "B", task: "t1", reward: 1, outputTokens: 100 }),
			res({ arm: "A", task: "t2", reward: 1, outputTokens: 300 }),
			res({ arm: "B", task: "t2", reward: 1, outputTokens: 150 }),
		];
		const [d] = pairwiseMetricDeltas(results, c => c.meanOutputTokens);
		expect(d?.nTasks).toBe(2);
		expect(d?.meanDelta).toBeCloseTo(-125, 6); // (-100 + -150) / 2
		expect(d?.neg).toBe(2); // B < A on both tasks
		expect(d?.pos).toBe(0);
	});

	test("a task with no cost datum in one arm is dropped from the pair", () => {
		const results: ArmResult[] = [
			res({ arm: "A", task: "t1", reward: 1, outputTokens: 200 }),
			res({ arm: "B", task: "t1", reward: 1, outputTokens: 100 }),
			res({ arm: "A", task: "t2", reward: 1, outputTokens: null }), // no token datum
			res({ arm: "B", task: "t2", reward: 1, outputTokens: 150 }),
		];
		const [d] = pairwiseMetricDeltas(results, c => c.meanOutputTokens);
		expect(d?.nTasks).toBe(1); // t2 unpaired
		expect(d?.meanDelta).toBeCloseTo(-100, 6);
	});

	test("cost metric works the same way (fractional deltas)", () => {
		const results: ArmResult[] = [
			res({ arm: "A", task: "t1", reward: 1, costUsd: 0.2 }),
			res({ arm: "B", task: "t1", reward: 1, costUsd: 0.15 }),
		];
		const [d] = pairwiseMetricDeltas(results, c => c.meanCostUsd);
		expect(d?.meanDelta).toBeCloseTo(-0.05, 9);
		expect(d?.neg).toBe(1);
	});
});

describe("renderReport — efficiency comparison and treatment-applied sections", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("a decisive token saving with reward held reads 'cheaper, reward held'", () => {
		// 6 tasks: both arms pass every task (reward held), B always uses fewer output
		// tokens → cost sign test p=0.03125, pass-rate guardrail not a loss.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("## Efficiency comparison (paired by task)");
		expect(report).toContain("full cheaper, reward held");
	});

	test("a token saving that came WITH a reward drop is flagged, not celebrated", () => {
		// B is cheaper on every task, but B also FAILS every task while A passes → the
		// pass-rate guardrail is a significant loss for B, so the verdict must warn.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 0, outputTokens: 800 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("full cheaper BUT reward dropped");
	});

	test("a partial-credit reward drop with an IDENTICAL binary pass rate still vetoes 'reward held'", () => {
		// The blind spot this locks out: both arms FAIL every task (reward never reaches 1,
		// so the binary pass rate is 0 for both and the pass-rate guardrail sees no loss),
		// but B scores a strictly lower fractional reward on every task (0.4 vs 0.8). Before
		// the continuous check the verdict would read "cheaper, reward held" — hiding a real
		// correctness regression behind the binarization. It must now read the drop.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 0.8, outputTokens: 1000 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 0.4, outputTokens: 800 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		// B is genuinely cheaper AND the binary pass rate is a 0-0 tie...
		expect(report).toContain("0.000"); // both arms' pass rate is 0 (never reward===1)
		// ...yet the continuous reward dropped 6-0, so the efficiency verdict must warn.
		expect(report).toContain("full cheaper BUT reward dropped");
	});

	test("an EQUAL partial-credit reward (0.8 vs 0.8) with a token saving reads 'cheaper, reward held'", () => {
		// The contrast case that proves the continuous check does not false-positive: both
		// arms fail binary (0.8 < 1) but score the SAME fractional reward every task, so the
		// reward sign test is all ties and the saving is a clean win.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 0.8, outputTokens: 1000 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 0.8, outputTokens: 800 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("full cheaper, reward held");
	});

	test("the continuous reward comparison section names the lower-reward arm", () => {
		// The guardrail's reward input must be operator-visible, not a hidden veto: the
		// report carries its own paired reward table so a reader sees WHY a saving was
		// rejected. B scores lower on every task → the section calls it out.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 0.8, outputTokens: 1000 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 0.4, outputTokens: 800 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("## Reward comparison — continuous partial credit (paired by task)");
		expect(report).toContain("full lower reward");
	});

	test("a metric the provider never reports reads 'not measured', not 'not distinguishable'", () => {
		// The real gemini/antigravity case: 82k output tokens but cost is 0 for every
		// sample (no pricing entry). A paired delta of all-zeros would render "not
		// distinguishable" — reading as "measured, found equal" when cost was never
		// measured. The guard must label the cost row explicitly while the output-token
		// row (which DOES carry signal) still produces a real verdict.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, costUsd: 0 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, costUsd: 0 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		// cost carried no signal → named as unmeasured with the precise "unpriced"
		// wording (coherent with the per-arm totals table), not a false "equal" verdict.
		expect(report).toContain(
			"| cost | — | — | — | — | — | — | — | not measured (cost unpriced — provider reported no price) |",
		);
		// output tokens DID carry signal → still a real efficiency verdict.
		expect(report).toContain("full cheaper, reward held");
	});

	test("the treatment-applied table shows encode fired (or did not)", () => {
		// full encoded on 2 of 2 runs (§ present); decode never encoded.
		const results: ArmResult[] = [
			res({ arm: "decode", task: "t1", reward: 1, argotLoadCalls: 0, assistantMsgsWithSigil: 0 }),
			res({ arm: "decode", task: "t2", reward: 1, argotLoadCalls: 0, assistantMsgsWithSigil: 0 }),
			res({ arm: "full", task: "t1", reward: 1, argotLoadCalls: 1, assistantMsgsWithSigil: 3 }),
			res({ arm: "full", task: "t2", reward: 1, argotLoadCalls: 2, assistantMsgsWithSigil: 5 }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("## Argot treatment applied? (per arm)");
		// full encoded on both runs; decode on neither.
		expect(report).toMatch(/\| full \| 2 \|.*\| 2\/2 \|/);
		expect(report).toMatch(/\| decode \| 2 \|.*\| 0\/2 \|/);
	});
});

describe("renderReport — the paired arm comparison section", () => {
	const STAMP = "2026-07-23T00:00:00.000Z";

	test("a decisive paired win (6-0) is called out with p<0.05; a 2-0 is not", () => {
		// Build two arms over 6 tasks where B wins every one → sign-test p = 0.03125.
		const decisive: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			decisive.push(res({ arm: "baseline", task: `t${i}`, reward: 0 }));
			decisive.push(res({ arm: "cand", task: `t${i}`, reward: 1 }));
		}
		const report = renderReport(decisive, "m", STAMP, 1);
		expect(report).toContain("## Arm comparison (paired by task)");
		expect(report).toContain("baseline → cand");
		// One arm pair → Holm leaves the p unchanged (×1), so 0.03125 stays decisive; the
		// verdict is now phrased against the Holm-adjusted p.
		expect(report).toContain("cand better (adj p<0.05)");
		expect(report).toContain("6-0-0");

		// Two tasks only → 2-0 → p=0.5 → not distinguishable.
		const weak: ArmResult[] = [
			res({ arm: "baseline", task: "t1", reward: 0 }),
			res({ arm: "cand", task: "t1", reward: 1 }),
			res({ arm: "baseline", task: "t2", reward: 0 }),
			res({ arm: "cand", task: "t2", reward: 1 }),
		];
		const weakReport = renderReport(weak, "m", STAMP, 1);
		expect(weakReport).toContain("not distinguishable");
		expect(weakReport).not.toContain("adj p<0.05");
	});

	test("a single-arm run has no comparison section", () => {
		const report = renderReport([res({ arm: "only", task: "t1", reward: 1 })], "m", STAMP, 1);
		expect(report).not.toContain("## Arm comparison");
	});

	test("multiple arm pairs are Holm-corrected: two individually-significant 6-0 wins both lose significance", () => {
		// The multiple-comparisons defect this locks out: a run with 3 arms tests 2
		// informative pairs. Here baseline fails every task while B and C pass every task
		// (B and C are identical, so B↔C is all ties and not a test). Each of baseline→B
		// and baseline→C is 6-0, raw sign-test p = 0.03125 — individually "significant".
		// But judging both at 0.05 inflates the family-wise false-positive rate, so Holm
		// multiplies the smaller by 2 → 0.0625 > 0.05 and BOTH must read not distinguishable.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			results.push(res({ arm: "baseline", task: `t${i}`, reward: 0 }));
			results.push(res({ arm: "b", task: `t${i}`, reward: 1 }));
			results.push(res({ arm: "c", task: `t${i}`, reward: 1 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		// Each pair really did go 6-0 (the raw signal is there)...
		expect(report).toContain("6-0-0");
		expect(report).toContain("0.031"); // raw sign-test p, individually significant
		// ...but after correcting for two comparisons, neither survives.
		expect(report).not.toContain("adj p<0.05");
		expect(report).toContain("not distinguishable");
	});
});

describe("holmBonferroni — family-wise error control across arm pairs", () => {
	// The correction that stops a multi-arm run from manufacturing a false winner: with
	// k arms and k(k-1)/2 pairs, judging each raw p at 0.05 lets the family-wise
	// false-positive rate climb toward 40% at 10 pairs. Holm adjusts each p so a single
	// 0.05 threshold controls that rate, and is uniformly more powerful than Bonferroni.

	test("an empty family returns an empty array", () => {
		expect(holmBonferroni([])).toEqual([]);
	});

	test("a single test is returned unchanged (multiplied by 1)", () => {
		// One arm pair is the common 2-arm case; there is nothing to correct for.
		expect(holmBonferroni([0.03125])).toEqual([0.03125]);
	});

	test("multiplies the smallest p by m, the next by m-1, aligned to input order", () => {
		// Ascending, well-separated ps so the step-down max never rebinds: sorted values
		// 0.01,0.02,0.04 over m=3 → 0.03, 0.04, 0.04. Input is already ascending here.
		const adj = holmBonferroni([0.01, 0.02, 0.04]);
		expect(adj[0]).toBeCloseTo(0.03, 12); // 0.01 * 3
		expect(adj[1]).toBeCloseTo(0.04, 12); // 0.02 * 2
		expect(adj[2]).toBeCloseTo(0.04, 12); // 0.04 * 1
	});

	test("preserves alignment to the ORIGINAL (unsorted) input order", () => {
		// The caller looks up each pair's adjusted p by index, so a wrong-order return
		// would attach the correction to the wrong arm pair. Input 0.04,0.01,0.02 must
		// map back to 0.04,0.03,0.04 at those exact positions.
		const adj = holmBonferroni([0.04, 0.01, 0.02]);
		expect(adj[0]).toBeCloseTo(0.04, 12); // the 0.04 (rank 3) → *1
		expect(adj[1]).toBeCloseTo(0.03, 12); // the 0.01 (rank 1) → *3
		expect(adj[2]).toBeCloseTo(0.04, 12); // the 0.02 (rank 2) → *2
	});

	test("enforces step-down monotonicity: a larger raw p never adjusts below a smaller one", () => {
		// 0.03*2 = 0.06 but 0.04*1 = 0.04 < 0.06. The running max must lift the second to
		// 0.06 so the corrected sequence is non-decreasing in rank, as Holm requires.
		const adj = holmBonferroni([0.03, 0.04]);
		expect(adj[0]).toBeCloseTo(0.06, 12);
		expect(adj[1]).toBeCloseTo(0.06, 12);
	});

	test("clamps every adjusted value to at most 1", () => {
		// 0.5 * 2 = 1.0 (clamped), and the monotone max keeps the larger raw p at 1 too.
		expect(holmBonferroni([0.5, 0.9])).toEqual([1, 1]);
	});

	test("the two-comparison threshold case: 0.03125 twice both cross above 0.05", () => {
		// The concrete render scenario above: two 6-0 pairs. Holm pushes both to 0.0625,
		// so a 0.05 cutoff correctly rejects both — no false winner from a 3-arm run.
		const adj = holmBonferroni([0.03125, 0.03125]);
		expect(adj[0]).toBeCloseTo(0.0625, 12);
		expect(adj[1]).toBeCloseTo(0.0625, 12);
		expect(adj.every(p => p >= 0.05)).toBe(true);
	});
});

describe("sweepCanReachSignificance — telling an underpowered null from a measured one", () => {
	// The defect this locks out: a "not distinguishable" verdict was printed the same
	// whether the run measured equality or simply lacked the tasks to detect ANY
	// difference. The exact sign test has a hard floor — below a minimum decisive-task
	// count no outcome, not even a clean sweep, can cross α=0.05 — and Holm raises that
	// floor further. This predicate answers "could a perfect sweep here ever be
	// significant?" so the report can label the truly-uninformative nulls.

	test("zero or negative decisive tasks can never reach significance", () => {
		// No informative (non-tie) tasks means no test at all — not a null, just nothing.
		expect(sweepCanReachSignificance(0, 1)).toBe(false);
		expect(sweepCanReachSignificance(-3, 1)).toBe(false);
	});

	test("single-pair family: 5-0 is still p=0.0625 (cannot), 6-0 is p=0.03125 (can)", () => {
		// The concrete floor operators keep hitting: five paired tasks, even swept clean,
		// sit at 0.0625 > 0.05 — structurally impossible to call. Six is the first N that
		// clears with one comparison, matching signTestPValue(6,0)=0.03125.
		expect(sweepCanReachSignificance(5, 1)).toBe(false);
		expect(sweepCanReachSignificance(6, 1)).toBe(true);
	});

	test("a two-comparison family raises the floor from 6 to 7 decisive tasks", () => {
		// With two arm pairs Holm multiplies the best case by 2: a 6-0 sweep becomes
		// 0.03125*2=0.0625 (still short), and only a 7-0 sweep (0.015625*2=0.03125) clears.
		// This is why a 3-arm run needs more tasks per pair than a 2-arm run to conclude.
		expect(sweepCanReachSignificance(6, 2)).toBe(false);
		expect(sweepCanReachSignificance(7, 2)).toBe(true);
	});

	test("the α argument is honoured: a stricter α lifts the required task count", () => {
		// 6-0 clears the default 0.05 but not a 0.01 bar (0.03125 > 0.01); the predicate
		// must key off the passed threshold, not a hardcoded one.
		expect(sweepCanReachSignificance(6, 1, 0.05)).toBe(true);
		expect(sweepCanReachSignificance(6, 1, 0.01)).toBe(false);
	});

	test("a family size below 1 is floored to 1, never dividing the requirement away", () => {
		// A degenerate 0 (or negative) family must not make everything trivially reachable
		// by multiplying the best-case p by zero. It is clamped to a single comparison.
		expect(sweepCanReachSignificance(6, 0)).toBe(true);
		expect(sweepCanReachSignificance(5, 0)).toBe(false);
	});
});

describe("renderReport — an underpowered null is labelled, a measured null is not", () => {
	const STAMP = "2026-07-23T00:00:00.000Z";

	test("a clean 4-0 sweep that still cannot reach significance reads '(underpowered)'", () => {
		// Four tasks, B wins every one: the strongest possible signal at this N, yet
		// signTestPValue(4,0)=0.125 can never clear 0.05. The reader must be told to add
		// tasks, not that the arms are equivalent — so the qualifier must appear.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 4; i++) {
			results.push(res({ arm: "baseline", task: `t${i}`, reward: 0 }));
			results.push(res({ arm: "cand", task: `t${i}`, reward: 1 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("4-0-0");
		expect(report).toContain("not distinguishable (underpowered)");
	});

	test("a genuinely-powered 3-3 split at N=6 reads a plain null, NOT '(underpowered)'", () => {
		// Six decisive tasks CAN detect a difference (a 6-0 would be p=0.03125), so a 3-3
		// tie is a real measured null. The qualifier must be absent here — otherwise it
		// would fire on every non-significant result and lose all meaning.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			const baselineReward = i <= 3 ? 1 : 0;
			results.push(res({ arm: "baseline", task: `t${i}`, reward: baselineReward }));
			results.push(res({ arm: "cand", task: `t${i}`, reward: i <= 3 ? 0 : 1 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		// The arm-comparison row is a 3-3-0 split: not significant, but adequately powered.
		expect(report).toContain("3-3-0");
		expect(report).toContain("not distinguishable");
		expect(report).not.toContain("not distinguishable (underpowered)");
	});
});

/**
 * A timeout is a fail the agent earned, not data the harness lost.
 *
 * WHY THIS SUITE EXISTS (EVAL-TIMEOUT-EXCLUDED-NOT-FAILED). A trial that hit the
 * bench's own `--trial-timeout` recorded an error and no token counts, which made
 * it indistinguishable from an unservable model or a dead container, so it was
 * dropped from the pass-rate denominator with them. But the agent ran every
 * second it was given and produced no passing patch: that is the strongest fail
 * signal the bench can collect.
 *
 * Excluding it did two things, and the second is worse. It inflated every arm's
 * pass rate by removing exactly the hardest tasks. And it hid the effect an A/B
 * run exists to find: an arm whose overhead makes it marginally slower times out
 * MORE, so dropping those trials credited the slower arm instead of charging it.
 * Seen live in `runs/argot-budget16k-diverse`, where `scriggo-method-declarations`
 * timed out on all three repeats and all three were excluded.
 *
 * The taxonomy is three classes now: SCORED (a reward exists), AGENT-FAIL (a
 * timeout, counted as reward 0 with no measurements), and EXCLUDED (the agent
 * never got a fair run). These pin each class landing where it belongs.
 */
describe("isAgentTimeout — the one place that decides what a timeout is", () => {
	/** THE STRING THE BENCH ACTUALLY THROWS, from run.ts's trial-timeout path. */
	test("recognizes the runner's trial-timeout message", () => {
		expect(isAgentTimeout("trial timed out after 900s")).toBe(true);
		expect(isAgentTimeout("trial timed out after 60s")).toBe(true);
	});

	/** The agent-side exception spelling, which arrives through a different path. */
	test("recognizes an AgentTimeoutError", () => {
		expect(isAgentTimeout('{"exception_type":"AgentTimeoutError","message":"..."}')).toBe(true);
	});

	/** A message embedded in a larger error string still counts. */
	test("recognizes the message inside a longer error", () => {
		expect(isAgentTimeout("job failed: trial timed out after 900s (teardown ok)")).toBe(true);
	});

	/**
	 * THE NECESSARY TWIN. A predicate that answered true for infra failures would
	 * move them into the denominator as fails, which is the opposite error and
	 * would understate every arm.
	 */
	test("does not claim an infrastructure failure is a timeout", () => {
		expect(isAgentTimeout('Model "gpt-5.5" not found')).toBe(false);
		expect(isAgentTimeout("container build failed")).toBe(false);
		expect(isAgentTimeout(NO_REWARD_ERROR)).toBe(false);
	});

	/** A trial with no error is not a timeout, and must not throw on null. */
	test("returns false for no error at all", () => {
		expect(isAgentTimeout(null)).toBe(false);
	});

	/**
	 * The word "timeout" alone is not enough. A provider-side read timeout inside
	 * an exception blob is an infrastructure problem, and charging the arm for it
	 * would be the mirror of the bug this fixes.
	 */
	test("does not match an unrelated use of the word timeout", () => {
		expect(isAgentTimeout('{"exception_type":"ConnectTimeout","message":"read timeout"}')).toBe(false);
	});
});

/**
 * Verbatim lines from a real job log, `runs/2026-07-25T19-51-41-474Z/jobs/
 * baseline__scriggo-method-declarations/job.log`, kept as bytes rather than
 * paraphrased. The shape of this log is the whole problem: pier's SIGTERM handler
 * fires, the agent is cancelled mid-turn, and only THEN does teardown fail to
 * copy a patch that was never going to exist. Paraphrasing it would let the
 * predicate drift away from the text it has to classify.
 */
const KILLED_MID_RUN_JOB_LOG = [
	'  File "/home/user/.local/share/uv/tools/datacurve-pier/lib/python3.14/site-packages/pier/cli/jobs.py", line 149, in _handle_sigterm',
	"    raise KeyboardInterrupt",
	"KeyboardInterrupt",
	"",
	"asyncio.exceptions.CancelledError",
	"",
	'  File "/home/user/.local/share/uv/tools/datacurve-pier/lib/python3.14/site-packages/pier/trial/artifact_handler.py", line 195, in _download_artifact',
	"RuntimeError: Docker compose command failed for environment datacurve/scriggo-method-declarations.",
	"Error response from daemon: Could not find the file /logs/artifacts/model.patch in container 90cc95e883d14c6ce5ae00d9259a9c8c3df39cabd001e05990e599ae38a6e49d",
].join("\n");

/**
 * The same teardown failure with nothing above it: the agent exited under its own
 * power and simply wrote no patch. This is the case the bench had no way to
 * express, and the only difference from the log above is the ABSENCE of a
 * cancellation, which is exactly what makes the two opposite facts.
 */
const FINISHED_WITHOUT_PATCH_JOB_LOG = [
	'  File "/home/user/.local/share/uv/tools/datacurve-pier/lib/python3.14/site-packages/pier/trial/artifact_handler.py", line 195, in _download_artifact',
	"RuntimeError: Docker compose command failed for environment datacurve/scriggo-method-declarations.",
	"Error response from daemon: Could not find the file /logs/artifacts/model.patch in container 90cc95e883d14c6ce5ae00d9259a9c8c3df39cabd001e05990e599ae38a6e49d",
].join("\n");

/**
 * The measurement bias this predicate exists to close.
 *
 * An errored sample is EXCLUDED from every rate and mean the report prints, so an
 * arm that errors more is measured on fewer and easier trials. Every
 * context-shrinking lever in this bench risks one specific failure: the agent
 * loses something it needed and never lands a patch. Left unclassified, that
 * failure deletes itself from the measurement and CREDITS the arm that caused it,
 * which would let a cost win look clean while the arm quietly fails more tasks.
 *
 * The predicate must therefore be sharp in BOTH directions, and these tests are
 * written as matched pairs for that reason: firing when it should not would
 * charge an arm for an operator's Ctrl-C, which is the same lie inverted.
 */
describe("finishedWithoutPatch — an agent that produced nothing has failed, not errored", () => {
	/**
	 * THE CASE THE BENCH COULD NOT EXPRESS. The agent ran to completion, wrote no
	 * patch, and pier could only report that as a teardown crash. Its honest score
	 * is reward 0 inside the denominator.
	 */
	test("fires when the patch is missing and nothing cancelled the trial", () => {
		expect(finishedWithoutPatch(FINISHED_WITHOUT_PATCH_JOB_LOG)).toBe(true);
	});

	/**
	 * THE REAL INSTANCE IN HAND, and the reason detection is two-part. Matching the
	 * cp failure alone would score this trial 0, but the agent was killed by SIGTERM
	 * mid-turn (its own log tail is still `Working...`). Charging an arm for that
	 * would be the mirror of the bug being fixed, so this is the single most
	 * important assertion in the suite.
	 */
	test("does not fire on the real killed-mid-run log that motivated it", () => {
		expect(finishedWithoutPatch(KILLED_MID_RUN_JOB_LOG)).toBe(false);
	});

	/**
	 * Each cancellation marker vetoes on its own. Pier can stop a trial through
	 * three different paths and only one of them was present in the log above, so a
	 * predicate that happened to key on `KeyboardInterrupt` alone would still
	 * mis-score the other two.
	 */
	test("treats every cancellation spelling as a veto, one at a time", () => {
		for (const marker of ["KeyboardInterrupt", "CancelledError", "AgentTimeoutError"]) {
			const log = `${marker}\n${FINISHED_WITHOUT_PATCH_JOB_LOG}`;
			expect(finishedWithoutPatch(log)).toBe(false);
		}
	});

	/**
	 * A cancellation counts wherever it appears, including BELOW the download
	 * failure. Python prints chained exceptions oldest-first, but a teardown that
	 * is itself interrupted inverts that, and ordering is not evidence of cause.
	 */
	test("vetoes on a cancellation that appears after the download failure", () => {
		expect(finishedWithoutPatch(`${FINISHED_WITHOUT_PATCH_JOB_LOG}\nasyncio.exceptions.CancelledError`)).toBe(false);
	});

	/**
	 * THE NECESSARY TWIN. Every other kind of crash keeps today's exclusion. A
	 * predicate that answered true for infrastructure failures would convert the
	 * bench's whole error bucket into fake task failures and understate every arm.
	 */
	test("does not fire on an unrelated crash", () => {
		expect(finishedWithoutPatch("RuntimeError: Docker compose command failed. Return code: 137")).toBe(false);
		expect(finishedWithoutPatch('Model "gpt-5.5" not found')).toBe(false);
		expect(finishedWithoutPatch("container build failed")).toBe(false);
	});

	/**
	 * A DIFFERENT missing artifact is a different fact. Only the graded patch means
	 * "the agent produced nothing"; a missing log or trace is a harness problem and
	 * must keep its exclusion, so the phrase is matched whole rather than by the
	 * words "Could not find the file".
	 */
	test("does not fire when some other artifact is the one missing", () => {
		expect(
			finishedWithoutPatch("Error response from daemon: Could not find the file /logs/agent.log in container abc"),
		).toBe(false);
	});

	/**
	 * A passing job's log carries neither half of the discriminator, and a trial
	 * with no log at all must classify rather than throw. Absence is normal input
	 * here: a trial killed during setup writes no log.
	 */
	test("returns false for a clean log, an empty log, and no log at all", () => {
		expect(finishedWithoutPatch("trial completed, verifier scored 1.0")).toBe(false);
		expect(finishedWithoutPatch("")).toBe(false);
		expect(finishedWithoutPatch(null)).toBe(false);
		expect(finishedWithoutPatch(undefined)).toBe(false);
	});

	/**
	 * The predicate is fed the JOB log, never the trial's own `exception.txt`. On
	 * the real instance that narrower file records the cancellation and stops there,
	 * with no trace of the download that failed afterwards. A caller that passed it
	 * would see no patch signature at all and the predicate would silently never
	 * fire, which is the quiet half of the same bias. This pins the fact rather than
	 * the file name, so a caller reading the wrong file has a test explaining why.
	 */
	test("cannot classify from an exception file that omits the teardown failure", () => {
		const exceptionTxtOnly = ['  File "pier/cli/jobs.py", line 149, in _handle_sigterm', "KeyboardInterrupt"].join(
			"\n",
		);
		expect(exceptionTxtOnly).not.toContain("/logs/artifacts/model.patch");
		expect(finishedWithoutPatch(exceptionTxtOnly)).toBe(false);
	});
});

/**
 * The real 429 payload, verbatim from
 * `runs/2026-07-25T20-46-08-607Z/jobs/sig-last1__ytt-jsonpath-query-api`'s agent
 * log. Kept as bytes because every field the predicate extracts is nested
 * somewhere non-obvious in it: the reset timestamp lives under `details[].
 * metadata`, not beside the message, and the model name sits in the same bag.
 */
const QUOTA_429_AGENT_LOG = `Working...
Cloud Code Assist API error (429): {
  "error": {
    "code": 429,
    "message": "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h26m55s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "quotaResetTimeStamp": "2026-07-25T23:50:11Z",
          "uiMessage": "true",
          "model": "gemini-3-flash-agent",
          "quotaResetDelay": "2h26m55.663141191s"
        }
      }
    ]
  }
}`;

/**
 * The stop condition no canary can see.
 *
 * `shouldTripCanary` requires EVERY completed trial to be a hard error, so a
 * single early success disarms it permanently. `armCanaryFailure` requires a full
 * wave within one arm. Quota exhaustion fits neither: it strikes mid-run, after
 * successes have already banked, and it kills every arm at once. The run that
 * motivated this scored ten baseline trials, ran out of quota, and then produced
 * twenty-six consecutive zero-token trials without either canary firing.
 *
 * What made that dangerous is not the wasted hour. It is that the report would
 * have compared a ten-sample baseline against an arm with no samples, and an
 * arm's absence reads as data.
 */
describe("providerQuotaStop — the provider declaring a global refusal, with a recovery time", () => {
	/**
	 * THE REAL PAYLOAD. Both facts worth having are buried in `details[].metadata`
	 * rather than beside the message, so this pins the extraction against the actual
	 * bytes instead of a convenient reconstruction of them.
	 */
	test("extracts the reset timestamp and model from the real 429 payload", () => {
		expect(providerQuotaStop(QUOTA_429_AGENT_LOG)).toEqual({
			resetAt: "2026-07-25T23:50:11Z",
			model: "gemini-3-flash-agent",
		});
	});

	/**
	 * A provider that refuses without naming a reset time still has to trip the
	 * abort. Returning null here would trade a known-fatal condition for a silent
	 * one, which is the opposite of the point: the run must stop either way, and the
	 * operator merely loses the "come back at" hint.
	 */
	test("still fires when the provider names no reset time", () => {
		expect(providerQuotaStop('{"code":429,"status":"RESOURCE_EXHAUSTED"}')).toEqual({
			resetAt: null,
			model: null,
		});
	});

	/**
	 * THE ROUND TRIP. A live trial and a re-read `results.json` must classify
	 * identically, or `--reaggregate` would quietly disagree with the run that
	 * produced the data. The runner cannot store the raw payload (the error field
	 * truncates at 300 characters), so it stores the compact marker, and that marker
	 * has to parse back to the same two facts.
	 */
	test("reads its own compact marker back out of a stored error string", () => {
		const stop = providerQuotaStop(QUOTA_429_AGENT_LOG);
		expect(stop).not.toBeNull();
		const marker = quotaStopMarker(stop as NonNullable<typeof stop>);
		expect(marker).toBe("QUOTA_EXHAUSTED resets_at=2026-07-25T23:50:11Z quota_model=gemini-3-flash-agent");
		const stored = `{"exception_type":"RuntimeError","exception_message":"agent exited 1"} ${marker}`;
		expect(providerQuotaStop(stored)).toEqual(stop);
	});

	/** A marker for a quota stop that named nothing degrades to the bare token, and still parses. */
	test("round-trips a marker with no reset time or model", () => {
		expect(quotaStopMarker({ resetAt: null, model: null })).toBe("QUOTA_EXHAUSTED");
		expect(providerQuotaStop("QUOTA_EXHAUSTED")).toEqual({ resetAt: null, model: null });
	});

	/**
	 * THE NECESSARY TWIN, and the expensive direction to get wrong. This predicate
	 * aborts an entire run on ONE hit, with no statistical safety margin behind it,
	 * so a false positive throws away a whole measurement. Ordinary failures,
	 * including other 429-adjacent rate limiting that a retry would clear, must not
	 * match.
	 */
	test("does not fire on ordinary failures or on plain rate limiting", () => {
		expect(providerQuotaStop("HTTP 429: too many requests, retrying in 5s")).toBeNull();
		expect(providerQuotaStop('{"exception_type":"CancelledError"}')).toBeNull();
		expect(providerQuotaStop('Model "gpt-5.5" not found')).toBeNull();
		expect(providerQuotaStop("finish reason: PROHIBITED_CONTENT")).toBeNull();
		expect(providerQuotaStop("trial timed out after 900s")).toBeNull();
	});

	/** A trial with no captured output must classify rather than throw. */
	test("returns null for empty and absent input", () => {
		expect(providerQuotaStop("")).toBeNull();
		expect(providerQuotaStop(null)).toBeNull();
		expect(providerQuotaStop(undefined)).toBeNull();
	});

	/**
	 * The two spellings the provider uses are accepted independently. Google sends
	 * `RESOURCE_EXHAUSTED` as the status and `QUOTA_EXHAUSTED` as the reason, and a
	 * predicate keyed on only one of them would miss any payload carrying the other.
	 */
	test("accepts either exhaustion spelling on its own", () => {
		expect(providerQuotaStop("status: RESOURCE_EXHAUSTED")).not.toBeNull();
		expect(providerQuotaStop("reason: QUOTA_EXHAUSTED")).not.toBeNull();
	});
});

/**
 * The `--reaggregate` hole, which is the half of the quota problem the runner's
 * own abort cannot close.
 *
 * A live run stops on the first quota refusal and writes no report. But
 * reaggregation reads whatever jobs are on disk, and a truncated run's survivors
 * aggregate into something indistinguishable from a complete result. The run that
 * motivated this kept ten baseline trials and lost every trial of the arm under
 * test, so the honest reading is "no comparison" while the arithmetic would print
 * a tidy per-arm table with one arm quietly missing.
 */
describe("renderQuotaTruncationBanner — an incomplete run must not read as a result", () => {
	const quotaError = "QUOTA_EXHAUSTED resets_at=2026-07-25T23:50:11Z quota_model=gemini-3-flash-agent";
	const stopped = (arm: string, task: string): ArmResult => ({
		...emptyArmResult(arm, task, 0),
		error: quotaError,
	});
	const scored = (arm: string, task: string): ArmResult => ({
		...emptyArmResult(arm, task, 0),
		reward: 1,
		outputTokens: 50_000,
	});

	/**
	 * A clean run must print NO banner. A caveat that appears on every report is
	 * one readers learn to ignore, which would disarm it for the run that needs it.
	 */
	test("says nothing when no sample hit quota", () => {
		expect(renderQuotaTruncationBanner([scored("baseline", "a"), scored("sig-last1", "a")])).toBeNull();
	});

	/**
	 * THE SHAPE THAT MOTIVATED THIS. One arm keeps its samples, the other loses all
	 * of them. Naming the affected arm is the point: "some trials failed" leaves a
	 * reader to assume the loss was symmetric, and here it was total for one side.
	 */
	test("names the arms that lost samples and the reset time", () => {
		const banner = renderQuotaTruncationBanner([
			scored("baseline", "a"),
			scored("baseline", "b"),
			stopped("sig-last1", "a"),
			stopped("sig-last1", "b"),
		]);
		expect(banner).toContain("CUT SHORT by provider quota");
		expect(banner).toContain("2 trial(s)");
		expect(banner).toContain("arm(s): sig-last1");
		expect(banner).not.toContain("baseline");
		expect(banner).toContain("2026-07-25T23:50:11Z");
	});

	/** Both arms losing samples is still a truncated run, and both are named. */
	test("names every affected arm, in a stable order", () => {
		const banner = renderQuotaTruncationBanner([stopped("sig-last1", "a"), stopped("baseline", "a")]);
		expect(banner).toContain("arm(s): baseline, sig-last1");
	});

	/** A quota stop that named no reset time still banners, just without the hint. */
	test("banners without a reset time when the provider named none", () => {
		const banner = renderQuotaTruncationBanner([{ ...emptyArmResult("baseline", "a", 0), error: "QUOTA_EXHAUSTED" }]);
		expect(banner).toContain("CUT SHORT by provider quota");
		expect(banner).not.toContain("Quota reset was");
	});

	/**
	 * THE NECESSARY TWIN. Ordinary errors are a normal part of every run and must
	 * not raise this banner, or it would fire on almost every report and mean
	 * nothing.
	 */
	test("does not banner on ordinary errors", () => {
		const banner = renderQuotaTruncationBanner([
			{ ...emptyArmResult("baseline", "a", 0), error: "trial timed out after 900s" },
			{ ...emptyArmResult("baseline", "b", 0), error: '{"exception_type":"CancelledError"}' },
		]);
		expect(banner).toBeNull();
	});

	/**
	 * The banner has to reach the rendered report, above the provenance line. A
	 * predicate nobody calls is the same as no predicate, and this is the assertion
	 * that would catch the wiring being dropped.
	 */
	test("appears at the top of the rendered report, before the provenance banner", () => {
		const report = renderReport(
			[scored("baseline", "a"), stopped("sig-last1", "a")],
			"google-antigravity/gemini-3.5-flash",
			"2026-07-25T21:00:00Z",
			1,
			{ marked: true, biased: false, note: null },
		);
		const quotaAt = report.indexOf("CUT SHORT by provider quota");
		const provenanceAt = report.indexOf("Task set: headline");
		expect(quotaAt).toBeGreaterThan(-1);
		expect(provenanceAt).toBeGreaterThan(-1);
		expect(quotaAt).toBeLessThan(provenanceAt);
	});

	/** A clean report stays clean: no banner text leaks into a run that never hit quota. */
	test("leaves a clean report free of quota text", () => {
		const report = renderReport(
			[scored("baseline", "a"), scored("sig-last1", "a")],
			"google-antigravity/gemini-3.5-flash",
			"2026-07-25T21:00:00Z",
		);
		expect(report).not.toContain("CUT SHORT by provider quota");
	});
});

describe("isHardError — a timeout is not the agent failing to run", () => {
	/**
	 * THE CANARY SAFETY PROPERTY. The fail-fast canary aborts an entire run when a
	 * full wave is hard errors. A batch of genuinely long tasks against a tight
	 * `--trial-timeout` would have looked exactly like an unservable model and
	 * killed the run.
	 */
	test("a timeout with no token counts is not a hard error", () => {
		expect(isHardError({ error: "trial timed out after 900s", outputTokens: null })).toBe(false);
	});

	/** The genuine signature is unchanged: an error and nothing produced. */
	test("an infrastructure error with no token counts is still a hard error", () => {
		expect(isHardError({ error: 'Model "x" not found', outputTokens: null })).toBe(true);
	});

	/** A wave of pure timeouts must not trip the canary: the agent ran. */
	test("a full wave of timeouts does not trip the canary", () => {
		const wave = Array.from({ length: 4 }, () => ({
			error: "trial timed out after 900s",
			outputTokens: null,
		}));

		expect(shouldTripCanary(wave, 4)).toBe(false);
	});

	/** A full wave of infra errors still does, which is what the canary is for. */
	test("a full wave of infrastructure errors still trips the canary", () => {
		const wave = Array.from({ length: 4 }, () => ({ error: 'Model "x" not found', outputTokens: null }));

		expect(shouldTripCanary(wave, 4)).toBe(true);
	});
});

describe("summarizeCell — a timeout is a fail in the denominator, not missing data", () => {
	const timeout = () => res({ error: "trial timed out after 900s", outputTokens: null, reward: null });

	/**
	 * THE REGRESSION. Two passes and a timeout used to read as a perfect 1.0 over
	 * n=2. It is 0.67 over n=3: the agent attempted three tasks and solved two.
	 */
	test("a timed-out sample counts as a fail in n and the rate", () => {
		const s = summarizeCell([res({ reward: 1 }), res({ reward: 1 }), timeout()]);

		expect(s.total).toBe(3);
		expect(s.n).toBe(3);
		expect(s.passes).toBe(2);
		expect(s.passRate).toBeCloseTo(2 / 3, 10);
		expect(s.errors).toBe(0);
		expect(s.timedOut).toBe(1);
	});

	/**
	 * Timeouts and infra errors land in different buckets from the same cell. This
	 * is the assertion that would have caught the original conflation, because
	 * both rows carry an error and no tokens.
	 */
	test("separates timeouts from infrastructure errors in one cell", () => {
		const s = summarizeCell([res({ reward: 1 }), timeout(), res({ error: "container build failed" })]);

		expect(s.n).toBe(2);
		expect(s.passes).toBe(1);
		expect(s.passRate).toBe(0.5);
		expect(s.timedOut).toBe(1);
		expect(s.errors).toBe(1);
	});

	/**
	 * The token and cost means must NOT move. A timeout records no tokens, and
	 * letting it in as a zero would report an arm as cheaper for having failed to
	 * finish, which is the token-efficiency mirror of the pass-rate bug.
	 */
	test("keeps timeouts out of every token and cost mean", () => {
		const scored = [
			res({ reward: 1, outputTokens: 100, inputTokens: 10, costUsd: 0.2 }),
			res({ reward: 0, outputTokens: 200, inputTokens: 20, costUsd: 0.4 }),
		];

		const without = summarizeCell(scored);
		const with_ = summarizeCell([...scored, timeout()]);

		expect(with_.meanOutputTokens).toBe(without.meanOutputTokens);
		expect(with_.meanInputTokens).toBe(without.meanInputTokens);
		expect(with_.meanCostUsd).toBe(without.meanCostUsd);
		expect(with_.sumOutputTokens).toBe(without.sumOutputTokens);
	});

	/**
	 * The mean reward carries the same fail the pass rate does, in continuous
	 * form. Leaving it over scored rows alone would have the report's two headline
	 * numbers disagree about the same trial.
	 */
	test("counts a timeout as reward 0 in the mean reward", () => {
		const s = summarizeCell([res({ reward: 1 }), timeout()]);

		expect(s.meanReward).toBe(0.5);
	});

	/**
	 * Partial credit stays over scored rows. A trial that never finished has no
	 * partial score, and inventing a 0 would claim the verifier looked and found
	 * nothing when it never ran at all.
	 */
	test("leaves the mean partial over scored samples only", () => {
		const s = summarizeCell([res({ reward: 1, partial: 0.8 }), timeout()]);

		expect(s.meanPartial).toBe(0.8);
	});

	/**
	 * A cell that is nothing but timeouts is a real 0% pass rate over a real
	 * denominator, not an empty cell. This is the shape the argot run hit, where
	 * one task timed out on every repeat.
	 */
	test("an all-timeout cell reads as a genuine zero, not as no data", () => {
		const s = summarizeCell([timeout(), timeout(), timeout()]);

		expect(s.n).toBe(3);
		expect(s.passRate).toBe(0);
		expect(s.timedOut).toBe(3);
		expect(s.errors).toBe(0);
	});

	/** A cell with no timeouts reports zero of them, so the field is always safe to read. */
	test("reports zero timeouts when there are none", () => {
		expect(summarizeCell([res({ reward: 1 }), res({ error: "boom" })]).timedOut).toBe(0);
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

describe("blockContainsSigil — encode is detected in tool calls, not just prose", () => {
	// The argot preamble tells the model to write a handle "in prose, a command, or
	// a diff". On a coding agent most output is tool calls (shell commands, edit
	// diffs), so a probe that scanned only text blocks would miss the handles that
	// actually appear and could read a heavy-encode arm as "0 encoded", falsely
	// concluding the treatment never fired. These tests lock the tool-call scan in.

	test("a text block containing § counts", () => {
		// The obvious case: a handle written in the assistant's prose.
		expect(blockContainsSigil({ type: "text", text: "edit §dbconn now" })).toBe(true);
	});

	test("a text block with no § does not count", () => {
		expect(blockContainsSigil({ type: "text", text: "no handles here" })).toBe(false);
	});

	test("a handle inside a tool call's command argument counts — the regression this fixes", () => {
		// A shell command referencing a path by handle. The old text-only probe
		// returned false here; that is exactly the undercount being closed.
		const block = { type: "toolCall", name: "bash", arguments: { command: "cat §dbconn" } };
		expect(blockContainsSigil(block)).toBe(true);
	});

	test("a handle inside a tool call's diff argument counts", () => {
		const block = {
			type: "toolCall",
			name: "apply_patch",
			arguments: { patch: "--- a/§dbconn\n+++ b/§dbconn\n" },
		};
		expect(blockContainsSigil(block)).toBe(true);
	});

	test("a tool call whose arguments hold no § does not count", () => {
		const block = { type: "toolCall", name: "bash", arguments: { command: "ls -la" } };
		expect(blockContainsSigil(block)).toBe(false);
	});

	test("a § nested deep in the arguments object still counts (serialized scan)", () => {
		const block = {
			type: "toolCall",
			name: "multi_edit",
			arguments: { edits: [{ path: "clean" }, { path: "§dbconn" }] },
		};
		expect(blockContainsSigil(block)).toBe(true);
	});

	test("a custom sigil is honored, and the default § is then not matched", () => {
		const block = { type: "toolCall", name: "bash", arguments: { command: "cat ¶dbconn" } };
		expect(blockContainsSigil(block, "¶")).toBe(true);
		expect(blockContainsSigil(block)).toBe(false);
	});

	test("non-object and null blocks are sigil-free, never throw", () => {
		expect(blockContainsSigil(null)).toBe(false);
		expect(blockContainsSigil(undefined)).toBe(false);
		expect(blockContainsSigil("§ raw string is not a block")).toBe(false);
	});

	test("a non-serializable (cyclic) arguments object is treated as sigil-free, not thrown", () => {
		// A read-only probe must never crash the parse; a cyclic object cannot hold
		// a plain countable handle string anyway.
		const cyclic: Record<string, unknown> = { command: "x" };
		cyclic.self = cyclic;
		const block = { type: "toolCall", name: "bash", arguments: cyclic };
		expect(blockContainsSigil(block)).toBe(false);
	});
});

describe("providerFinishReason — a content-filter stop is not a generic crash", () => {
	// A provider that aborts generation (PROHIBITED_CONTENT/SAFETY/RECITATION) makes
	// the agent exit non-zero, which the bench excludes as an error. Recovering the
	// finish reason is what lets the report tell a refusal apart from a real crash —
	// and a refusal that tracks the treatment is a confound, not a null result.

	test("extracts PROHIBITED_CONTENT from the real gemini message", () => {
		// The exact string the smoke run produced.
		expect(providerFinishReason("Working...\nGeneration failed with finish reason: PROHIBITED_CONTENT")).toBe(
			"PROHIBITED_CONTENT",
		);
	});

	test("matches the underscore spelling finish_reason too", () => {
		expect(providerFinishReason("stopped, finish_reason SAFETY, aborting")).toBe("SAFETY");
	});

	test("returns null when there is no finish-reason marker", () => {
		expect(providerFinishReason("some ordinary stdout with no policy stop")).toBeNull();
	});

	test("does not match lowercase prose that merely contains the words", () => {
		// Guards against a false positive on narration like "the finish reason was fine".
		expect(providerFinishReason("the finish reason was fine")).toBeNull();
	});
});

describe("classifyError — group excluded samples by a stable, comparable label", () => {
	// The report groups errors by this label to expose an arm asymmetry. It must pull
	// a stable label out of pier's exception_info JSON, refine it with a provider
	// finish reason when present, and never throw on a runner-side string.

	test("a bare exception_info JSON classifies by its exception type", () => {
		expect(classifyError('{"exception_type":"NonZeroAgentExitCodeError","exception_message":"boom"}')).toBe(
			"NonZeroAgentExitCodeError",
		);
	});

	test("a content-filter refusal is named distinctly from a plain crash", () => {
		// The run.ts path appends the finish reason it recovered from the agent log.
		const err =
			'{"exception_type":"NonZeroAgentExitCodeError","exception_message":"exit 1"} finish_reason: PROHIBITED_CONTENT';
		expect(classifyError(err)).toBe("NonZeroAgentExitCodeError (PROHIBITED_CONTENT)");
	});

	test("a runner-side timeout string classifies as timeout, never throws", () => {
		expect(classifyError("trial timed out after 1800s; pier exit 1; ...")).toBe("timeout");
	});

	test("an unrecognized non-JSON string falls back to other", () => {
		expect(classifyError("mystery failure")).toBe("other");
	});

	test("a verifier-no-reward is labelled distinctly, not folded into other", () => {
		// A scorer outage must be its own comparable failure mode so its per-arm asymmetry
		// is visible; bucketing it as "other" would hide a verifier that trips on one arm.
		expect(classifyError(NO_REWARD_ERROR)).toBe("verifier-no-reward");
	});
});

describe("noRewardError — an unscored trial is not a task failure", () => {
	// The silent-fallback this locks out (Law 10): a trial the agent completed but the
	// verifier never scored parses to reward=null. Counted as-is it becomes a fail
	// (reward !== 1), understating the pass rate and turning a scorer outage that tracks
	// one arm into a phantom correctness loss. noRewardError marks exactly those trials
	// so the runner can reclassify them as errors (excluded + surfaced), never as fails.

	test("null and undefined rewards are unscored", () => {
		expect(noRewardError(null)).toBe(true);
	});

	test("a reward of 0 is a REAL scored failure, not unscored", () => {
		// The critical distinction: 0 is a number the verifier assigned (all tests failed),
		// so it must stay a counted failure. Only a missing score is an error.
		expect(noRewardError(0)).toBe(false);
	});

	test("finite fractional and full rewards are scored", () => {
		expect(noRewardError(0.5)).toBe(false);
		expect(noRewardError(1)).toBe(false);
	});

	test("a non-finite reward (NaN/Infinity) is unscored", () => {
		// JSON has no NaN, but a defensive guard: any non-finite value means no real score.
		expect(noRewardError(Number.NaN)).toBe(true);
		expect(noRewardError(Number.POSITIVE_INFINITY)).toBe(true);
	});
});

describe("renderReport — the Errors (per arm) section exposes a refusal asymmetry", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("shows every arm (including zero-error arms) so the asymmetry is visible", () => {
		// The smoke shape: decode passed, full was refused by the content filter. The
		// section must show full's 1 refusal AND decode's 0, side by side, because a
		// delta measured against an arm that lost a sample can be a selection effect.
		const results: ArmResult[] = [
			res({ arm: "decode", task: "t1", reward: 1, outputTokens: 80000 }),
			res({
				arm: "full",
				task: "t1",
				reward: null,
				error: '{"exception_type":"NonZeroAgentExitCodeError","exception_message":"exit 1"} finish_reason: PROHIBITED_CONTENT',
			}),
		];
		const report = renderReport(results, "google-antigravity/gemini-3.6-flash", STAMP, 1);
		expect(report).toContain("## Errors (per arm)");
		expect(report).toContain("NonZeroAgentExitCodeError (PROHIBITED_CONTENT)");
		// full errored once under that reason; decode errored zero times — both rows
		// present so the reader sees the imbalance, not just full's count.
		expect(report).toContain("| full | 1 | 1 |");
		expect(report).toContain("| decode | 0 | 0 |");
	});

	test("omits the Errors section entirely when no sample errored", () => {
		const results: ArmResult[] = [
			res({ arm: "decode", task: "t1", reward: 1 }),
			res({ arm: "full", task: "t1", reward: 0 }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).not.toContain("## Errors (per arm)");
	});

	test("an unscored trial (verifier-no-reward) is EXCLUDED from the pass rate, not counted as a fail", () => {
		// The Law-10 fix end to end: `full` has two OK passes and one trial the verifier
		// never scored (stamped NO_REWARD_ERROR by the runner). If the unscored trial were
		// folded in as a fail, full's pass rate would read 2/3; excluded, it is the honest
		// 2/2 with the unscored trial surfaced in Errors under its own label.
		const results: ArmResult[] = [
			res({ arm: "full", task: "t1", reward: 1 }),
			res({ arm: "full", task: "t2", reward: 1 }),
			res({ arm: "full", task: "t3", reward: null, error: NO_REWARD_ERROR }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		// Pass rate is 2/2 (the unscored trial is not a denominator fail)...
		expect(report).toContain("(2/2)");
		// ...and the trial is surfaced as its own error class, not hidden.
		expect(report).toContain("## Errors (per arm)");
		expect(report).toContain("verifier-no-reward");
		expect(report).toContain("| full | 1 | 1 |");
	});
});

describe("tallyUsage — a tool invocation is counted once, not once per call and once per result", () => {
	// The bug this locks out: one tool use shows up in the transcript twice — as a
	// toolCall block on the assistant message, and as a toolResult message. The old
	// parser counted both, doubling every entry in the tool distribution (40 real
	// eval calls reported as 80). tallyUsage counts only the assistant invocations.

	test("a call+result pair for the same tool counts as ONE, not two", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "eval", arguments: { code: "1+1" } }],
			},
			{ role: "toolResult", toolName: "eval", content: [{ type: "text", text: "2" }] },
		];
		const u = tallyUsage(messages);
		expect(u.toolCalls).toEqual({ eval: 1 });
	});

	test("counts match the model's real invocations across a mixed session", () => {
		// Two eval calls and one read call, each with its paired result. The doubled
		// parser would have reported eval:4, read:2.
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: {} }] },
			{ role: "toolResult", toolName: "eval", content: [] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
			{ role: "toolResult", toolName: "read", content: [] },
			{ role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: {} }] },
			{ role: "toolResult", toolName: "eval", content: [] },
		];
		expect(tallyUsage(messages).toolCalls).toEqual({ eval: 2, read: 1 });
	});

	test("argot_load is counted from the invocation, consistent with the tool distribution", () => {
		// The treatment probe (argotLoadCalls) and the distribution must agree: both
		// derive from the same assistant toolCall block, so a load is 1 in both.
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "argot_load", arguments: { folder: "pkg" } }] },
			{ role: "toolResult", toolName: "argot_load", content: [] },
		];
		const u = tallyUsage(messages);
		expect(u.argotLoadCalls).toBe(1);
		expect(u.toolCalls.argot_load).toBe(1);
	});

	test("sums token usage from assistant messages and ignores non-assistant roles", () => {
		const messages = [
			{
				role: "assistant",
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: { total: 0.01 } },
				content: [],
			},
			{ role: "toolResult", toolName: "read", content: [] },
			{
				role: "assistant",
				usage: { input: 50, output: 10, cacheRead: 2, cacheWrite: 0, cost: { total: 0.005 } },
				content: [],
			},
		];
		const u = tallyUsage(messages);
		expect(u.inputTokens).toBe(150);
		expect(u.outputTokens).toBe(30);
		expect(u.cacheTokens).toBe(10); // (5+3) + (2+0)
		expect(u.costUsd).toBeCloseTo(0.015, 12);
	});

	test("counts an assistant message as encoded when a handle rides in a tool call, not just prose", () => {
		// Ties tallyUsage to blockContainsSigil: a handle in a shell command counts.
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "cat §dbconn" } }] },
			{ role: "assistant", content: [{ type: "text", text: "no handle here" }] },
		];
		expect(tallyUsage(messages).assistantMsgsWithSigil).toBe(1);
	});

	/**
	 * Cache reads and cache writes must survive the tally as separate numbers.
	 *
	 * They were summed into one `cacheTokens` field, and that single field cannot
	 * be priced: a read costs 0.075/M and a write 0.3833/M, a factor of five, so
	 * an arm that turns reads into writes gets five times more expensive while
	 * the summed column does not move at all. That is the exact regression the
	 * cost table exists to catch, and it can only be caught if the split survives
	 * from the session file to the row. `cacheTokens` is still their sum, for the
	 * older records and callers that read it.
	 */
	test("keeps cache reads and cache writes separate, and their sum", () => {
		const messages = [
			{ role: "assistant", usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 200 }, content: [] },
			{ role: "assistant", usage: { input: 20, output: 7, cacheRead: 3000, cacheWrite: 0 }, content: [] },
		];
		const u = tallyUsage(messages);
		expect(u.cacheReadTokens).toBe(4000);
		expect(u.cacheWriteTokens).toBe(200);
		expect(u.cacheTokens).toBe(4200);
		expect(u.inputTokens).toBe(30);
		expect(u.outputTokens).toBe(12);
	});

	/**
	 * A session whose messages report reads but no `cacheWrite` field at all must
	 * tally a write of zero, not `NaN`. Providers omit the field when nothing was
	 * written, and a `NaN` here would propagate into the priced total and render
	 * the whole cost table unusable from one malformed line.
	 */
	test("treats an absent cacheWrite field as zero, not NaN", () => {
		const u = tallyUsage([{ role: "assistant", usage: { input: 5, output: 1, cacheRead: 99 }, content: [] }]);
		expect(u.cacheWriteTokens).toBe(0);
		expect(u.cacheReadTokens).toBe(99);
		expect(Number.isNaN(u.cacheTokens)).toBe(false);
	});

	test("an empty session tallies to all-zero, never throws", () => {
		const u = tallyUsage([]);
		expect(u).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
			argotLoadCalls: 0,
			assistantMsgsWithSigil: 0,
			toolCalls: {},
		});
	});
});

describe("systemPromptTeachesArgot — the authoritative post-run encode-fired probe", () => {
	// Why this exists: the pre-run allowlist guard matches the REQUESTED --model, but
	// the runtime resolves that id through the catalog to a different logical id before
	// argot's gate runs. So an encode arm can pass the pre-run guard and still run
	// decode-only. This probe reads the actual system prompt the model was given, which
	// reflects the model AFTER resolution — the only signal that catches a silent
	// decode-only degrade. A real full-arm smoke reproduced exactly that: requested
	// google-antigravity/gemini-3.6-flash resolved to gemini-3.5-flash, off the
	// [..., gemini-3.6-flash, ...] allowlist, so the preamble was never taught.

	test("the marker is argot's OWN preamble heading, so it cannot drift from the runtime", () => {
		// ARGOT_PREAMBLE_HEADING must be the first line of argot's rendered preamble,
		// not a hand-copied string that could silently fall out of sync with what the
		// harness injects. If argot renames the heading, this test moves with it.
		expect(ARGOT_PREAMBLE_HEADING).toBe(ARGOT_PREAMBLE.split("\n")[0]);
		expect(ARGOT_PREAMBLE_HEADING).toBe("## Project shorthand (Argot)");
	});

	test("true when the system prompt carries the real teaching preamble (tools variant)", () => {
		// sdk.ts injects renderPreamble({ tools: true }); the heading is identical to the
		// default variant, so the probe fires on the exact text the coding agent embeds.
		const prompt = `You are a helpful agent.\n\n${renderPreamble({ tools: true })}\n\nMore rules.`;
		expect(systemPromptTeachesArgot(prompt)).toBe(true);
	});

	test("true for the no-tools preamble variant as well", () => {
		const prompt = `preamble:\n${renderPreamble({ tools: false })}`;
		expect(systemPromptTeachesArgot(prompt)).toBe(true);
	});

	test("false for a real 83k-char system prompt that never taught encoding (the smoke bug)", () => {
		// The decode arm — and the BROKEN full arm — produce a full system prompt with
		// every rule EXCEPT the argot preamble. A long prompt that merely mentions
		// "argot" or "shorthand" elsewhere must not be mistaken for the taught treatment.
		const prompt = `${"lorem ipsum ".repeat(7000)}\nargot_load is a tool. shorthand exists.`;
		expect(systemPromptTeachesArgot(prompt)).toBe(false);
	});

	test("false on an empty prompt", () => {
		expect(systemPromptTeachesArgot("")).toBe(false);
	});
});

describe("renderReport — Argot treatment applied? surfaces `preamble taught` authoritatively", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";
	// The column that would have caught the inert full-arm run at a glance: an encode
	// arm whose preamble never reached the model reads `0/N`, so a reader knows every
	// token delta against it is meaningless before trusting the efficiency section.

	test("an encode arm that never taught the preamble reads 0/N (the silent decode-only degrade)", () => {
		const results: ArmResult[] = [
			res({
				arm: "full",
				task: "t1",
				reward: 1,
				argotLoadCalls: 0,
				assistantMsgsWithSigil: 0,
				argotPreamblePresent: false,
			}),
			res({
				arm: "full",
				task: "t2",
				reward: 0,
				argotLoadCalls: 0,
				assistantMsgsWithSigil: 0,
				argotPreamblePresent: false,
			}),
		];
		const report = renderReport(results, "google-antigravity/gemini-3.5-flash", STAMP, 1);
		expect(report).toContain("## Argot treatment applied? (per arm)");
		// arm | OK runs | preamble taught | ... => full ran 2 OK trials, taught 0 of 2.
		expect(report).toContain("| full | 2 | 0/2 |");
	});

	test("an encode arm that taught the preamble on every trial reads N/N", () => {
		const results: ArmResult[] = [
			res({
				arm: "full",
				task: "t1",
				reward: 1,
				argotLoadCalls: 1,
				assistantMsgsWithSigil: 3,
				argotPreamblePresent: true,
			}),
			res({
				arm: "full",
				task: "t2",
				reward: 1,
				argotLoadCalls: 1,
				assistantMsgsWithSigil: 5,
				argotPreamblePresent: true,
			}),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("| full | 2 | 2/2 |");
	});

	test("reads `unknown` when no trial's preamble presence could be determined", () => {
		// argotPreamblePresent null (unreadable sessions) but argot telemetry present, so
		// the section still renders; the taught cell must say unknown, not a false 0/0.
		const results: ArmResult[] = [
			res({
				arm: "decode",
				task: "t1",
				reward: 1,
				argotLoadCalls: 2,
				assistantMsgsWithSigil: 0,
				argotPreamblePresent: null,
			}),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("| decode | 1 | unknown |");
	});
});

describe("renderReport — tool call distribution is normalized per completed run, not raw totals", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("two arms with identical per-run tool use read EQUAL even when one arm errored more", () => {
		// The bias this locks out: the table used to print RAW per-arm sums. Arm `a`
		// completes 3 runs (6 read calls total) and arm `b` completes 2 runs + 1 error (4
		// read calls total). Raw sums would show 6 vs 4 and read as "b streamlined its
		// tools" when b merely ran one fewer sample. Dividing by each arm's completed-run
		// count makes both read 2.00 — the truth — and the count is disclosed as n.
		const results: ArmResult[] = [
			res({ arm: "a", task: "t1", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "a", task: "t2", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "a", task: "t3", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "b", task: "t1", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "b", task: "t2", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "b", task: "t3", error: "boom" }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("## Tool call distribution (mean calls per completed run)");
		// Both arms used 2 read calls per run; the normalized table must say so for both,
		// and expose the differing sample counts (n=3 vs n=2) that raw totals would hide.
		expect(report).toContain("| a (n=3) | 2.00 |");
		expect(report).toContain("| b (n=2) | 2.00 |");
	});

	test("an all-errored arm shows n=0 and '—', never a divide-by-zero NaN", () => {
		// A cell with no completed run must not render NaN or Infinity from a 0 denominator;
		// it is honestly blank so the reader sees the arm produced no tool-call signal.
		const results: ArmResult[] = [
			res({ arm: "ok", task: "t1", reward: 1, toolCalls: { read: 3 } }),
			res({ arm: "dead", task: "t1", error: "boom" }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("| ok (n=1) | 3.00 |");
		expect(report).toContain("| dead (n=0) | — |");
		expect(report).not.toContain("NaN");
	});
});

describe("parseTaskListProvenance — a selection-biased task set is never a silent headline", () => {
	// The methodology defect this locks out: argot-10.txt is EXPLICITLY the tasks whose
	// repos compress best ("most repeated-token mass"), so a big saving on it is a
	// best-case upper bound, not argot's real effect. A task list declares its status in
	// a header directive so the report can warn; this parses exactly that directive.

	test("a @biased directive marks the set biased and captures its reason", () => {
		const prov = parseTaskListProvenance("# @biased: repos chosen for max compressible mass\ntask-a\ntask-b\n");
		expect(prov).toEqual({ marked: true, biased: true, note: "repos chosen for max compressible mass" });
	});

	test("a @headline directive marks the set unbiased", () => {
		const prov = parseTaskListProvenance("# @headline: unbiased held-out set\nytt-jsonpath-query-api\n");
		expect(prov).toEqual({ marked: true, biased: false, note: "unbiased held-out set" });
	});

	test("a bare @headline with no note is still marked, note null", () => {
		expect(parseTaskListProvenance("# @headline\ntask-a\n")).toEqual({ marked: true, biased: false, note: null });
	});

	test("no directive at all reads unmarked, so the report can nudge for one", () => {
		// The old plain task lists: the report must not silently assume headline; it flags
		// the missing provenance instead.
		expect(parseTaskListProvenance("# just a description\ntask-a\ntask-b\n")).toEqual({
			marked: false,
			biased: false,
			note: null,
		});
	});

	test("a directive only counts in the HEADER, above the first task (no spoofing)", () => {
		// Scanning stops at the first non-comment line, so a task named to look like a
		// directive (or a trailing comment) cannot flip a headline set to biased.
		const prov = parseTaskListProvenance("# @headline\ntask-a\n# @biased: sneaky trailing comment\n");
		expect(prov).toEqual({ marked: true, biased: false, note: null });
	});

	test("real argot-10 and diverse-20 headers classify correctly", () => {
		// The two real files this feature exists for: the compression-optimized pilot is
		// biased, the held-out diverse set is a headline.
		expect(parseTaskListProvenance("# @biased: maximal repeated-token mass\nkgateway-x\n").biased).toBe(true);
		expect(parseTaskListProvenance("# @headline: unbiased held-out\nytt-x\n").biased).toBe(false);
	});
});

describe("renderTaskSetProvenanceBanner / renderReport — the provenance banner is loud", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("a biased set renders a prominent best-case warning with its reason", () => {
		const banner = renderTaskSetProvenanceBanner({ marked: true, biased: true, note: "max compressible mass" });
		expect(banner).toContain("SELECTION-BIASED");
		expect(banner).toContain("NOT a headline");
		expect(banner).toContain("max compressible mass");
	});

	test("a headline set renders a calm confirmation, no warning", () => {
		const banner = renderTaskSetProvenanceBanner({ marked: true, biased: false, note: "held-out" });
		expect(banner).toContain("headline (unbiased)");
		expect(banner).not.toContain("SELECTION-BIASED");
	});

	test("an unmarked set nudges the author to declare provenance", () => {
		const banner = renderTaskSetProvenanceBanner({ marked: false, biased: false, note: null });
		expect(banner).toContain("unmarked");
		expect(banner).toContain("@headline");
		expect(banner).toContain("@biased");
	});

	test("renderReport prints the biased banner near the top when a task set is given", () => {
		// End to end: a report built from a biased set must carry the warning so no reader
		// mistakes a best-case saving for a headline. Omitting the task set (older runs /
		// fixtures) prints no banner, keeping every prior report test valid.
		const results: ArmResult[] = [res({ arm: "full", task: "t1", reward: 1 })];
		const withBias = renderReport(results, "m", STAMP, 1, { marked: true, biased: true, note: "best-case repos" });
		expect(withBias).toContain("SELECTION-BIASED");
		expect(withBias).toContain("best-case repos");
		const without = renderReport(results, "m", STAMP, 1);
		expect(without).not.toContain("SELECTION-BIASED");
	});
});

describe("interpretEncodeArm — making a 0-encoded argot result interpretable", () => {
	// The bug this locks out: the first real encode-fixed run reported
	// `full: preamble taught 4/4` alongside `encoded 0/4`, and NOTHING in the
	// report could say whether argot failed, the model declined, or the corpus
	// simply had no repeated-token mass to compress. Reading a token delta from
	// that state is unsound in all three cases, but only one of them is a real
	// argot measurement. These lock the three-way disambiguation.

	test("zero handles loaded says encode was IMPOSSIBLE and the delta is not an argot measure", () => {
		// The trap case. An empty launch dictionary means the model had no handle
		// to write, so `0 encoded` is a property of the CORPUS, not of argot and
		// not of the model. The note must forbid reading the delta as "argot does
		// not help", which is exactly the wrong conclusion a bare 0 invites.
		const note = interpretEncodeArm({ arm: "full", okRuns: 4, taught: 4, handlesLoaded: 0, encoded: 0 });
		expect(note).toContain("loaded 0 handles");
		expect(note).toContain("IMPOSSIBLE");
		expect(note).toContain("NOT a measure of argot");
	});

	test("handles loaded AND taught but nothing encoded is charged to the MODEL, not the corpus", () => {
		// The genuinely interesting negative result: shorthand was in front of the
		// model and it wrote none. That is a model-adoption finding and must be
		// worded as such, never conflated with the empty-dictionary case above.
		// Note the precondition: it is only a model result once the table is proven
		// to have been TAUGHT. Loading alone never licensed this verdict.
		const note = interpretEncodeArm({
			arm: "full",
			okRuns: 4,
			taught: 4,
			handlesLoaded: 37,
			encoded: 0,
			handlesTaught: 4,
			handlesTaughtKnown: 4,
		});
		expect(note).toContain("37 handles were loaded AND taught in 4/4 runs");
		expect(note).toContain("ignored shorthand it could see");
		expect(note).toContain("model-adoption result");
		expect(note).not.toContain("IMPOSSIBLE");
		expect(note).not.toContain("HARNESS failure");
	});

	test("a loaded vocabulary the model was never SHOWN is a harness failure, never a model result", () => {
		// The misread this whole field exists to prevent. The first interpretable
		// encode run loaded 551 handles and encoded none, and the report charged
		// that to the model. But the handle table is injected on an asynchronous
		// prompt refresh, and if that refresh does not carry it the model sees the
		// notation, sees no handles, and is told never to invent one. Zero output
		// is then the ONLY compliant behavior, so blaming the model is unsound.
		const note = interpretEncodeArm({
			arm: "full",
			okRuns: 4,
			taught: 4,
			handlesLoaded: 551,
			encoded: 0,
			handlesTaught: 0,
			handlesTaughtKnown: 4,
		});
		expect(note).toContain("reached the model in only 0/4 runs");
		expect(note).toContain("HARNESS failure");
		expect(note).not.toContain("model-adoption result");
		expect(note).not.toContain("ignored");
	});

	test("a partially taught arm is still a harness failure, not a diluted model result", () => {
		// Boundary: some runs taught the table and some did not. The arm is not a
		// clean measurement either way, so it must read as broken rather than be
		// averaged into a model verdict that silently rests on the taught subset.
		const note = interpretEncodeArm({
			arm: "full",
			okRuns: 4,
			taught: 4,
			handlesLoaded: 551,
			encoded: 0,
			handlesTaught: 3,
			handlesTaughtKnown: 4,
		});
		expect(note).toContain("3/4 runs");
		expect(note).toContain("HARNESS failure");
	});

	test("without the taught record the 0-encoded result is declared UNATTRIBUTABLE", () => {
		// A run predating `argot_taught` cannot say whether the table reached the
		// model, so the report must refuse to assign blame instead of defaulting to
		// the model. Defaulting is what produced the original wrong verdict, so the
		// absent-evidence path is pinned separately from the taught and untaught ones.
		const note = interpretEncodeArm({ arm: "full", okRuns: 4, taught: 4, handlesLoaded: 37, encoded: 0 });
		expect(note).toContain("no `argot_taught` record");
		expect(note).toContain("unattributable");
		expect(note).not.toContain("model-adoption result");
		expect(note).not.toContain("HARNESS failure");
	});

	test("actual encoding is declared a real measurement, with the vocabulary size", () => {
		// The only state in which a token delta against the encode arm means what
		// the report says it means. It reports both counts so the reader can judge
		// how much of the arm's mass actually used shorthand.
		const note = interpretEncodeArm({ arm: "full", okRuns: 5, taught: 5, handlesLoaded: 37, encoded: 4 });
		expect(note).toContain("encoded in 4/5 runs");
		expect(note).toContain("37 handles");
		expect(note).toContain("real argot measurement");
	});

	test("an unknown vocabulary size (pre-telemetry run) is declared uninterpretable, not assumed empty", () => {
		// A run recorded before the `argot_armed` telemetry existed has null, which
		// must NOT be silently treated as zero — that would fabricate a confident
		// "the corpus had nothing" verdict from missing data (a silent fallback).
		// The honest answer is that the result cannot be read and the run must be
		// repeated.
		const note = interpretEncodeArm({ arm: "full", okRuns: 4, taught: 4, handlesLoaded: null, encoded: 0 });
		expect(note).toContain("UNKNOWN");
		expect(note).toContain("uninterpretable");
		expect(note).toContain("rerun");
		expect(note).not.toContain("IMPOSSIBLE");
	});

	test("an arm that never taught the preamble gets no interpretation", () => {
		// A decode-only or baseline arm is SUPPOSED to show 0 encoded; emitting a
		// note there would read as a defect report on a correctly-behaving arm and
		// bury the one arm whose interpretation matters.
		expect(interpretEncodeArm({ arm: "decode", okRuns: 5, taught: 0, handlesLoaded: 12, encoded: 0 })).toBeNull();
	});

	test("an all-errored arm gets no interpretation rather than a divide-by-nothing claim", () => {
		// With zero completed runs there is no evidence either way; the arm's own
		// Errors row is the honest signal, not a fabricated adoption verdict.
		expect(interpretEncodeArm({ arm: "full", okRuns: 0, taught: 0, handlesLoaded: null, encoded: 0 })).toBeNull();
	});
});

describe("renderReport — the vocab handles column and its interpretation", () => {
	// End-to-end proof that the instrument reaches the operator-visible report
	// (WIRING): a helper that is never rendered fixes nothing.

	test("an empty-dictionary encode arm renders the handle count AND the corpus-inert warning", () => {
		// Reproduces the exact runs/argot-encode-fixed shape (taught, never
		// encoded) with the missing fact supplied: 0 handles. The report must now
		// state the size in the table and explain the null in prose.
		const md = renderReport(
			[
				res({ arm: "full", task: "t1", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: 0 }),
				res({ arm: "full", task: "t2", reward: 0, argotPreamblePresent: true, argotHandlesLoaded: 0 }),
			],
			"m",
			"now",
		);
		expect(md).toContain("vocab handles");
		expect(md).toContain("| full | 2 | 2/2 | 0 |");
		expect(md).toContain("IMPOSSIBLE");
		expect(md).toContain("NOT a measure of argot");
	});

	test("a loaded, TAUGHT, unused vocabulary renders the size and the model-adoption reading", () => {
		// The other real state: the table shows 37, the handles are proven to have
		// reached the model, and only then does the prose charge the null to the
		// model rather than to the corpus or the harness.
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					reward: 1,
					argotPreamblePresent: true,
					argotHandlesLoaded: 37,
					argotHandlesTaught: true,
				}),
				res({
					arm: "full",
					task: "t2",
					reward: 1,
					argotPreamblePresent: true,
					argotHandlesLoaded: 37,
					argotHandlesTaught: true,
				}),
			],
			"m",
			"now",
		);
		expect(md).toContain("| full | 2 | 2/2 | 37 | 2/2 |");
		expect(md).toContain("37 handles were loaded AND taught in 2/2 runs");
		expect(md).toContain("model-adoption result");
	});

	test("a loaded vocabulary the model was never shown renders as a HARNESS failure", () => {
		// The regression that produced the original misreading of runs/argot-smoke-0724.
		// The size column alone looked identical to the model-adoption case above, so
		// the report blamed the model for output it was structurally forbidden to write.
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					reward: 1,
					argotPreamblePresent: true,
					argotHandlesLoaded: 551,
					argotHandlesTaught: false,
				}),
			],
			"m",
			"now",
		);
		expect(md).toContain("| full | 1 | 1/1 | 551 | 0/1 |");
		expect(md).toContain("HARNESS failure");
		expect(md).not.toContain("model-adoption result");
	});

	test("a pre-telemetry run renders an em-dash size, never a fabricated zero", () => {
		// Guards the silent-fallback: an older run's missing record must render as
		// unknown, not as the load-produced-nothing verdict.
		const md = renderReport(
			[res({ arm: "full", task: "t1", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: null })],
			"m",
			"now",
		);
		expect(md).toContain("| full | 1 | 1/1 | — |");
		expect(md).toContain("uninterpretable");
		expect(md).not.toContain("IMPOSSIBLE");
	});

	test("the handle count survives a stray row that lacks the record", () => {
		// A per-repo property is constant across a task's repeats, so one row
		// missing the record (a crashed early session) must not blank the column
		// for the whole arm and destroy the interpretation.
		const md = renderReport(
			[
				res({ arm: "full", task: "t1", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: null }),
				res({ arm: "full", task: "t2", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: 12 }),
			],
			"m",
			"now",
		);
		expect(md).toContain("| full | 2 | 2/2 | 12 |");
		expect(md).toContain("12 handles were loaded");
	});
});

describe("encodeHeadroom — the effect-size ceiling that decides if a run can measure argot at all", () => {
	// The finding this encodes: on the real ytt task the loaded dictionary offered
	// a maximum saving of 0.27% of emitted output while run-to-run token variance
	// was ~9%. Every argot delta that run produced was noise, and no repeat count
	// could have fixed it, because the limit was the WORKLOAD, not the sample size.
	// Nothing in the bench could say so. These lock the arithmetic and the verdict.

	test("counts only handles the model actually emitted, and prices each at expansion minus handle", () => {
		// The core sum. `§pkg` (4 chars with the sigil) standing for a 24-char path
		// emitted twice saves 2*(24-4)=40; a handle never emitted saves nothing and
		// must not inflate the ceiling just by existing in the dictionary.
		const emitted = "edit packages/server/db.ts then packages/server/db.ts again";
		const h = encodeHeadroom(emitted, { pkg: "packages/server/db.ts", unused: "never/typed/path.ts" });
		expect(h.handles).toBe(2);
		expect(h.usableHandles).toBe(1);
		// "packages/server/db.ts" is 21 chars; "§pkg" is 4; twice => 2*17 = 34.
		expect(h.maxSavedChars).toBe(34);
		expect(h.emittedChars).toBe(emitted.length);
		expect(h.maxSavedPct).toBeCloseTo((100 * 34) / emitted.length, 6);
	});

	test("a vocabulary of long strings the model never writes yields a zero ceiling", () => {
		// Exactly the real failure: the dictionary was dominated by license text and
		// example-fixture YAML, which repeat heavily in the repo but which a coding
		// agent never types. Handle count looks healthy, achievable saving is zero.
		const h = encodeHeadroom("fix the bug in pkg/orderedmap/map.go", {
			lic: "use, copy, modify, merge, publish, distribute, sublicense",
			fixture: "app.kubernetes.io/component: controller",
		});
		expect(h.handles).toBe(2);
		expect(h.usableHandles).toBe(0);
		expect(h.maxSavedChars).toBe(0);
		expect(h.maxSavedPct).toBe(0);
	});

	test("occurrences are counted non-overlapping, the way a real encoder substitutes", () => {
		// A self-overlapping expansion must not be double-counted into a ceiling the
		// encoder could never actually realize.
		const h = encodeHeadroom("aaaa", { a: "aa" });
		expect(h.maxSavedChars).toBe(0); // "aa" (2) vs "§a" (2): no saving per occurrence
		expect(h.usableHandles).toBe(1);
	});

	test("an expansion no longer than its handle contributes nothing, never a negative saving", () => {
		// An encoder would simply decline such a handle; letting it subtract would
		// let a junk vocabulary hide real headroom from other handles.
		const h = encodeHeadroom("id id id", { averylongname: "id" });
		expect(h.maxSavedChars).toBe(0);
	});

	test("an empty emission reports a zero percentage rather than dividing by zero", () => {
		const h = encodeHeadroom("", { pkg: "packages/server/db.ts" });
		expect(h.maxSavedPct).toBe(0);
		expect(h.emittedChars).toBe(0);
		expect(Number.isNaN(h.maxSavedPct)).toBe(false);
	});
});

describe("relativeSpreadPct / ceilingBelowNoise — is the ceiling big enough to see", () => {
	test("spread is measured relative to the mean so it compares against a percentage ceiling", () => {
		// Identical samples have no spread: a run whose repeats agree exactly can
		// resolve arbitrarily small effects, so the floor must fall to zero.
		expect(relativeSpreadPct([100, 100, 100])).toBe(0);
		const spread = relativeSpreadPct([90, 110]);
		expect(spread).toBeCloseTo((100 * Math.sqrt(200)) / 100, 6);
	});

	test("fewer than two samples has no observable spread and must not fabricate one", () => {
		// With one sample the run cannot estimate its own noise; claiming 0 would
		// declare every tiny ceiling measurable, which is the error this prevents.
		expect(relativeSpreadPct([100])).toBeNull();
		expect(relativeSpreadPct([])).toBeNull();
	});

	test("the real ytt numbers are correctly judged unmeasurable", () => {
		// 0.27% achievable against ~9% observed noise: the exact case that motivated
		// this instrument. It must come back as cannot-measure.
		expect(ceilingBelowNoise(0.27, 9)).toBe(true);
	});

	test("a ceiling above the noise is measurable", () => {
		expect(ceilingBelowNoise(15, 9)).toBe(false);
	});

	test("with no noise estimate a conservative one-percent floor applies", () => {
		// A single-sample run still must not bless a 0.3% ceiling as detectable.
		expect(ceilingBelowNoise(0.3, null)).toBe(true);
		expect(ceilingBelowNoise(4, null)).toBe(false);
	});
});

describe("collectEmittedText — the denominator must match where handles are counted", () => {
	test("collects assistant text AND tool-call arguments, the same seams the sigil probe scans", () => {
		// If the two disagreed, the ceiling could claim a saving in a place the
		// encode probe never inspects, and the report's two argot numbers would
		// silently describe different runs.
		const text = collectEmittedText([
			{
				role: "assistant",
				content: [{ text: "editing the file" }, { type: "toolCall", arguments: { path: "a/b.ts" } }],
			},
		]);
		expect(text).toContain("editing the file");
		expect(text).toContain("a/b.ts");
	});

	test("excludes tool results, which the model receives rather than emits", () => {
		// Tool output is harness-produced context, not output the model pays for.
		// Counting it would inflate the denominator and understate the ceiling.
		const text = collectEmittedText([
			{ role: "assistant", content: [{ text: "run it" }] },
			{ role: "toolResult", content: [{ text: "MASSIVE COMPILER OUTPUT" }] },
			{ role: "user", content: [{ text: "user text" }] },
		]);
		expect(text).toContain("run it");
		expect(text).not.toContain("MASSIVE COMPILER OUTPUT");
		expect(text).not.toContain("user text");
	});
});

describe("renderReport — the encode headroom section", () => {
	test("a below-noise ceiling is called out as CANNOT MEASURE, not as a null result", () => {
		// The whole point: without this the same run reads "not distinguishable",
		// which invites "we measured argot and it does not help" when the truth is
		// "this workload cannot show it either way".
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					repeat: 0,
					reward: 1,
					outputTokens: 70000,
					encodeHeadroom: {
						emittedChars: 100000,
						handles: 33,
						usableHandles: 7,
						maxSavedChars: 270,
						maxSavedPct: 0.27,
					},
				}),
				res({
					arm: "full",
					task: "t1",
					repeat: 1,
					reward: 1,
					outputTokens: 84000,
					encodeHeadroom: {
						emittedChars: 100000,
						handles: 33,
						usableHandles: 7,
						maxSavedChars: 270,
						maxSavedPct: 0.27,
					},
				}),
			],
			"m",
			"now",
			2,
		);
		expect(md).toContain("Encode headroom");
		expect(md).toContain("CANNOT MEASURE");
		expect(md).toContain("| full | 200000 | 33 | 7 | 540 | 0.27% |");
	});

	test("a ceiling above the noise is reported as measurable", () => {
		// The instrument must not cry wolf on a workload that CAN show the effect,
		// or operators will learn to ignore it.
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					repeat: 0,
					reward: 1,
					outputTokens: 70000,
					encodeHeadroom: {
						emittedChars: 1000,
						handles: 10,
						usableHandles: 9,
						maxSavedChars: 200,
						maxSavedPct: 20,
					},
				}),
				res({
					arm: "full",
					task: "t1",
					repeat: 1,
					reward: 1,
					outputTokens: 70100,
					encodeHeadroom: {
						emittedChars: 1000,
						handles: 10,
						usableHandles: 9,
						maxSavedChars: 200,
						maxSavedPct: 20,
					},
				}),
			],
			"m",
			"now",
			2,
		);
		expect(md).toContain("measurable — the ceiling exceeds");
		expect(md).not.toContain("CANNOT MEASURE");
	});

	test("the section is absent entirely when no run recorded a vocabulary", () => {
		// An older run has nothing to bound, and inventing a ceiling of zero would
		// wrongly declare every such run unmeasurable.
		const md = renderReport([res({ arm: "baseline", task: "t1", reward: 1 })], "m", "now");
		expect(md).not.toContain("Encode headroom");
	});
});

describe("typeableHandleMass — the pre-run screen for whether a repo can measure shorthand at all", () => {
	// Calibration, not assumption: on the first run where encoding fired, all 7
	// handles the model emitted were whitespace-free and NO whitespace-bearing
	// handle was ever emitted (100% recall, 33% precision). That makes a low score
	// a sound one-sided verdict — such a repo cannot show the effect — which is
	// what lets this screen tasks before a multi-hour run instead of after.

	test("prose handles are excluded however much repository mass they carry", () => {
		// The exact shape that produced a 0.27% ceiling: license text and fixture
		// YAML dominate the dictionary by repetition but no agent ever types them.
		// Counting them would rank an unmeasurable repo as a great candidate.
		const m = typeableHandleMass({
			lic: "use, copy, modify, merge, publish, distribute, sublicense",
			fixture: "app.kubernetes.io/component: controller",
			pkg: "carvel.dev/ytt/pkg/orderedmap",
		});
		expect(m.handles).toBe(3);
		expect(m.typeable).toBe(1);
		// "carvel.dev/ytt/pkg/orderedmap" is 29 chars, "§pkg" is 4 => 25.
		expect(m.savingPerEmission).toBe(25);
		expect(m.longestTypeable).toBe(29);
	});

	test("a handle that saves nothing is not counted as reachable mass", () => {
		// An expansion no longer than its handle would never be substituted, so
		// including it would inflate the screen with substitutions that cannot help.
		const m = typeableHandleMass({ averylongname: "short" });
		expect(m.typeable).toBe(0);
		expect(m.savingPerEmission).toBe(0);
	});

	test("an all-prose vocabulary scores zero, the sound 'cannot measure' verdict", () => {
		// The one-sided conclusion this screen is for: whatever the run does, a repo
		// offering nothing an agent types cannot demonstrate a shorthand effect.
		const m = typeableHandleMass({
			a: "the quick brown fox jumps",
			b: "Licensed under the Apache License, Version 2.0",
		});
		expect(m.typeable).toBe(0);
		expect(m.savingPerEmission).toBe(0);
		expect(m.longestTypeable).toBe(0);
	});

	test("import paths and file paths are counted, which is what agents retype", () => {
		// The positive case, taken from the handles the model actually did emit.
		const m = typeableHandleMass({
			star: "github.com/k14s/starlark-go/starlark",
			files: "carvel.dev/ytt/pkg/files",
			src: "packages/coding-agent/src/database/connection.ts",
		});
		expect(m.typeable).toBe(3);
		expect(m.longestTypeable).toBe("packages/coding-agent/src/database/connection.ts".length);
	});

	test("an empty vocabulary is scored without dividing or throwing", () => {
		const m = typeableHandleMass({});
		expect(m).toEqual({
			handles: 0,
			typeable: 0,
			savingPerEmission: 0,
			expectedSavingPerEmission: 0,
			longestTypeable: 0,
		});
	});

	/**
	 * `savingPerEmission` is an UPPER bound and was read as a forecast, which is
	 * how the 16000-token arm came to be built on a 19.07% projected ceiling
	 * against a measured 0.24%. The expected column scales it by the rate a run
	 * actually emits at, so the two numbers are on the same scale.
	 */
	test("expected saving is the typeable bound scaled by the observed emission rate", () => {
		const m = typeableHandleMass({
			files: "carvel.dev/ytt/pkg/files",
			src: "packages/coding-agent/src/database/connection.ts",
		});

		expect(m.expectedSavingPerEmission).toBe(Math.round(m.savingPerEmission * OBSERVED_TYPEABLE_EMISSION_RATE));
		expect(m.expectedSavingPerEmission).toBeLessThan(m.savingPerEmission);
	});

	/**
	 * The rate is the whole correction, so its value is pinned rather than left to
	 * drift: it is 8 of 551 handles emitted on `runs/argot-smoke-0724`, the only
	 * run that has both loaded a dictionary and emitted from it. A later run may
	 * revise it, and this test is what makes that a deliberate act.
	 */
	test("the emission rate is the one measured 8/551, not a rounded guess", () => {
		expect(OBSERVED_TYPEABLE_EMISSION_RATE).toBe(8 / 551);
		expect(OBSERVED_TYPEABLE_EMISSION_RATE).toBeCloseTo(0.0145, 4);
	});

	/**
	 * The reason to trust the correction rather than merely prefer it: applied to
	 * the projection that failed by fifty times, it reproduces the measurement. A
	 * 19.07% projected ceiling scaled by the rate is 0.277%, against a measured
	 * 0.24%. Locked here because that agreement is the entire argument, and a
	 * silent change to the rate would dissolve it without failing anything else.
	 */
	test("the corrected projection reproduces the ceiling the original missed by 50x", () => {
		const correctedCeilingPct = 19.07 * OBSERVED_TYPEABLE_EMISSION_RATE;

		expect(correctedCeilingPct).toBeCloseTo(0.277, 2);
		// Within 20% of the 0.24% the run measured, against 79x for the original.
		expect(Math.abs(correctedCeilingPct - 0.24) / 0.24).toBeLessThan(0.2);
		expect(19.07 / 0.24).toBeGreaterThan(50);
	});

	/**
	 * The consequence that changes what anyone should do next: the corrected
	 * ceiling scales with the dictionary budget while the noise floor does not, so
	 * no budget reaches it. A 16x budget buys a quarter of a percentage point
	 * against a floor of 8.15%. Raising `tokenBudget` is not the lever, and this
	 * is the assertion that says so in a form that cannot be forgotten.
	 */
	test("no dictionary budget brings the expected ceiling near the noise floor", () => {
		const NOISE_FLOOR_PCT = 8.15;
		const projectedByBudget = { 1000: 1.01, 4000: 2.56, 16000: 19.07 };

		for (const projected of Object.values(projectedByBudget)) {
			expect(projected * OBSERVED_TYPEABLE_EMISSION_RATE).toBeLessThan(NOISE_FLOOR_PCT / 10);
		}
		// Even a further 16x on the largest budget, extrapolated linearly, misses.
		expect(19.07 * 16 * OBSERVED_TYPEABLE_EMISSION_RATE).toBeLessThan(NOISE_FLOOR_PCT);
	});
});

describe("efficiency comparison — input tokens are tested, not just displayed", () => {
	// The trap this closes: a feature can buy shorter output by spending prompt.
	// A larger argot dictionary rides in the system prompt every turn, so raising
	// its budget trades input tokens for output tokens. When only output was
	// scored, such an arm read as an unambiguous efficiency win however much input
	// it burned, and the input column sat in the per-arm table where no test
	// touched it.

	test("an arm that saves output but costs input is scored on BOTH", () => {
		// B writes less but reads far more, the exact large-dictionary shape. The
		// report must show an output saving AND an input increase for the same pair,
		// so the reader can weigh the trade instead of seeing only the flattering half.
		const rows: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			rows.push(res({ arm: "a", task: `t${i}`, reward: 1, outputTokens: 1000, inputTokens: 5000 }));
			rows.push(res({ arm: "b", task: `t${i}`, reward: 1, outputTokens: 800, inputTokens: 25000 }));
		}
		const md = renderReport(rows, "m", "now");
		expect(md).toContain("| input tok | a → b |");
		expect(md).toContain("| output tok | a → b |");
		// Output fell by 200 per task and input rose by 20000, both on all 6 tasks.
		expect(md).toContain("-200 tok");
		expect(md).toContain("20000 tok");
	});

	test("the input row reports a rise as dearer, not as a saving", () => {
		// Sign convention guard: B minus A, so a bigger prompt must read positive and
		// be called out as dearer. Inverting it would advertise a cost as a benefit.
		const rows: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			rows.push(res({ arm: "a", task: `t${i}`, reward: 1, outputTokens: 1000, inputTokens: 5000 }));
			rows.push(res({ arm: "b", task: `t${i}`, reward: 1, outputTokens: 1000, inputTokens: 25000 }));
		}
		const md = renderReport(rows, "m", "now");
		const inputRow = md.split("\n").find(l => l.startsWith("| input tok | a → b |")) ?? "";
		expect(inputRow).toContain("b dearer");
	});
});

describe("withinTaskSpreadPct — the noise floor must measure chance, not task difficulty", () => {
	// The bug this fixes: the headroom verdict originally pooled every sample of an
	// arm across tasks to estimate noise. Output size is driven far more by which
	// task is being solved than by run-to-run variance, so the pooled figure was a
	// measure of corpus difficulty. That inflated floor would stamp CANNOT MEASURE
	// on a run whose ceiling comfortably cleared real noise, silently discarding a
	// valid result — the opposite of the error the instrument exists to prevent.

	test("wildly different tasks with perfectly stable repeats report ZERO noise", () => {
		// The exact failure mode. Task A emits 1,000 tokens and task B emits 100,000,
		// but each repeats identically, so there is no run-to-run variance at all.
		// Pooling would report a spread near 140%; the correct answer is 0.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "small", repeat: 0, outputTokens: 1000 }),
			res({ arm: "a", task: "small", repeat: 1, outputTokens: 1000 }),
			res({ arm: "a", task: "huge", repeat: 0, outputTokens: 100000 }),
			res({ arm: "a", task: "huge", repeat: 1, outputTokens: 100000 }),
		];
		expect(withinTaskSpreadPct(rows)).toBe(0);
		// And the pooled calculation really would have been enormous, which is why
		// this test asserts the contrast rather than the fixed value alone.
		expect(relativeSpreadPct([1000, 1000, 100000, 100000])!).toBeGreaterThan(100);
	});

	test("real within-task variation is reported", () => {
		// Two tasks each varying by the same relative amount: the floor is that
		// amount, not something diluted or amplified by their different sizes.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 90 }),
			res({ arm: "a", task: "x", repeat: 1, outputTokens: 110 }),
			res({ arm: "a", task: "y", repeat: 0, outputTokens: 900 }),
			res({ arm: "a", task: "y", repeat: 1, outputTokens: 1100 }),
		];
		const expected = relativeSpreadPct([90, 110])!;
		expect(withinTaskSpreadPct(rows)).toBeCloseTo(expected, 6);
	});

	test("the median across tasks keeps one pathological task from setting the floor", () => {
		// A single erratic task (a retried timeout) must not raise the noise floor for
		// the whole run and suppress an otherwise valid verdict.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "x", repeat: 1, outputTokens: 100 }),
			res({ arm: "a", task: "y", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "y", repeat: 1, outputTokens: 100 }),
			res({ arm: "a", task: "wild", repeat: 0, outputTokens: 10 }),
			res({ arm: "a", task: "wild", repeat: 1, outputTokens: 10000 }),
		];
		expect(withinTaskSpreadPct(rows)).toBe(0);
	});

	test("errored samples are excluded from the floor", () => {
		// An errored run has no trustworthy token count; letting it in would invent
		// variance that never happened.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "x", repeat: 1, outputTokens: 100 }),
			res({ arm: "a", task: "x", repeat: 2, outputTokens: 99999, error: "CancelledError" }),
		];
		expect(withinTaskSpreadPct(rows)).toBe(0);
	});

	test("a single-repeat run has no observable spread", () => {
		// With one sample per task nothing can be said about chance, and the caller
		// falls back to its conservative floor rather than assuming zero noise.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "y", repeat: 0, outputTokens: 5000 }),
		];
		expect(withinTaskSpreadPct(rows)).toBeNull();
	});

	test("the headroom verdict uses the within-task floor, not the pooled one", () => {
		// End-to-end proof on the shape that used to break: two tasks of very
		// different sizes, stable repeats, and a 5% ceiling. Pooled noise would be
		// ~140% and read CANNOT MEASURE; the true floor is 0%, so this is measurable.
		const hr = { emittedChars: 1000, handles: 10, usableHandles: 8, maxSavedChars: 50, maxSavedPct: 5 };
		const rows: ArmResult[] = [
			res({ arm: "full", task: "small", repeat: 0, reward: 1, outputTokens: 1000, encodeHeadroom: hr }),
			res({ arm: "full", task: "small", repeat: 1, reward: 1, outputTokens: 1000, encodeHeadroom: hr }),
			res({ arm: "full", task: "huge", repeat: 0, reward: 1, outputTokens: 100000, encodeHeadroom: hr }),
			res({ arm: "full", task: "huge", repeat: 1, reward: 1, outputTokens: 100000, encodeHeadroom: hr }),
		];
		const md = renderReport(rows, "m", "now", 2);
		expect(md).toContain("measurable — the ceiling exceeds");
		expect(md).not.toContain("CANNOT MEASURE");
	});
});

describe("renderReport is reproducible — output depends on data, not row order", () => {
	// An eval set is iterated on for months, so two renders of the SAME run must
	// produce the same bytes or report-to-report diffs become unreadable. Rows do
	// NOT arrive in a stable order: a live run appends them as jobs finish (which
	// depends on --jobs and on which container is slow) while a reaggregate rebuilds
	// them in readdir order. Arm order was previously taken from that arrival order,
	// so the same run could render "baseline → full" once and "full → baseline" the
	// next time, inverting the sign of every delta.

	function sampleRows(): ArmResult[] {
		const rows: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			rows.push(res({ arm: "full", task: `t${i}`, reward: i <= 4 ? 1 : 0, outputTokens: 900 + i }));
			rows.push(res({ arm: "baseline", task: `t${i}`, reward: i <= 2 ? 1 : 0, outputTokens: 1000 + i }));
			rows.push(res({ arm: "decode", task: `t${i}`, reward: i <= 3 ? 1 : 0, outputTokens: 950 + i }));
		}
		return rows;
	}

	test("a reversed row order renders byte-identically", () => {
		const forward = renderReport(sampleRows(), "m", "now", 1);
		const reversed = renderReport([...sampleRows()].reverse(), "m", "now", 1);
		expect(reversed).toBe(forward);
	});

	test("grouping rows by arm renders byte-identically to interleaved rows", () => {
		// The realistic divergence: a reaggregate walks one arm's job directory at a
		// time, while a live run interleaves arms as containers finish.
		const grouped = [...sampleRows()].sort((a, b) => a.arm.localeCompare(b.arm));
		expect(renderReport(grouped, "m", "now", 1)).toBe(renderReport(sampleRows(), "m", "now", 1));
	});

	test("pair direction is fixed by name, so deltas never invert between renders", () => {
		// The concrete consequence. Whichever arm's rows land first, the comparison
		// must always read baseline → full, never the reverse.
		for (const rows of [sampleRows(), [...sampleRows()].reverse()]) {
			const md = renderReport(rows, "m", "now", 1);
			expect(md).toContain("| baseline → full |");
			expect(md).not.toContain("| full → baseline |");
		}
	});
});

describe("isHardError — the fail-fast canary's definition of a systematic (not task) failure", () => {
	// WHY THIS SUITE EXISTS. A whole bench run (120 jobs × ~1min of container
	// setup) was once burned proving one typo: the default model id was
	// discovery-gated and unservable in the offline sandbox, so EVERY trial died
	// before the agent ran. The canary aborts on exactly that signature. The
	// predicate must fire only for "the agent never produced output" and must NOT
	// misclassify a scored fail or a partial/timed-out run that still emitted
	// tokens — those reflect the task or the arm and are legitimate data, so
	// tripping on them would abort valid runs.
	test("an error with no parsed session (null outputTokens) is a hard error", () => {
		// The unservable-model signature: pier exited non-zero, no session jsonl to
		// parse, so outputTokens stayed null. This is the ONE case that trips.
		expect(isHardError({ error: 'Model "google-antigravity/gemini-3.6-flash" not found', outputTokens: null })).toBe(
			true,
		);
	});

	test("a clean scored fail (error null) is NOT a hard error", () => {
		// reward 0 with real output is the task being hard, not the config being
		// broken. outputTokens is present precisely because the agent ran.
		expect(isHardError({ error: null, outputTokens: 4200 })).toBe(false);
	});

	test("a timed-out run that still produced tokens is NOT a hard error", () => {
		// A timeout sets error, but if the agent emitted tokens before the wall
		// clock cut it off, outputTokens is non-null: the agent DID run, so this is
		// task/arm behavior, not a systematic config failure. Aborting here would
		// throw away a slow-but-valid arm.
		expect(isHardError({ error: "trial timed out after 1800s; pier exit 1; ...", outputTokens: 1536 })).toBe(false);
	});

	test("error set AND zero output tokens is still a hard error (0 is not null)", () => {
		// A run that errored with an explicit zero token count is as dead as one
		// with null: the boundary is `outputTokens === null`, and a genuine 0-token
		// emission with an error is the same "agent never usefully ran" signature.
		expect(isHardError({ error: "boom; pier exit 1", outputTokens: null })).toBe(true);
		// Guard the other side of the boundary: a real (however small) emission with
		// an error is NOT hard, so a one-token partial is preserved as data.
		expect(isHardError({ error: "boom; pier exit 1", outputTokens: 1 })).toBe(false);
	});

	test("no error but null tokens (an unscored/parse-skip) is NOT a hard error", () => {
		// A trial with no error recorded is never systematic-config-dead by this
		// definition, even if usage parsing yielded null — the canary keys on a
		// LOUD error, not on missing usage, so it never trips on a quiet gap.
		expect(isHardError({ error: null, outputTokens: null })).toBe(false);
	});
});

describe("shouldTripCanary — abort only when a full wave is all hard errors", () => {
	// WHY THIS SUITE EXISTS. The abort decision used to be an inline boolean in
	// run.ts, verifiable only by running a whole ~110-min bench. Extracting it here
	// makes the exact trip contract testable: a FULL wave (>= canarySize completed)
	// where EVERY trial is a hard error, and never on a partial mix. Getting this
	// wrong either aborts a valid run (one flaky task among successes) or fails to
	// abort a doomed one (burning the whole queue on a config typo).
	const hard = { error: 'Model "x" not found', outputTokens: null };
	const good = { error: null, outputTokens: 800 };

	test("a full wave of hard errors trips", () => {
		expect(shouldTripCanary([hard, hard, hard, hard], 4)).toBe(true);
	});

	test("does NOT trip before the wave is complete", () => {
		// 3 hard errors but the wave is 4: too early to conclude the config is dead.
		expect(shouldTripCanary([hard, hard, hard], 4)).toBe(false);
	});

	test("one good run in the wave prevents a trip", () => {
		// The critical false-positive guard: a single successful trial proves the
		// config works, so the failures are task flakiness, not a systematic bug.
		expect(shouldTripCanary([hard, good, hard, hard], 4)).toBe(false);
	});

	test("an empty result set never trips", () => {
		// Nothing has run yet; there is nothing to conclude.
		expect(shouldTripCanary([], 4)).toBe(false);
	});

	test("with a canary window of 1, the very first hard error trips", () => {
		// On a single-item queue the wave is 1, so one hard error is a full wave.
		expect(shouldTripCanary([hard], 1)).toBe(true);
		expect(shouldTripCanary([good], 1)).toBe(false);
	});

	test("extra hard errors past the window still trip (stays tripped)", () => {
		// The window is a floor, not a ceiling: more than canarySize all-hard results
		// is still a trip, so a late check after several waves behaves the same.
		expect(shouldTripCanary([hard, hard, hard, hard, hard, hard], 4)).toBe(true);
	});
});

describe("mostCommonAgentReason — the single cause behind an all-errored canary trip", () => {
	// WHY THIS SUITE EXISTS. When the canary trips, the operator needs the ONE
	// reason killing every run, not a wall of repeated stack traces. This returns
	// the mode so the abort message reads `Model "..." not found` once. It must be
	// stable (ties keep first-seen), must ignore blank strings, and must never
	// throw on empty input — the caller only reaches it once at least one hard
	// error exists, but a defensive fallback beats a crash inside an abort path.
	test("returns the most frequent reason across the hard errors", () => {
		const reasons = [
			'Model "gemini-3.6-flash" not found',
			'Model "gemini-3.6-flash" not found',
			"some other transient blip",
			'Model "gemini-3.6-flash" not found',
		];
		expect(mostCommonAgentReason(reasons)).toBe('Model "gemini-3.6-flash" not found');
	});

	test("blank and whitespace-only reasons are ignored, not counted", () => {
		// Hard-error strings can be empty when no agent-side line was captured;
		// those must not win the mode and drown out the real cause.
		const reasons = ["", "   ", "real cause here", "real cause here", ""];
		expect(mostCommonAgentReason(reasons)).toBe("real cause here");
	});

	test("a tie keeps the first-seen reason, so the message is deterministic", () => {
		// Two causes at equal count must resolve the same way every run, or the
		// abort message would flicker between reruns of the same broken config.
		expect(mostCommonAgentReason(["cause A", "cause B"])).toBe("cause A");
	});

	test("all-blank or empty input returns a guidance string, never throws", () => {
		// The abort path must not itself crash. With nothing usable, point the
		// operator at where the real reason lives instead of throwing.
		expect(mostCommonAgentReason([])).toContain("agent/veyyon.txt");
		expect(mostCommonAgentReason(["", "  "])).toContain("agent/veyyon.txt");
	});

	test("reasons are trimmed so trailing whitespace does not split the mode", () => {
		// The same cause captured with and without a trailing newline must collapse
		// to one bucket, or the mode could fragment and pick a rarer cause.
		expect(mostCommonAgentReason(["Model X not found\n", "Model X not found", "  Model X not found  "])).toBe(
			"Model X not found",
		);
	});
});

describe("costIsUnpriced / fmtCost — a provider that reports no price is never shown as $0.000", () => {
	// WHY THIS SUITE EXISTS. The bench runs subscription-tier models (google-antigravity
	// flash) whose provider returns `usage.cost.total: 0` on every message while the
	// model burns thousands of tokens: the 0 means "never priced", not "free". Summing
	// it and printing `$0.000` is a silent fallback (Law 10) — it reads as a real, cheap
	// price and lets a cost verdict rest on a number the provider never produced. The
	// summary and per-task columns must instead read `unpriced` / `—`, and the report
	// must say why once, loudly. A genuinely priced arm must still show its dollars.
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("an arm with 0 cost but real output tokens is unpriced, not free", () => {
		// The exact google-antigravity signature: tokens flowed, cost stayed 0.
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 900, costUsd: 0 }),
			res({ reward: 0, outputTokens: 1100, costUsd: 0 }),
		]);
		expect(s.costPriced).toBe(false);
		expect(costIsUnpriced(s)).toBe(true);
		expect(fmtCost(s, "sum")).toBe("unpriced");
		expect(fmtCost(s, "mean")).toBe("—");
	});

	test("an arm with a real positive cost is priced and shows dollars", () => {
		// The contrast case: any positive provider cost proves the model is priced,
		// so the dollar figure is real and must be rendered, not hidden.
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 900, costUsd: 0.12 }),
			res({ reward: 1, outputTokens: 800, costUsd: 0.1 }),
		]);
		expect(s.costPriced).toBe(true);
		expect(costIsUnpriced(s)).toBe(false);
		expect(fmtCost(s, "sum")).toBe("$0.220");
		expect(fmtCost(s, "mean")).toBe("$0.110");
	});

	test("a mix where at least one run is priced counts the whole arm as priced", () => {
		// If even one run carried a price, the model IS priced; the zeros are just
		// runs the provider happened not to bill, not evidence of an unpriced model.
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 900, costUsd: 0 }),
			res({ reward: 1, outputTokens: 800, costUsd: 0.05 }),
		]);
		expect(s.costPriced).toBe(true);
		expect(costIsUnpriced(s)).toBe(false);
		expect(fmtCost(s, "sum")).toBe("$0.050");
	});

	test("an all-errored arm (no output at all) is empty, not unpriced", () => {
		// A cell with zero OK samples produced no tokens, so calling it "unpriced"
		// would be wrong — there is simply nothing to price. It must not trip the
		// unpriced path and must not emit the loud note on its own.
		const s = summarizeCell([res({ error: "boom", outputTokens: null, costUsd: null })]);
		expect(costIsUnpriced(s)).toBe(false);
	});

	test("the summary and per-task tables render `unpriced`/`—`, never `$0.000`", () => {
		// End to end: an unpriced run must never show a fabricated dollar amount in
		// either table. This is the regression that the silent `$0.000` created.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 3; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, costUsd: 0 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, costUsd: 0 }));
		}
		const report = renderReport(results, "google-antigravity/gemini-3.5-flash", STAMP, 1);
		expect(report).not.toContain("$0.000");
		expect(report).toContain("| unpriced |"); // the per-arm totals cost cell
		expect(report).toContain("Cost is `unpriced` for at least one arm.");
	});

	test("the efficiency cost row says `unpriced`, coherent with the per-arm totals table", () => {
		// The coherence contract: a reader must not see `unpriced` in the totals table
		// and a differently-worded blank in the efficiency table for the SAME fact. The
		// cost metric with no signal reads `cost unpriced`, not the generic token-metric
		// wording, so both sections tell one story.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 3; i++) {
			results.push(
				res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, inputTokens: 500, costUsd: 0 }),
			);
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, inputTokens: 700, costUsd: 0 }));
		}
		const report = renderReport(results, "google-antigravity/gemini-3.5-flash", STAMP, 1);
		expect(report).toContain("cost unpriced — provider reported no price");
		// The token metrics DID have signal here, so they must NOT borrow the cost wording.
		expect(report).not.toContain("output tok | — | — | — | — | — | — | — | not measured");
	});

	test("a priced run keeps its dollars and emits no unpriced note", () => {
		// The guard against over-firing: when the provider DID price the run, the
		// report shows dollars and never prints the unpriced explanation.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 3; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, costUsd: 0.2 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, costUsd: 0.15 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("$0.600"); // decode sum: 3 × 0.2
		expect(report).not.toContain("Cost is `unpriced`");
	});
});

describe("emptyArmResult — one owner for the blank trial result", () => {
	/**
	 * WHY THESE EXIST. The blank ArmResult was hand-written in three places in
	 * `run.ts` (the parse path, the per-trial error path, and the reaggregate error
	 * path) and a fourth time as this suite's own fixture. The copies had already
	 * drifted in different directions: the parse path omitted `error`, and the
	 * reaggregate error path omitted `argotHandlesLoaded` and `encodeHeadroom`.
	 *
	 * That last drift is the damaging one. Those two fields are what make a
	 * `0 encoded` run interpretable at all: how many handles the dictionary
	 * actually loaded, and the headroom the trial could have used. Re-aggregating a
	 * finished run therefore rewrote its results.json into the older format where
	 * "the model ignored the handles" and "there were no handles" are
	 * indistinguishable, which is the exact confusion EVAL-ARGOT-NEVER-ENCODED is
	 * blocked on. Nothing caught it because the package declared no `check:types`
	 * and the workspace typecheck skipped it with `--if-present`.
	 */

	/** The three identity fields are the only inputs, and they must arrive intact. */
	test("carries the trial's identity through unchanged", () => {
		const blank = emptyArmResult("full-budget16k", "django__django-11099", 3);
		expect(blank.arm).toBe("full-budget16k");
		expect(blank.task).toBe("django__django-11099");
		expect(blank.repeat).toBe(3);
	});

	/**
	 * Every measurement starts unknown. `null` is not interchangeable with 0 here:
	 * a defaulted 0 would claim the dictionary loaded no handles and that the trial
	 * made no tool calls, turning missing data into a measured result.
	 */
	test("leaves every measurement null, never zero", () => {
		const blank = emptyArmResult("a", "t", 0);
		const { arm: _a, task: _t, repeat: _r, ...measurements } = blank;
		const nonNull = Object.entries(measurements).filter(([, value]) => value !== null);
		expect(nonNull).toEqual([]);
	});

	/**
	 * The three fields the drifted copies dropped, named explicitly. A generic
	 * "all null" assertion passes just as happily on an object that is missing
	 * them, since `undefined !== null` never gets compared when the key is absent.
	 */
	test("declares the three fields the hand-written copies had dropped", () => {
		const blank = emptyArmResult("a", "t", 0);
		for (const key of ["error", "argotHandlesLoaded", "encodeHeadroom"] as const) {
			expect(Object.hasOwn(blank, key), `${key} must be present, not merely undefined`).toBe(true);
			expect(blank[key]).toBeNull();
		}
	});

	/**
	 * A fresh object per call. Returning a shared constant would let one trial's
	 * parsed reward leak into every later blank result.
	 */
	test("returns an independent object each call", () => {
		const first = emptyArmResult("a", "t", 0);
		const second = emptyArmResult("a", "t", 0);
		expect(first).not.toBe(second);
		first.reward = 1;
		expect(second.reward).toBeNull();
	});
});

describe("no second blank-ArmResult literal may reappear", () => {
	/**
	 * The durable half of the ONE PLACE fix. Collapsing three hand-written copies
	 * into `emptyArmResult` only helps while a fourth does not get pasted back in,
	 * and the previous copies were invisible for exactly as long as nothing looked
	 * for them. A type error would not have caught the drift either, since each
	 * copy was individually well-typed at the site that used it.
	 *
	 * Matches the SHAPE (three consecutive blank measurement fields), not a
	 * variable name, so a copy under any name is still caught.
	 */
	const BLANK_SHAPE = /reward:\s*null,\s*\n\s*partial:\s*null,\s*\n\s*f2p:\s*null,/;

	test("only aggregate.ts spells out the blank trial result", () => {
		const dir = fileURLToPath(new URL(".", import.meta.url));
		const offenders = readdirSync(dir)
			.filter(name => name.endsWith(".ts") && name !== "aggregate.ts")
			.filter(name => BLANK_SHAPE.test(readFileSync(join(dir, name), "utf8")));
		expect(
			offenders,
			"these spell out a blank ArmResult by hand; call emptyArmResult(arm, task, repeat) instead, " +
				"so a field added to ArmResult cannot be forgotten by one copy",
		).toEqual([]);
	});

	/** The positive twin: an empty offender list is also what deleting the factory
	 * produces, so pin that the one owner still spells the shape out. */
	test("aggregate.ts still owns the spelled-out shape", () => {
		const dir = fileURLToPath(new URL(".", import.meta.url));
		expect(BLANK_SHAPE.test(readFileSync(join(dir, "aggregate.ts"), "utf8"))).toBe(true);
	});
});

describe("timeoutRate — the share of a cell the harness killed", () => {
	const timeout = () => res({ error: "trial timed out after 900s", outputTokens: null, reward: null });

	/** A cell nobody truncated has a real rate of zero, not an absent one. */
	test("is 0 when nothing timed out", () => {
		expect(timeoutRate(summarizeCell([res({ reward: 1 }), res({ reward: 0 })]))).toBe(0);
	});

	/** The denominator is `n` (scored plus timed out), matching the pass rate's. */
	test("divides timeouts by the pass-rate denominator, not the row count", () => {
		// One infra error is excluded from n entirely, so 1 timeout over 2 scored
		// plus 1 timed out is 1/3, not 1/4.
		const s = summarizeCell([
			res({ reward: 1 }),
			res({ reward: 0 }),
			timeout(),
			res({ error: 'Model "x" not found' }),
		]);
		expect(s.n).toBe(3);
		expect(timeoutRate(s)).toBeCloseTo(1 / 3, 10);
	});

	/**
	 * A rate over zero samples is absent, not zero. Returning 0 here would make an
	 * all-errored arm look like a cleanly-completed one to the attribution guard.
	 */
	test("is null when the cell scored nothing at all", () => {
		expect(timeoutRate(summarizeCell([res({ error: 'Model "x" not found' })]))).toBeNull();
		expect(timeoutRate(summarizeCell([]))).toBeNull();
	});
});

describe("rewardDeltaAttribution — a reward delta a timeout gap could have produced", () => {
	const timeout = () => res({ error: "trial timed out after 900s", outputTokens: null, reward: null });
	const cell = (rewards: number[], timeouts: number) =>
		summarizeCell([...rewards.map(reward => res({ reward })), ...Array.from({ length: timeouts }, timeout)]);

	/**
	 * THE POINT OF THE GUARD. A timed-out trial enters the mean reward as a hard
	 * zero. That is correct only while both arms are truncated equally, and they
	 * are not: an arm that is slower per turn hits the ceiling more often, so the
	 * gap injects exactly the zeros that make the slower arm look worse. Here the
	 * gap (0.5) is larger than the delta (0.2), so the delta could be entirely
	 * harness truncation and no verdict may be printed.
	 */
	test("refuses a delta the timeout gap is large enough to have manufactured", () => {
		const a = cell([1, 1], 0);
		const b = cell([1, 1], 2);
		const attribution = rewardDeltaAttribution(a, b, -0.2);

		expect(attribution.rateGap).toBeCloseTo(0.5, 10);
		expect(attribution.unattributable).toBe(true);
	});

	/**
	 * A small gap can shade a number without manufacturing it. Withholding every
	 * verdict on any gap at all would make the guard useless on a long run where
	 * one stray timeout is inevitable, so the bar is proportional to the effect.
	 */
	test("allows a delta far larger than the timeout gap that could bias it", () => {
		const a = cell(
			Array.from({ length: 19 }, () => 1),
			0,
		);
		const b = cell(
			Array.from({ length: 19 }, () => 1),
			1,
		);
		const attribution = rewardDeltaAttribution(a, b, -0.6);

		expect(attribution.rateGap).toBeCloseTo(0.05, 10);
		expect(attribution.unattributable).toBe(false);
	});

	/** Equal truncation is comparable truncation: the pairing survives it. */
	test("allows a delta when both arms timed out the same share", () => {
		const a = cell([1, 1], 1);
		const b = cell([0, 0], 1);
		expect(rewardDeltaAttribution(a, b, -0.5).unattributable).toBe(false);
	});

	/** The common case must not be noisy: no timeouts anywhere means no guard. */
	test("allows every delta in a run with no timeouts", () => {
		expect(rewardDeltaAttribution(cell([1, 1], 0), cell([0, 0], 0), -1).unattributable).toBe(false);
	});

	/** Exactly equal gap and effect is the boundary, and it goes to the guard. */
	test("refuses at the boundary where the gap exactly equals the effect", () => {
		const a = cell([1, 1, 1, 1], 0);
		const b = cell([1, 1, 1, 1], 1);
		const attribution = rewardDeltaAttribution(a, b, -0.2);

		expect(attribution.rateGap).toBeCloseTo(0.2, 10);
		expect(attribution.unattributable).toBe(true);
	});

	/** The sign of the delta is irrelevant; a gap can inflate as well as depress. */
	test("applies the same bar to a positive delta", () => {
		const a = cell([1, 1], 2);
		const b = cell([1, 1], 0);
		expect(rewardDeltaAttribution(a, b, 0.2).unattributable).toBe(true);
	});

	/**
	 * With no measured delta there is nothing for the gap to explain away.
	 * Marking such a pair unattributable would replace an honest "—" with a
	 * caveat about a comparison that was never made.
	 */
	test("stays quiet when there is no delta to attribute", () => {
		expect(rewardDeltaAttribution(cell([1], 0), cell([1], 3), null).unattributable).toBe(false);
	});

	/** An arm that scored nothing has no rate, so there is no gap to judge. */
	test("stays quiet when one arm scored nothing at all", () => {
		const empty = summarizeCell([res({ error: 'Model "x" not found' })]);
		const attribution = rewardDeltaAttribution(empty, cell([1], 2), -0.4);

		expect(attribution.rateA).toBeNull();
		expect(attribution.rateGap).toBeNull();
		expect(attribution.unattributable).toBe(false);
	});

	/** The raw counts travel with the verdict so a caller can report them. */
	test("reports both arms' timeout counts", () => {
		const attribution = rewardDeltaAttribution(cell([1], 0), cell([1], 2), -0.4);
		expect(attribution.timedOutA).toBe(0);
		expect(attribution.timedOutB).toBe(2);
	});
});

describe("efficiencyDeltaAttribution — token means censored by different amounts", () => {
	const timeout = () => res({ error: "trial timed out after 900s", outputTokens: null, reward: null });
	const cell = (rewards: number[], timeouts: number) =>
		summarizeCell([...rewards.map(reward => res({ reward })), ...Array.from({ length: timeouts }, timeout)]);

	/**
	 * STRICTER THAN THE REWARD GUARD ON PURPOSE. A timed-out trial records no
	 * token counts, so it is dropped from every token and cost mean, and the
	 * dropped runs are the slowest ones by construction — the same direction the
	 * metric measures. One extra drop on one side means the two means were taken
	 * over differently-censored subsets, and no threshold repairs that.
	 */
	test("refuses on a single timeout of difference", () => {
		expect(efficiencyDeltaAttribution(cell([1, 1, 1, 1, 1], 0), cell([1, 1, 1, 1, 1], 1)).unattributable).toBe(true);
	});

	/** Equal censoring on both sides leaves the comparison paired and usable. */
	test("allows equal timeout counts even when both are large", () => {
		expect(efficiencyDeltaAttribution(cell([1], 5), cell([1], 5)).unattributable).toBe(false);
	});

	/** No timeouts anywhere is the ordinary case and must not warn. */
	test("allows a run with no timeouts", () => {
		expect(efficiencyDeltaAttribution(cell([1, 1], 0), cell([1, 1], 0)).unattributable).toBe(false);
	});

	/**
	 * It compares COUNTS, not rates. Two arms that dropped the same fraction but
	 * different absolute numbers still dropped different runs out of the mean.
	 */
	test("refuses when the counts differ even if the rates match", () => {
		const a = cell([1, 1], 2);
		const b = cell([1, 1, 1, 1], 4);
		expect(a.timedOut).not.toBe(b.timedOut);
		expect(timeoutRate(a)).toBeCloseTo(timeoutRate(b) ?? -1, 10);
		expect(efficiencyDeltaAttribution(a, b).unattributable).toBe(true);
	});
});

describe("timeoutAttributionBanner — saying it before the tables a reader acts on", () => {
	const timeout = () => res({ error: "trial timed out after 900s", outputTokens: null, reward: null });
	const rows = (arm: string, rewards: number[], timeouts: number) => [
		...rewards.map((reward, i) => res({ arm, task: `t${i}`, reward })),
		...Array.from({ length: timeouts }, (_, i) => ({ ...timeout(), arm, task: `to${i}` })),
	];

	/** A clean run gets no banner; the caller prints only what exists. */
	test("is undefined when no arm timed out", () => {
		expect(timeoutAttributionBanner([...rows("a", [1, 0], 0), ...rows("b", [1, 1], 0)], ["a", "b"])).toBeUndefined();
	});

	/** The counts are the operator's first question: how much of the run is this. */
	test("names each affected arm with its timeout count over its denominator", () => {
		const banner = timeoutAttributionBanner([...rows("a", [1, 1], 0), ...rows("b", [1, 1], 2)], ["a", "b"]) ?? "";
		expect(banner).toContain("b: 2/4");
		expect(banner).not.toContain("a: 0/");
	});

	/**
	 * The asymmetric case is the dangerous one, and the banner has to say what to
	 * DO about it. An operator told only "trials timed out" will still read the
	 * winner off the table below.
	 */
	test("tells the operator the arms timed out unevenly and how to fix the run", () => {
		const banner = timeoutAttributionBanner([...rows("a", [1, 1], 0), ...rows("b", [1, 1], 2)], ["a", "b"]) ?? "";
		expect(banner).toContain("did NOT time out equally");
		expect(banner).toContain(TIMEOUT_UNATTRIBUTABLE_VERDICT);
		expect(banner).toContain("`task.toml`");
	});

	/**
	 * Equal truncation still depresses the absolute pass rates even though the
	 * paired deltas survive, so the banner must not read as an all-clear.
	 */
	test("still warns when the arms timed out equally, without claiming the deltas are broken", () => {
		const banner = timeoutAttributionBanner([...rows("a", [1, 1], 2), ...rows("b", [1, 1], 2)], ["a", "b"]) ?? "";
		expect(banner).toContain("the same number of times");
		expect(banner).toContain("still depressed by the truncation");
		expect(banner).not.toContain("did NOT time out equally");
	});

	/** A timeout is never an agent failure, and the banner has to say which it is. */
	test("distinguishes a harness kill from an agent failure", () => {
		const banner = timeoutAttributionBanner([...rows("a", [1], 1)], ["a"]) ?? "";
		expect(banner).toContain("not an agent failure");
		expect(banner).toContain("excluded from every token and cost mean");
	});
});

describe("renderReport — the timeout guard reaches the printed verdicts", () => {
	const timeout = (arm: string, task: string) =>
		res({ arm, task, error: "trial timed out after 900s", outputTokens: null, reward: null });
	const ok = (arm: string, task: string, reward: number, outputTokens: number) =>
		res({ arm, task, reward, outputTokens, inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });

	/**
	 * The end-to-end lock. Everything above tests the predicate; this proves the
	 * predicate actually reaches the markdown a human reads, which is where the
	 * original bug did its damage — the report had no column that would have
	 * revealed the asymmetry at all.
	 */
	test("prints the banner and withholds verdicts when one arm times out more", () => {
		const results = [
			...["t1", "t2", "t3", "t4"].map(t => ok("a", t, 1, 5000)),
			...["t1", "t2"].map(t => ok("b", t, 1, 3000)),
			...["t3", "t4"].map(t => timeout("b", t)),
		];
		const report = renderReport(results, "m", "2026-07-25T00:00:00Z", 1);

		expect(report).toContain("The harness killed trials in this run");
		expect(report).toContain("did NOT time out equally");
		expect(report).toContain(TIMEOUT_UNATTRIBUTABLE_VERDICT);
	});

	/**
	 * The guard must not fire on a clean run, or every honest report grows a
	 * caveat that means nothing and readers learn to skip it.
	 */
	test("prints no timeout banner and normal verdicts when nothing timed out", () => {
		const results = [
			...["t1", "t2", "t3", "t4"].map(t => ok("a", t, 1, 5000)),
			...["t1", "t2", "t3", "t4"].map(t => ok("b", t, 1, 3000)),
		];
		const report = renderReport(results, "m", "2026-07-25T00:00:00Z", 1);

		expect(report).not.toContain("The harness killed trials in this run");
		expect(report).not.toContain(TIMEOUT_UNATTRIBUTABLE_VERDICT);
	});

	/**
	 * The samples column has to show the timeout count even when the guard stays
	 * quiet, so an equal-truncation run is still legible as truncated.
	 */
	test("annotates the samples column with the timeout count", () => {
		const results = [
			...["t1", "t2"].map(t => ok("a", t, 1, 5000)),
			timeout("a", "t3"),
			...["t1", "t2"].map(t => ok("b", t, 1, 3000)),
			timeout("b", "t3"),
		];
		const report = renderReport(results, "m", "2026-07-25T00:00:00Z", 1);

		expect(report).toContain("1 timed out");
		expect(report).not.toContain(TIMEOUT_UNATTRIBUTABLE_VERDICT);
	});
});

describe("renderReport — partial credit is the continuous correctness metric", () => {
	const STAMP = "2026-07-23T00:00:00.000Z";

	/**
	 * The nine partial values recorded on a real baseline run over the diverse-20
	 * task set, alongside the binary reward each one scored. This is the shape the
	 * whole section exists for: eight of these tasks score reward=0, and five of
	 * those eight are within two percent of a full pass. Any fixture that invents
	 * round numbers would hide exactly the effect being guarded.
	 */
	const REAL_BASELINE: ReadonlyArray<{ task: string; reward: number; partial: number }> = [
		{ task: "drizzle-orm-window-function-builders", reward: 1, partial: 1.0 },
		{ task: "fastapi-implicit-head-options", reward: 1, partial: 1.0 },
		{ task: "happy-dom-abort-pending-body-reads", reward: 1, partial: 1.0 },
		{ task: "httpx-streaming-json-iteration", reward: 1, partial: 1.0 },
		{ task: "prometheus-transactional-reload-status", reward: 1, partial: 1.0 },
		{ task: "ts-pattern-match-each", reward: 1, partial: 1.0 },
		{ task: "wazero-multi-module-snapshots", reward: 1, partial: 1.0 },
		{ task: "effect-sse-httpapi-streaming", reward: 0, partial: 0.8547008547008547 },
		{ task: "etree-xml-diff-patch", reward: 0, partial: 0.9850746268656716 },
		{ task: "koota-deferred-mutation-buffer", reward: 0, partial: 0.9849246231155779 },
		{ task: "superjson-error-stack-serialization", reward: 0, partial: 0.9744897959183674 },
		{ task: "tengo-destructuring-bindings", reward: 0, partial: 0.9775784753363229 },
		{ task: "valibot-recursive-schema-composition", reward: 0, partial: 0.9634703196347032 },
		{ task: "yaegi-go-embed-directives", reward: 0, partial: 0.9791666666666666 },
		{ task: "ytt-jsonpath-query-api", reward: 0, partial: 0.9807692307692307 },
	];

	/** Both arms over the same tasks, with B losing `drop` of partial credit on every one. */
	function armsWithPartialDrop(drop: number): ArmResult[] {
		const out: ArmResult[] = [];
		for (const row of REAL_BASELINE) {
			out.push(res({ arm: "baseline", task: row.task, repeat: 0, reward: row.reward, partial: row.partial }));
			out.push(
				res({
					arm: "candidate",
					task: row.task,
					repeat: 0,
					reward: row.reward,
					partial: Math.max(0, row.partial - drop),
				}),
			);
		}
		return out;
	}

	/**
	 * The premise the whole section rests on, asserted against real data rather
	 * than assumed. If the verifier ever starts returning a fractional reward this
	 * fails, and the prose claiming reward is binary has to be revisited.
	 */
	test("reward really is binary on this verifier, so it cannot carry the signal", () => {
		const distinct = new Set(REAL_BASELINE.map(row => row.reward));
		expect([...distinct].sort()).toEqual([0, 1]);
		const partials = new Set(REAL_BASELINE.map(row => row.partial));
		expect(partials.size).toBeGreaterThan(distinct.size);
	});

	/**
	 * The report has to show the operator the continuous number, not only consult
	 * it inside a verdict. A guardrail nobody can see is a guardrail nobody trusts.
	 */
	test("renders a partial-credit comparison table", () => {
		const report = renderReport(armsWithPartialDrop(0.02), "m", STAMP, 1);
		expect(report).toContain("## Partial-credit comparison — the continuous metric (paired by task)");
		expect(report).toContain("Δ mean partial");
	});

	/**
	 * The defect this fixes, stated as a test. Every task keeps its pass/fail, so
	 * the pass-rate and reward tables see nothing at all; only partial credit
	 * moves. The report must call that a loss for the candidate.
	 */
	test("catches a regression that leaves every task's pass/fail untouched", () => {
		const report = renderReport(armsWithPartialDrop(0.02), "m", STAMP, 1);
		expect(report).toContain("candidate lower partial credit");
	});

	/**
	 * And the consequence that matters: a cheaper arm that quietly lost partial
	 * credit must not be reported as a clean win. Before this, `reward held` was
	 * two spellings of the same binary question and this arm would have shipped.
	 */
	test("a cheaper arm that lost partial credit is not reported as reward held", () => {
		const results = armsWithPartialDrop(0.02).map(r =>
			r.arm === "candidate"
				? { ...r, outputTokens: 1000, costUsd: 0.1 }
				: { ...r, outputTokens: 4000, costUsd: 0.4 },
		);
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("cheaper BUT reward dropped");
		expect(report).not.toContain("cheaper, reward held");
	});

	/**
	 * The other direction, so the guardrail is not simply always vetoing. Identical
	 * partial credit on every task must leave a genuine cost win intact.
	 */
	test("a cheaper arm that held partial credit still reads as reward held", () => {
		const results = armsWithPartialDrop(0).map(r =>
			r.arm === "candidate"
				? { ...r, outputTokens: 1000, costUsd: 0.1 }
				: { ...r, outputTokens: 4000, costUsd: 0.4 },
		);
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).not.toContain("cheaper BUT reward dropped");
	});
});
