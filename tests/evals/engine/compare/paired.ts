/**
 * Two arms compared trial by trial.
 *
 * Arms of one plan run the same tasks and repeats, and a kit suite seeds each task by task and
 * repeat alone, so the trial of arm A and the trial of arm B at one key met the same data. The
 * comparison counts the keys where exactly one arm passed, which is what a sign test reads, and sums
 * the spend over the keys both arms reached a grade on, so a trial one arm lost to an error never
 * weighs on one side alone.
 */

import { signTestPValue } from "./stats";

/** One graded or errored trial of one arm. */
export interface ArmTrial {
	readonly arm: string;
	/** Task and repeat: the pairing key. */
	readonly key: string;
	/** null when the trial never reached a grade. */
	readonly passed: boolean | null;
	readonly tokens: number | null;
	readonly turns: number | null;
	readonly wallSec: number | null;
}

export interface PairedArms {
	readonly baseline: string;
	readonly candidate: string;
	/** Keys both arms reached a grade on. */
	readonly pairs: number;
	/** The candidate passed and the baseline failed. */
	readonly wins: number;
	/** The baseline passed and the candidate failed. */
	readonly losses: number;
	readonly bothPassed: number;
	readonly bothFailed: number;
	readonly signTestP: number;
	/** Summed over the pairs, for each arm; null when some trial of a pair reported none. */
	readonly tokens: { readonly baseline: number; readonly candidate: number } | null;
	readonly turns: { readonly baseline: number; readonly candidate: number } | null;
	readonly wallSec: { readonly baseline: number; readonly candidate: number } | null;
}

export function pairArms(trials: readonly ArmTrial[], baseline: string, candidate: string): PairedArms {
	const byKey = (arm: string) =>
		new Map(trials.filter(trial => trial.arm === arm && trial.passed !== null).map(trial => [trial.key, trial]));
	const base = byKey(baseline);
	const cand = byKey(candidate);
	let wins = 0;
	let losses = 0;
	let bothPassed = 0;
	let bothFailed = 0;
	const matched: [ArmTrial, ArmTrial][] = [];
	for (const [key, a] of base) {
		const b = cand.get(key);
		if (!b) continue;
		matched.push([a, b]);
		if (a.passed && b.passed) bothPassed++;
		else if (!a.passed && !b.passed) bothFailed++;
		else if (b.passed) wins++;
		else losses++;
	}
	const sum = (pick: (trial: ArmTrial) => number | null) => {
		let a = 0;
		let b = 0;
		for (const [left, right] of matched) {
			const x = pick(left);
			const y = pick(right);
			if (x === null || y === null) return null;
			a += x;
			b += y;
		}
		return { baseline: a, candidate: b };
	};
	return {
		baseline,
		candidate,
		pairs: matched.length,
		wins,
		losses,
		bothPassed,
		bothFailed,
		signTestP: signTestPValue(wins, losses),
		tokens: sum(trial => trial.tokens),
		turns: sum(trial => trial.turns),
		wallSec: sum(trial => trial.wallSec),
	};
}

/** How many of an arm's trials passed within each budget, for the budgets named. */
export function passesWithin(
	trials: readonly ArmTrial[],
	arm: string,
	measure: (trial: ArmTrial) => number | null,
	budgets: readonly number[],
): number[] {
	const spent = trials
		.filter(trial => trial.arm === arm && trial.passed === true)
		.map(measure)
		.filter((value): value is number => value !== null);
	return budgets.map(budget => spent.filter(value => value <= budget).length);
}
