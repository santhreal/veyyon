/**
 * WHY THIS SUITE DEFENDS PAIRED TASK COMPARISON AND SIGNIFICANCE CONTRACTS.
 *
 * Comparing benchmark arms by overlapping aggregate confidence intervals is
 * statistically unsound when trials are paired by task: task difficulty variance
 * swamps arm variance. Arms must be compared paired task-by-task with sign tests,
 * corrected for family-wise error across multiple arm pairs with Holm-Bonferroni
 * step-down adjustments, and explicit distinctions made between underpowered
 * sweeps and true measured nulls.
 *
 * What this does not catch: provider-level drift between arms run asynchronously
 * across different days.
 */

import { describe, expect, test } from "bun:test";
import { renderReport } from "../../../src/suites/deep-swe/aggregate/report-render";
import {
	holmBonferroni,
	pairwiseArmDeltas,
	pairwiseMetricDeltas,
	signTestPValue,
	sweepCanReachSignificance,
} from "../../../src/suites/deep-swe/aggregate/stats";
import type { ArmResult } from "../../../src/suites/deep-swe/aggregate/types";
import { res } from "./aggregate-test-helpers";

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
