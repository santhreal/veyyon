/**
 * The one owner of how an unscored trial counts.
 *
 * Three outcomes, and the arithmetic each one gets:
 *
 * - `scored` — the grader produced a reward. It counts in the denominator and in the mean.
 * - `timed-out` — the agent ran out of its budget. That is a scored failure: reward 0, counted
 *   in the denominator, because a model that cannot finish in the budget has failed the task.
 * - `infrastructure-error` — the trial never reached a grade (a container died, a provider
 *   refused, an artifact was missing). It is not a zero. It is excluded from every denominator
 *   and reported as its own count, so a broken run reads as broken rather than as bad.
 *
 * Two aggregators used to disagree about this: one divided by every trial, so a crashed
 * container dragged the mean toward zero, and the other divided by the graded ones without
 * saying so. Both now route through here, and every renderer prints the error count beside the
 * rate it qualifies.
 */

/**
 * Every outcome a settled trial can have, in report order.
 *
 * Enumerated as a value so a test can sweep the space and refuse a new member that nobody has
 * decided a denominator rule for.
 */
export const TRIAL_OUTCOMES = ["scored", "timed-out", "infrastructure-error"] as const;

/** What kind of number, if any, a trial produced. */
export type TrialOutcome = (typeof TRIAL_OUTCOMES)[number];

/** Whether an outcome belongs in the denominator of a rate over the cell. */
export function countsInDenominator(outcome: TrialOutcome): boolean {
	switch (outcome) {
		case "scored":
		case "timed-out":
			return true;
		case "infrastructure-error":
			return false;
	}
}

/** Per-outcome trial counts for one cell. `scored + timedOut + errors === total`. */
export interface OutcomeCounts {
	/** Every trial the cell scheduled and settled. */
	readonly total: number;
	/** Trials the grader scored. */
	readonly scored: number;
	/** Trials that exhausted the agent budget; graded as failures. */
	readonly timedOut: number;
	/** Trials that never reached a grade. Never averaged as zero. */
	readonly errors: number;
	/** The denominator every rate and mean over this cell uses. */
	readonly denominator: number;
}

/**
 * Classify one settled trial.
 *
 * `timedOut` is the caller's own judgement, because each suite reads a timeout from a different
 * place: a container exit reason, an `extra.timedOut` flag, a message its verifier wrote.
 */
export function classifyTrialOutcome(error: string | null, timedOut: boolean): TrialOutcome {
	if (timedOut) return "timed-out";
	if (error !== null) return "infrastructure-error";
	return "scored";
}

/** Tally outcomes for one cell. The denominator follows `countsInDenominator`, never a second rule. */
export function countOutcomes(outcomes: readonly TrialOutcome[]): OutcomeCounts {
	let scored = 0;
	let timedOut = 0;
	let errors = 0;
	let denominator = 0;
	for (const outcome of outcomes) {
		if (outcome === "scored") scored++;
		else if (outcome === "timed-out") timedOut++;
		else errors++;
		if (countsInDenominator(outcome)) denominator++;
	}
	return { total: outcomes.length, scored, timedOut, errors, denominator };
}

/**
 * Mean of the values that exist, over the count of values that exist.
 *
 * `null` entries are absent measurements, not zeros: they leave both the numerator and the
 * denominator. An empty list, or one with nothing measured, is `null` rather than 0.
 */
export function meanOfScored(values: readonly (number | null)[]): number | null {
	let sum = 0;
	let count = 0;
	for (const value of values) {
		if (value === null) continue;
		sum += value;
		count++;
	}
	return count === 0 ? null : sum / count;
}

/**
 * Mean of graded values where a timeout is a graded zero.
 *
 * The timeouts are supplied as a count rather than as zeros in `values`, so a caller cannot
 * accidentally pad the list with the same zeros twice.
 */
export function meanWithTimeoutsAsZero(values: readonly (number | null)[], timedOut: number): number | null {
	let sum = 0;
	let count = timedOut;
	for (const value of values) {
		if (value === null) continue;
		sum += value;
		count++;
	}
	return count === 0 ? null : sum / count;
}

/** A rate over a denominator that may be empty. Never 0/0. */
export function rateOf(passes: number, denominator: number): number | null {
	return denominator > 0 ? passes / denominator : null;
}

/**
 * Sum of a measurement across trials, or `null` when no trial measured it.
 *
 * Unknown spend is not $0. A caller that sums costs with `+= value ?? 0` reports a free run;
 * this returns `null` until at least one trial supplies a number.
 */
export function sumOfMeasured(values: readonly (number | null | undefined)[]): number | null {
	let sum = 0;
	let measured = false;
	for (const value of values) {
		if (value === null || value === undefined) continue;
		sum += value;
		measured = true;
	}
	return measured ? sum : null;
}
