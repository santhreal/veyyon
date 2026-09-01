/**
 * Setting a lever's predicted saving against what the run actually billed.
 *
 * WHY THE COMPARISON MATTERS MORE THAN EITHER NUMBER. Every cost figure this bench
 * produces before a run is a simulation over transcripts, and a simulation can be
 * confidently wrong in ways no unit test catches. It happened here: the tool-result
 * cap counted `read` output, which the shipped spill exempts on purpose, and so
 * reported a 5 KB threshold as 24.9% of the bill when the real lever reaches 13.6%.
 * Nothing about that error was visible from inside the simulation.
 *
 * Only a run that spends real quota can settle it, and only if the two numbers are
 * actually put side by side afterwards. A small gap means the instrument can be
 * trusted for the NEXT lever, which is worth more than any single arm: it is the
 * difference between predicting savings and having to buy every answer.
 *
 * The second half of this suite is about a subtler way to get the actual number
 * wrong. Cost is a SUM, so an arm that completed more tasks looks more expensive for
 * a reason that has nothing to do with the lever, and under quota truncation that is
 * the normal case rather than an edge one.
 */

import { describe, expect, test } from "bun:test";

import { type ArmResult, emptyArmResult, onPairedTasks, predictedVsActual, renderReport } from "./aggregate";

/**
 * A scored trial with a token mix.
 *
 * Built from `emptyArmResult` rather than a literal on purpose: a second spelled-out
 * blank `ArmResult` is a duplicate definition of the trial shape, and the repo has a
 * test that fails when one reappears. Copies drift, and a drifted copy in a COST test
 * would price a field the real results no longer carry.
 */
function trial(arm: string, task: string, input: number, cacheRead: number, output: number): ArmResult {
	return {
		...emptyArmResult(arm, task, 0),
		reward: 1,
		inputTokens: input,
		outputTokens: output,
		cacheTokens: cacheRead,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: 0,
	};
}

/** An errored trial: no usage at all, because it never reached the provider. */
function errored(arm: string, task: string): ArmResult {
	return { ...emptyArmResult(arm, task, 0), error: "QUOTA_EXHAUSTED" };
}

/**
 * A trial killed by a provider quota that still recorded a usage block of ZEROES.
 *
 * This is not a hypothetical shape. It is what `runs/2026-07-25T20-46-08-607Z`
 * holds for all ten of its `sig-last1` trials, and it is the difference between an
 * arm being skipped and an arm being counted as free.
 */
function billedNothing(arm: string, task: string): ArmResult {
	return {
		...emptyArmResult(arm, task, 0),
		error: "QUOTA_EXHAUSTED",
		inputTokens: 0,
		outputTokens: 0,
		cacheTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
}

describe("predictedVsActual — did the predicted saving actually materialise", () => {
	/**
	 * A treatment that halves the cache-read line against a prediction of exactly that
	 * saving reports a gap of zero. This is the shape of the answer the instrument is
	 * trying to earn.
	 */
	test("reports a zero gap when the prediction is exactly right", () => {
		const results = [trial("baseline", "a", 0, 1_000_000, 0), trial("treat", "a", 0, 500_000, 0)];
		const verdict = predictedVsActual(results, "baseline", "treat", 0.5);
		expect(verdict).not.toBeNull();
		expect(verdict?.actual).toBeCloseTo(0.5, 10);
		expect(verdict?.gap).toBeCloseTo(0, 10);
	});

	/**
	 * AN OPTIMISTIC SIMULATION SHOWS AS A NEGATIVE GAP, which is the outcome that
	 * should make every other prediction in the module suspect. Here the lever was
	 * predicted to save half and delivered a quarter.
	 */
	test("reports a negative gap when the lever underdelivers", () => {
		const results = [trial("baseline", "a", 0, 1_000_000, 0), trial("treat", "a", 0, 750_000, 0)];
		const verdict = predictedVsActual(results, "baseline", "treat", 0.5);
		expect(verdict?.actual).toBeCloseTo(0.25, 10);
		expect(verdict?.gap).toBeCloseTo(-0.25, 10);
	});

	/** An arm that costs MORE than baseline reports a negative saving rather than clamping to zero. */
	test("reports a negative saving for an arm that costs more", () => {
		const results = [trial("baseline", "a", 0, 1_000_000, 0), trial("treat", "a", 0, 1_500_000, 0)];
		expect(predictedVsActual(results, "baseline", "treat", 0.2)?.actual).toBeCloseTo(-0.5, 10);
	});

	/**
	 * OUTPUT TOKENS ARE IN THE BILL AND ARE NOT SHRUNK BY A CONTEXT LEVER, so a
	 * prefix saving is diluted by the output line. Pricing only the prompt lines
	 * would overstate every measured saving the same way quoting a prefix share as a
	 * bill share overstates every predicted one.
	 */
	test("dilutes the saving by the output line, which a context lever does not shrink", () => {
		// The treatment keeps a token of prefix rather than exactly none. A request with
		// zero prompt tokens is not a thing a provider can bill for, and it is the exact
		// signature of a trial that died before reaching the model, which the comparison
		// now refuses on purpose. An impossible fixture would be testing the refusal
		// instead of the dilution it is named for.
		const results = [trial("baseline", "a", 0, 1_000_000, 100_000), trial("treat", "a", 0, 1_000, 100_000)];
		// Cache read $0.075 vs output $2.50/M: removing the whole prefix removes
		// $0.075 of a $0.325 bill, which is far from all of it.
		const verdict = predictedVsActual(results, "baseline", "treat", 1);
		expect(verdict?.actual).toBeLessThan(0.3);
		expect(verdict?.gap).toBeLessThan(0);
	});

	/**
	 * An errored trial billed nothing because it never ran. Counting it as a free
	 * sample would make whichever arm errored more look cheaper, which is the same
	 * selection effect the report warns about for reward and which bites harder here
	 * because cost is a sum.
	 */
	test("ignores trials that never billed rather than counting them as free", () => {
		const withError = [
			trial("baseline", "a", 0, 1_000_000, 0),
			trial("treat", "a", 0, 500_000, 0),
			errored("treat", "b"),
		];
		const without = [trial("baseline", "a", 0, 1_000_000, 0), trial("treat", "a", 0, 500_000, 0)];
		expect(predictedVsActual(withError, "baseline", "treat", 0.5)?.actual).toBeCloseTo(
			predictedVsActual(without, "baseline", "treat", 0.5)?.actual ?? -1,
			10,
		);
	});

	/** An arm with no billed trials at all yields no verdict rather than a fabricated one. */
	test("returns null when either arm never billed anything", () => {
		const results = [trial("baseline", "a", 0, 1_000_000, 0), errored("treat", "a")];
		expect(predictedVsActual(results, "baseline", "treat", 0.5)).toBeNull();
		expect(predictedVsActual(results, "baseline", "absent", 0.5)).toBeNull();
	});
});

describe("onPairedTasks — cost is a sum, so the arms must cover the same tasks", () => {
	/**
	 * THE ERROR THIS PREVENTS. Baseline ran two tasks and the treatment only one, so
	 * comparing totals credits the lever with a whole task's worth of savings it never
	 * made. Under quota truncation this is the normal case.
	 */
	test("drops tasks only one arm completed", () => {
		const results = [
			trial("baseline", "a", 0, 1_000_000, 0),
			trial("baseline", "b", 0, 1_000_000, 0),
			trial("treat", "a", 0, 900_000, 0),
		];
		const naive = predictedVsActual(results, "baseline", "treat", 0.1);
		const paired = predictedVsActual(onPairedTasks(results, "baseline", "treat"), "baseline", "treat", 0.1);
		// The naive figure credits the lever with a task the treatment never ran.
		expect(naive?.actual).toBeCloseTo(0.55, 10);
		expect(paired?.actual).toBeCloseTo(0.1, 10);
	});

	/** With both arms covering the same tasks, pairing changes nothing. */
	test("is a no-op when both arms already cover the same tasks", () => {
		const results = [
			trial("baseline", "a", 0, 1_000_000, 0),
			trial("treat", "a", 0, 500_000, 0),
			trial("baseline", "b", 0, 1_000_000, 0),
			trial("treat", "b", 0, 500_000, 0),
		];
		expect(onPairedTasks(results, "baseline", "treat")).toHaveLength(4);
	});

	/** A task the treatment attempted but errored on is not a shared task: it billed nothing. */
	test("does not treat an errored trial as covering the task", () => {
		const results = [
			trial("baseline", "a", 0, 1_000_000, 0),
			trial("baseline", "b", 0, 1_000_000, 0),
			trial("treat", "a", 0, 500_000, 0),
			errored("treat", "b"),
		];
		const paired = onPairedTasks(results, "baseline", "treat");
		expect([...new Set(paired.map(r => r.task))]).toEqual(["a"]);
	});

	/** No overlap at all yields an empty set, and therefore no verdict, rather than a false one. */
	test("returns nothing when the arms share no tasks", () => {
		const results = [trial("baseline", "a", 0, 1_000_000, 0), trial("treat", "b", 0, 1_000, 0)];
		expect(onPairedTasks(results, "baseline", "treat")).toEqual([]);
		expect(predictedVsActual(onPairedTasks(results, "baseline", "treat"), "baseline", "treat", 0.5)).toBeNull();
	});
});

/**
 * The reference-cost table must not present an unpaired sum as a saving.
 *
 * THE REPORT THAT MOTIVATED THIS. Run 2026-07-25T19-51-41 rendered `discovery-all`
 * at "$0.5394 (-97.8%)" against baseline. The arm did not save 97.8% of anything: it
 * completed ONE task against baseline's eighteen, because arm-major ordering let
 * quota drain during the first arm. Every figure in that row was a sum over work the
 * arm never did, and nothing in the table said so. A reader skimming for a cost win
 * would have found a spectacular one.
 *
 * The table still prints per-arm sums, which are honest on their own. What it must
 * never do again is print percentage deltas between arms of different sizes without
 * saying that is what they are.
 */
describe("renderReport cost table — an unpaired sum is not a saving", () => {
	/** Two arms with wildly different sample counts must carry the warning and the counts. */
	test("warns and shows sample counts when the arms completed different amounts of work", () => {
		const results = [
			trial("baseline", "a", 1_000_000, 1_000_000, 100_000),
			trial("baseline", "b", 1_000_000, 1_000_000, 100_000),
			trial("baseline", "c", 1_000_000, 1_000_000, 100_000),
			trial("thin", "a", 1_000_000, 1_000_000, 100_000),
		];
		const report = renderReport(results, "test-model", "2026-07-25T00:00:00Z", 1, undefined);
		expect(report).toContain("NOT a cost comparison");
		expect(report).toContain("baseline 3, thin 1");
	});

	/**
	 * Equal sample counts are a real comparison, so the warning must NOT fire there.
	 * A banner that appeared on every run would be scrolled past on the run that
	 * needed it.
	 */
	test("stays silent when both arms completed the same number of trials", () => {
		const results = [
			trial("baseline", "a", 1_000_000, 1_000_000, 100_000),
			trial("baseline", "b", 1_000_000, 1_000_000, 100_000),
			trial("thin", "a", 500_000, 500_000, 100_000),
			trial("thin", "b", 500_000, 500_000, 100_000),
		];
		const report = renderReport(results, "test-model", "2026-07-25T00:00:00Z", 1, undefined);
		expect(report).not.toContain("NOT a cost comparison");
	});

	/** A single-arm run has nothing to compare against, so it must not warn either. */
	test("stays silent for a run with only one arm", () => {
		const results = [trial("baseline", "a", 1_000_000, 1_000_000, 100_000)];
		const report = renderReport(results, "test-model", "2026-07-25T00:00:00Z", 1, undefined);
		expect(report).not.toContain("NOT a cost comparison");
	});
});

/**
 * The REWARD gate, checked against the same lopsided run that fooled the cost table.
 *
 * WHY THIS IS WORTH ITS OWN TEST. The cost table presented a one-task arm as a 97.8%
 * saving. Reward is the gate that actually decides whether a lever ships, so the
 * obvious question is whether it fails the same way: does a treatment that ran one
 * task and aced it get reported as a winner over a baseline that ran five and mostly
 * failed?
 *
 * It does not, and this pins that. The comparison pairs by task, so it sees ONE
 * comparable task and returns "not distinguishable (underpowered)" rather than a
 * sweep. That verdict is the one thing standing between a truncated run and a false
 * claim of improvement, and it must never soften into a plain null.
 */
describe("the reward gate under a lopsided run", () => {
	const scored = (arm: string, task: string, reward: number): ArmResult => ({
		...emptyArmResult(arm, task, 0),
		reward,
		partial: reward,
		inputTokens: 1000,
		outputTokens: 100,
		cacheTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});

	/**
	 * Baseline runs five tasks and mostly fails; the treatment runs one and aces it.
	 * On unpaired sums that reads as a landslide. Paired, it is a single task and no
	 * conclusion at all.
	 */
	test("refuses to call a one-task sweep a winner", () => {
		const results = [
			scored("baseline", "a", 0),
			scored("baseline", "b", 0),
			scored("baseline", "c", 0),
			scored("baseline", "d", 0),
			scored("baseline", "e", 1),
			scored("treat", "a", 1),
			errored("treat", "b"),
			errored("treat", "c"),
			errored("treat", "d"),
			errored("treat", "e"),
		];
		const report = renderReport(results, "test-model", "2026-07-25T00:00:00Z", 1, undefined);
		const row = report.split("\n").find(line => line.startsWith("| baseline → treat |"));
		expect(row).toBeDefined();
		// Only the single task both arms completed is compared.
		expect(row).toContain("| baseline → treat | 1 |");
		// And one task cannot clear the bar, however lopsided it looks.
		expect(row).toContain("not distinguishable (underpowered)");
	});

	/**
	 * "Underpowered" must mean "add tasks", never "the arms are equal". A run with
	 * enough decisive tasks reports a real verdict instead, so the two states stay
	 * distinguishable to a reader.
	 */
	test("reports a real verdict once there are enough decisive tasks", () => {
		const tasks = ["a", "b", "c", "d", "e", "f", "g", "h"];
		const results = tasks.flatMap(task => [scored("baseline", task, 0), scored("treat", task, 1)]);
		const report = renderReport(results, "test-model", "2026-07-25T00:00:00Z", 1, undefined);
		// Assert on the ROW, not the section: the section's own prose explains what
		// "not distinguishable (underpowered)" means, so a section-wide search for that
		// phrase matches the documentation rather than the verdict.
		const row = report.split("\n").find(line => line.startsWith("| baseline → treat |"));
		expect(row).toBeDefined();
		expect(row).toContain("| baseline → treat | 8 |");
		expect(row).not.toContain("underpowered");
		expect(row).toContain("treat better");
	});
});

describe("a quota-killed arm is not a free arm", () => {
	/**
	 * THE BUG THIS LOCKS OUT, found by running the check on real data rather than by
	 * imagining it. A trial killed by a provider quota records ZERO prompt tokens, not
	 * null. The billed-trial test used to be `inputTokens !== null`, so those trials
	 * passed it, added nothing to the sum, and made the arm look free: on
	 * `runs/2026-07-25T20-46-08-607Z` the comparison reported a 100% saving for
	 * `sig-last1` against a 31.5% prediction, a 68-point gap in the arm's favour.
	 *
	 * The right answer is a REFUSAL. There is no measurement here, and "no data" must
	 * not render as the best result the instrument has ever produced.
	 */
	test("refuses rather than reporting a 100% saving when every treatment trial billed nothing", () => {
		const results = [
			trial("baseline", "t1", 1000, 4000, 200),
			trial("baseline", "t2", 1000, 4000, 200),
			billedNothing("treatment", "t1"),
			billedNothing("treatment", "t2"),
		];
		expect(predictedVsActual(onPairedTasks(results, "baseline", "treatment"), "baseline", "treatment", 0.3)).toBe(
			null,
		);
	});

	/**
	 * The same trial must also be invisible to the pairing, or a task that only one
	 * arm really ran would be treated as shared and its baseline cost counted against
	 * an arm that never paid it.
	 */
	test("does not treat a task as shared on the strength of a trial that billed nothing", () => {
		const results = [
			trial("baseline", "t1", 1000, 4000, 200),
			trial("baseline", "t2", 1000, 4000, 200),
			trial("treatment", "t1", 500, 2000, 200),
			billedNothing("treatment", "t2"),
		];
		const paired = onPairedTasks(results, "baseline", "treatment");
		expect(paired.map(r => r.task).sort()).toEqual(["t1", "t1"]);
	});

	/**
	 * A trial that billed only CACHE READS is a real trial and must still count. The
	 * fix tests total prompt tokens rather than `inputTokens` alone precisely so a
	 * fully cached turn is not mistaken for a dead one, which would throw away the
	 * cheapest trials of the cheapest arm and understate its saving.
	 */
	test("counts a trial whose prompt was served entirely from cache", () => {
		const cachedOnly: ArmResult = { ...trial("treatment", "t1", 0, 4000, 200) };
		const results = [trial("baseline", "t1", 1000, 4000, 200), cachedOnly];
		const comparison = predictedVsActual(
			onPairedTasks(results, "baseline", "treatment"),
			"baseline",
			"treatment",
			0.1,
		);
		expect(comparison).not.toBe(null);
		expect(comparison?.treatmentCost).toBeGreaterThan(0);
	});
});
