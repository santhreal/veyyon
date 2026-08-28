/**
 * WHY THIS SUITE DEFENDS TIMEOUT CLASSIFICATION AND DENOMINATOR INTEGRITY.
 *
 * A trial that times out is an agent failure that ran every allowed second, not
 * missing data or an infrastructure crash. Excluding timeouts inflates pass rates
 * by dropping hard tasks and credits slower, overhead-heavy arms that time out
 * more frequently. Timeouts must be counted as failures in the pass-rate denominator,
 * excluded from token/cost averages of completed tasks, and guarded by attribution
 * checks that prevent declaring victory on timeout gaps.
 *
 * What this does not catch: an agent hanging on an unhandled socket rather than model deliberation.
 */

import { describe, expect, test } from "bun:test";
import { shouldTripCanary } from "../../../suites/deep-swe/aggregate/canary";
import { isAgentTimeout, isHardError, NO_REWARD_ERROR } from "../../../suites/deep-swe/aggregate/error-classification";
import {
	efficiencyDeltaAttribution,
	renderReport,
	rewardDeltaAttribution,
	TIMEOUT_UNATTRIBUTABLE_VERDICT,
	timeoutAttributionBanner,
	timeoutRate,
} from "../../../suites/deep-swe/aggregate/report-render";
import { summarizeCell } from "../../../suites/deep-swe/aggregate/stats";
import { res } from "./aggregate-test-helpers";

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
