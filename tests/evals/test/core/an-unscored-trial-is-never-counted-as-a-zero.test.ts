/**
 * WHY: three aggregators each invented their own answer to "what does a trial that produced no
 * number count as". The run summary divided by every trial, so a dead container dragged the mean
 * toward zero; the deep-swe cell summary divided by the graded ones without saying so; the cost
 * columns summed with `?? 0`, so a run nobody priced reported as free. `core/scoring.ts` is now
 * the one owner of that arithmetic, and this suite fixes the rules it owns:
 *
 *   - a timeout is a graded failure: reward 0, inside the denominator;
 *   - an infrastructure error is outside every denominator and reported as its own count;
 *   - an unmeasured amount is `null`, never 0;
 *   - an empty denominator yields `null`, never 0/0 and never a fabricated 0%.
 *
 * The outcome space is swept from `TRIAL_OUTCOMES` at run time, so adding a fourth outcome turns
 * this suite red until someone records its denominator rule.
 *
 * What it does not catch: whether a given backend sets `extra.timedOut` on the trial it stopped.
 * That is the backend's contract, tested where the backend is.
 */
import { describe, expect, it } from "bun:test";
import {
	classifyTrialOutcome,
	countOutcomes,
	countsInDenominator,
	meanOfScored,
	meanWithTimeoutsAsZero,
	rateOf,
	sumOfMeasured,
	TRIAL_OUTCOMES,
	type TrialOutcome,
} from "../../engine/trial-outcomes";

describe("the outcome space", () => {
	it("gives every declared outcome a decided denominator rule", () => {
		const rules = new Map<TrialOutcome, boolean>(
			TRIAL_OUTCOMES.map(outcome => [outcome, countsInDenominator(outcome)]),
		);
		// Pinned by exact equality: a new outcome fails here rather than defaulting into a rate.
		expect([...rules]).toEqual([
			["scored", true],
			["timed-out", true],
			["unscored", false],
			["infrastructure-error", false],
		]);
	});

	it("tallies a cell so the counts partition the trials and the denominator follows the rule", () => {
		const outcomes: TrialOutcome[] = [
			"scored",
			"scored",
			"timed-out",
			"unscored",
			"infrastructure-error",
			"infrastructure-error",
		];
		const counts = countOutcomes(outcomes);

		expect(counts).toEqual({ total: 6, scored: 2, timedOut: 1, unscored: 1, errors: 2, denominator: 3 });
		expect(counts.scored + counts.timedOut + counts.unscored + counts.errors).toBe(counts.total);
		expect(counts.denominator).toBe(outcomes.filter(countsInDenominator).length);
	});

	it("classifies a stopped trial as timed out even though it also carries an error message", () => {
		// A backend that kills an over-budget agent reports both; the timeout wins, because the
		// model failed the task rather than the harness failing the model.
		expect(classifyTrialOutcome("agent budget exhausted", true, null)).toBe("timed-out");
		expect(classifyTrialOutcome("container exited 137", false, null)).toBe("infrastructure-error");
		expect(classifyTrialOutcome(null, false, 1)).toBe("scored");
		expect(classifyTrialOutcome(null, false, 0)).toBe("scored");
	});

	it("classifies a trial that settled with no grade and no error as unscored, not as a zero", () => {
		// A grader that never ran leaves reward null. Counting it as scored put it in the
		// denominator, so a suite nothing graded read as a suite the model failed outright.
		expect(classifyTrialOutcome(null, false, null)).toBe("unscored");
		const counts = countOutcomes([classifyTrialOutcome(null, false, null)]);
		expect(counts.denominator).toBe(0);
		expect(counts.unscored).toBe(1);
		expect(counts.scored).toBe(0);
		expect(rateOf(0, counts.denominator)).toBeNull();
	});
});

describe("rates over a population that may be empty", () => {
	it("reports no rate rather than 0% when nothing was graded", () => {
		expect(rateOf(0, 0)).toBeNull();
		expect(rateOf(0, 4)).toBe(0);
		expect(rateOf(3, 4)).toBeCloseTo(0.75, 10);
	});

	it("counts a timeout as a graded zero in the mean", () => {
		// One pass, one timeout: half, not "one pass out of one graded".
		expect(meanWithTimeoutsAsZero([1], 1)).toBeCloseTo(0.5, 10);
		expect(meanWithTimeoutsAsZero([1, 1], 0)).toBe(1);
		expect(meanWithTimeoutsAsZero([], 2)).toBe(0);
		expect(meanWithTimeoutsAsZero([], 0)).toBeNull();
	});

	it("leaves an absent measurement out of both halves of a mean", () => {
		expect(meanOfScored([1, null, 0])).toBeCloseTo(0.5, 10);
		expect(meanOfScored([null, null])).toBeNull();
		expect(meanOfScored([])).toBeNull();
	});
});

describe("measured totals", () => {
	it("reports an unmeasured total as absent, and a measured zero as zero", () => {
		expect(sumOfMeasured([null, undefined])).toBeNull();
		expect(sumOfMeasured([])).toBeNull();
		// A trial that really cost nothing is distinguishable from one nobody priced.
		expect(sumOfMeasured([0])).toBe(0);
		expect(sumOfMeasured([0.1, null, 0.15, undefined])).toBeCloseTo(0.25, 10);
	});
});
