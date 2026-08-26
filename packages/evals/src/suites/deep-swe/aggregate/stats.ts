/**
 * Statistical analysis and hypothesis testing for DeepSWE benchmark evaluations.
 */
import {
	classifyTrialOutcome,
	countOutcomes,
	meanOfScored as mean,
	meanOfScored,
	meanWithTimeoutsAsZero,
	rateOf,
	sumOfMeasured,
} from "../../../core/scoring";

export { mean };

import { priceTokens } from "../cost-model";
import { isAgentTimeout } from "./error-classification";
import type { ArmResult, CellSummary } from "./types";

/** z for a two-sided 95% interval (standard normal 0.975 quantile). */
export const Z_95 = 1.959963984540054;

/**
 * Wilson score confidence interval for a binomial proportion (passes out of n).
 */
export function wilsonInterval(
	passes: number,
	n: number,
	z: number = Z_95,
): { low: number | null; high: number | null } {
	if (n <= 0) return { low: null, high: null };
	const p = passes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const halfWidth = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return {
		low: Math.max(0, center - halfWidth),
		high: Math.min(1, center + halfWidth),
	};
}

/**
 * Two-sided exact sign-test p-value for a paired comparison.
 */
export function signTestPValue(wins: number, losses: number): number {
	const n = wins + losses;
	if (n <= 0) return 1;
	const k = Math.min(wins, losses);
	let pmf = 0.5 ** n;
	let cdf = pmf;
	for (let i = 1; i <= k; i++) {
		pmf *= (n - i + 1) / i;
		cdf += pmf;
	}
	return Math.min(1, 2 * cdf);
}

/**
 * Whether a paired comparison could reach significance AT ALL at its current task count.
 */
export function sweepCanReachSignificance(nDecisive: number, familySize: number, alpha = 0.05): boolean {
	if (nDecisive <= 0) return false;
	const bestCaseRaw = signTestPValue(nDecisive, 0);
	const bestCaseAdjusted = Math.min(1, bestCaseRaw * Math.max(1, familySize));
	return bestCaseAdjusted < alpha;
}

/**
 * Holm–Bonferroni step-down adjustment of a family of p-values.
 */
export function holmBonferroni(pValues: readonly number[]): number[] {
	const m = pValues.length;
	if (m === 0) return [];
	const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
	const adjusted = new Array<number>(m);
	let running = 0;
	order.forEach((entry, rank) => {
		const val = Math.min(1, entry.p * (m - rank));
		running = Math.max(running, val);
		adjusted[entry.i] = running;
	});
	return adjusted;
}

export interface ArmDelta {
	armA: string;
	armB: string;
	nTasks: number;
	meanDelta: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	wins: number;
	losses: number;
	ties: number;
	signTestP: number;
}

export interface PairedComparison {
	armA: string;
	armB: string;
	nTasks: number;
	meanDelta: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	pos: number;
	neg: number;
	ties: number;
	signTestP: number;
}

function pairedByTask(
	results: readonly ArmResult[],
	metricOf: (cell: CellSummary) => number | null,
): PairedComparison[] {
	const arms = Array.from(new Set(results.map(r => r.arm))).sort();
	const tasks = Array.from(new Set(results.map(r => r.task))).sort();
	const valueAt = (arm: string, task: string): number | null =>
		metricOf(summarizeCell(results.filter(r => r.arm === arm && r.task === task)));
	const out: PairedComparison[] = [];
	for (let i = 0; i < arms.length; i++) {
		for (let j = i + 1; j < arms.length; j++) {
			const armA = arms[i];
			const armB = arms[j];
			if (!armA || !armB) continue;
			const deltas: number[] = [];
			let pos = 0;
			let neg = 0;
			let ties = 0;
			for (const task of tasks) {
				const a = valueAt(armA, task);
				const b = valueAt(armB, task);
				if (a === null || b === null) continue;
				const d = b - a;
				deltas.push(d);
				if (d > 0) pos++;
				else if (d < 0) neg++;
				else ties++;
			}
			const nTasks = deltas.length;
			const meanDelta = nTasks > 0 ? deltas.reduce((s, d) => s + d, 0) / nTasks : null;
			let ciLow: number | null = null;
			let ciHigh: number | null = null;
			if (nTasks >= 2 && meanDelta !== null) {
				const variance = deltas.reduce((s, d) => s + (d - meanDelta) ** 2, 0) / (nTasks - 1);
				const se = Math.sqrt(variance / nTasks);
				ciLow = meanDelta - Z_95 * se;
				ciHigh = meanDelta + Z_95 * se;
			}
			out.push({
				armA,
				armB,
				nTasks,
				meanDelta,
				ciLow,
				ciHigh,
				pos,
				neg,
				ties,
				signTestP: signTestPValue(pos, neg),
			});
		}
	}
	return out;
}

export function pairwiseArmDeltas(results: readonly ArmResult[]): ArmDelta[] {
	return pairedByTask(results, c => c.passRate).map(p => ({
		armA: p.armA,
		armB: p.armB,
		nTasks: p.nTasks,
		meanDelta: p.meanDelta,
		ciLow: p.ciLow,
		ciHigh: p.ciHigh,
		wins: p.pos,
		losses: p.neg,
		ties: p.ties,
		signTestP: p.signTestP,
	}));
}

export function pairwiseMetricDeltas(
	results: readonly ArmResult[],
	metric: (cell: CellSummary) => number | null,
): PairedComparison[] {
	return pairedByTask(results, metric);
}

export function summarizeCell(rows: readonly ArmResult[]): CellSummary {
	const outcomes = rows.map(r => classifyTrialOutcome(r.error, isAgentTimeout(r.error), r.reward));
	const counts = countOutcomes(outcomes);
	const ok = rows.filter((_, idx) => outcomes[idx] === "scored");
	// Every row that reached a grader, whether or not the grader produced a reward. A timeout and
	// an infrastructure error are excluded: neither ran to a priceable end. This is the population
	// the reference cost section prices, and it is deliberately wider than `ok`, which drives the
	// means and excludes a trial nothing graded.
	const priced = rows.filter((_, idx) => outcomes[idx] === "scored" || outcomes[idx] === "unscored");
	const passes = ok.filter(r => r.reward === 1).length;
	const passRate = rateOf(passes, counts.denominator);
	const stdErr =
		passRate === null || counts.denominator === 0
			? null
			: Math.sqrt((passRate * (1 - passRate)) / counts.denominator);
	const wilson = counts.denominator > 0 ? wilsonInterval(passes, counts.denominator) : { low: null, high: null };

	return {
		total: counts.total,
		errors: counts.errors,
		timedOut: counts.timedOut,
		unscored: counts.unscored,
		n: counts.denominator,
		passes,
		passRate,
		stdErr,
		wilsonLow: wilson.low,
		wilsonHigh: wilson.high,
		meanReward: meanWithTimeoutsAsZero(
			ok.map(r => r.reward),
			counts.timedOut,
		),
		meanPartial: meanOfScored(ok.map(r => r.partial ?? null)),
		meanOutputTokens: meanOfScored(ok.map(r => r.outputTokens)),
		meanInputTokens: meanOfScored(ok.map(r => r.inputTokens)),
		meanCostUsd: meanOfScored(ok.map(r => r.costUsd)),
		sumOutputTokens: sumOfMeasured(priced.map(r => r.outputTokens)) ?? 0,
		sumCostUsd: sumOfMeasured(priced.map(r => r.costUsd)) ?? 0,
		sumInputTokens: sumOfMeasured(priced.map(r => r.inputTokens)) ?? 0,
		sumCacheTokens: sumOfMeasured(priced.map(r => r.cacheTokens)) ?? 0,
		sumAgentSeconds: sumOfMeasured(priced.map(r => r.agentSeconds)) ?? 0,
		costPriced: priced.some(r => (r.costUsd ?? 0) > 0),
		refCost: priceTokens({
			inputTokens: sumOfMeasured(priced.map(r => r.inputTokens)) ?? 0,
			cacheReadTokens: sumOfMeasured(priced.map(r => r.cacheReadTokens)) ?? 0,
			cacheWriteTokens: sumOfMeasured(priced.map(r => r.cacheWriteTokens)) ?? 0,
			outputTokens: sumOfMeasured(priced.map(r => r.outputTokens)) ?? 0,
		}),
		refPricedSamples: priced.length,
		refCostMeasurable:
			priced.length > 0 && priced.every(r => r.cacheReadTokens != null && r.cacheWriteTokens != null),
	};
}

export function relativeSpreadPct(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const avg = values.reduce((a, b) => a + b, 0) / values.length;
	if (avg === 0) return null;
	const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / (values.length - 1);
	return (100 * Math.sqrt(variance)) / Math.abs(avg);
}

export function withinTaskSpreadPct(rows: readonly ArmResult[]): number | null {
	const byTask = new Map<string, number[]>();
	for (const row of rows) {
		if (row.error || row.outputTokens === null) continue;
		const list = byTask.get(row.task);
		if (list === undefined) byTask.set(row.task, [row.outputTokens]);
		else list.push(row.outputTokens);
	}
	const spreads: number[] = [];
	for (const values of byTask.values()) {
		const spread = relativeSpreadPct(values);
		if (spread !== null) spreads.push(spread);
	}
	if (spreads.length === 0) return null;
	spreads.sort((a, b) => a - b);
	const mid = Math.floor(spreads.length / 2);
	return spreads.length % 2 === 1 ? spreads[mid]! : (spreads[mid - 1]! + spreads[mid]!) / 2;
}

export function ceilingBelowNoise(maxSavedPct: number, noisePct: number | null): boolean {
	return maxSavedPct < (noisePct ?? 1);
}
