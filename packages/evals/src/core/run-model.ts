/**
 * Run model and suite-tagged result records.
 *
 * Invariant: Cross-suite comparison is strictly refused. Pass rates and metrics
 * from different evaluation suites may never share a table or aggregate run.
 */

import {
	classifyTrialOutcome,
	countOutcomes,
	meanOfScored,
	meanWithTimeoutsAsZero,
	rateOf,
	sumOfMeasured,
} from "./scoring";
import type { RunProvenance, TrialArtifacts, TrialCell, TrialScore, Variant } from "./types";

export interface SuiteTag {
	readonly name: string;
	readonly version: string;
	readonly provenanceSha?: string | null;
}

export interface TrialResultRecord {
	readonly cell: TrialCell;
	readonly score: TrialScore;
	readonly artifacts?: TrialArtifacts;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly durationMs?: number;
}

export interface EvalRunRecord {
	readonly id: string;
	readonly suite: SuiteTag;
	readonly variants: readonly Variant[];
	readonly tasks: readonly string[];
	readonly repeats: number;
	readonly results: readonly TrialResultRecord[];
	readonly provenance?: RunProvenance;
	readonly createdAt: string;
	readonly completedAt?: string | null;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CellSummary {
	readonly variant: string;
	/** Every trial that settled, whatever the outcome. */
	readonly total: number;
	readonly passes: number;
	/** Trials that never reached a grade. Excluded from every rate and mean below. */
	readonly errors: number;
	/** Trials that exhausted the agent budget. Graded as failures. */
	readonly timedOut: number;
	/** Trials the grader scored. */
	readonly scored: number;
	/** The denominator of `passRate` and `meanReward`: `scored + timedOut`. */
	readonly denominator: number;
	readonly passRate: number | null;
	readonly meanReward: number | null;
	readonly meanPartial: number | null;
	readonly totalCostUsd: number | null;
	/** `null` when no trial reported a token count: unmeasured, not zero. */
	readonly totalInputTokens: number | null;
	readonly totalOutputTokens: number | null;
}

export interface RunComparisonTable {
	readonly suiteName: string;
	readonly runs: readonly {
		readonly runId: string;
		readonly suiteVersion: string;
		readonly variants: readonly CellSummary[];
	}[];
}

export class CrossSuiteComparisonError extends Error {
	readonly suiteA: string;
	readonly suiteB: string;

	constructor(suiteA: string, suiteB: string) {
		super(
			`Cannot compare runs from different eval suites: "${suiteA}" vs "${suiteB}". ` +
				`Pass rates from different suites may never share a table.`,
		);
		this.name = "CrossSuiteComparisonError";
		this.suiteA = suiteA;
		this.suiteB = suiteB;
	}
}

export class InvalidRunRecordError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidRunRecordError";
	}
}

export interface CreateRunRecordParams {
	readonly id: string;
	readonly suite: SuiteTag;
	readonly variants: readonly Variant[];
	readonly tasks: readonly string[];
	readonly repeats: number;
	readonly results?: readonly TrialResultRecord[];
	readonly provenance?: RunProvenance;
	readonly createdAt?: string;
	readonly completedAt?: string | null;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Creates a validated EvalRunRecord.
 */
export function createRunRecord(params: CreateRunRecordParams): EvalRunRecord {
	if (!params.id) {
		throw new InvalidRunRecordError("Run record requires a non-empty id.");
	}
	if (!params.suite?.name) {
		throw new InvalidRunRecordError("Run record requires a suite name.");
	}
	if (!params.suite?.version) {
		throw new InvalidRunRecordError("Run record requires a suite version.");
	}

	return {
		id: params.id,
		suite: {
			name: params.suite.name,
			version: params.suite.version,
			provenanceSha: params.suite.provenanceSha ?? null,
		},
		variants: [...params.variants],
		tasks: [...params.tasks],
		repeats: params.repeats,
		results: params.results ? [...params.results] : [],
		provenance: params.provenance,
		createdAt: params.createdAt ?? new Date().toISOString(),
		completedAt: params.completedAt ?? null,
		metadata: params.metadata,
	};
}

/**
 * Validates that an untyped object matches the EvalRunRecord structure.
 */
export function validateRunRecord(record: unknown): EvalRunRecord {
	if (!record || typeof record !== "object") {
		throw new InvalidRunRecordError("Run record must be an object.");
	}

	const r = record as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id) {
		throw new InvalidRunRecordError("Run record must have a valid string id.");
	}

	if (!r.suite || typeof r.suite !== "object") {
		throw new InvalidRunRecordError("Run record must have a suite object.");
	}

	const suite = r.suite as Record<string, unknown>;
	if (typeof suite.name !== "string" || !suite.name) {
		throw new InvalidRunRecordError("Run record suite must have a string name.");
	}
	if (typeof suite.version !== "string" || !suite.version) {
		throw new InvalidRunRecordError("Run record suite must have a string version.");
	}

	if (!Array.isArray(r.variants)) {
		throw new InvalidRunRecordError("Run record variants must be an array.");
	}

	if (!Array.isArray(r.tasks)) {
		throw new InvalidRunRecordError("Run record tasks must be an array.");
	}

	if (typeof r.repeats !== "number" || r.repeats < 1) {
		throw new InvalidRunRecordError("Run record repeats must be a positive number.");
	}

	if (!Array.isArray(r.results)) {
		throw new InvalidRunRecordError("Run record results must be an array.");
	}

	return r as unknown as EvalRunRecord;
}

/**
 * Asserts that all provided runs belong to the exact same evaluation suite.
 * Throws CrossSuiteComparisonError if any two runs differ in suite name.
 */
export function assertSameSuite(runs: readonly EvalRunRecord[]): void {
	if (runs.length <= 1) return;

	const firstSuite = runs[0].suite.name;
	for (let i = 1; i < runs.length; i++) {
		const currentSuite = runs[i].suite.name;
		if (currentSuite !== firstSuite) {
			throw new CrossSuiteComparisonError(firstSuite, currentSuite);
		}
	}
}

/**
 * Reads the timeout flag a backend records on a trial.
 *
 * Backends that stop an over-budget agent instead of failing it set `extra.timedOut`
 * on the score or the artifacts. Such a trial reached the grader with no work to grade,
 * so it counts as a graded failure rather than an infrastructure error.
 */
function timedOutOf(result: TrialResultRecord): boolean {
	return result.score.extra?.timedOut === true || result.artifacts?.extra?.timedOut === true;
}

/**
 * Summarizes trial results grouped by variant for a single run.
 */
export function summarizeRunCells(run: EvalRunRecord): readonly CellSummary[] {
	const byVariant = new Map<string, TrialResultRecord[]>();

	for (const variant of run.variants) {
		byVariant.set(variant.name, []);
	}

	for (const result of run.results) {
		const list = byVariant.get(result.cell.variant);
		if (list) {
			list.push(result);
		} else {
			byVariant.set(result.cell.variant, [result]);
		}
	}

	const summaries: CellSummary[] = [];
	for (const [variantName, results] of byVariant) {
		const outcomes = results.map(res => classifyTrialOutcome(res.score.error, timedOutOf(res)));
		const counts = countOutcomes(outcomes);

		const graded = results.filter((_, index) => outcomes[index] === "scored");
		const passes = graded.filter(res => res.score.reward === 1).length;

		summaries.push({
			variant: variantName,
			total: counts.total,
			passes,
			errors: counts.errors,
			timedOut: counts.timedOut,
			scored: counts.scored,
			denominator: counts.denominator,
			passRate: rateOf(passes, counts.denominator),
			meanReward: meanWithTimeoutsAsZero(
				graded.map(res => res.score.reward),
				counts.timedOut,
			),
			meanPartial: meanOfScored(graded.map(res => res.score.partial)),
			// Spend and tokens come from every trial that measured them, including the ones
			// that errored: the provider billed for the work before the trial fell over.
			totalCostUsd: sumOfMeasured(results.map(res => res.score.usage?.costUsd)),
			totalInputTokens: sumOfMeasured(results.map(res => res.score.usage?.inputTokens)),
			totalOutputTokens: sumOfMeasured(results.map(res => res.score.usage?.outputTokens)),
		});
	}

	return summaries;
}

/**
 * Builds a comparison table across multiple runs from the same evaluation suite.
 *
 * @throws {CrossSuiteComparisonError} if runs from different suites are provided.
 */
export function createRunComparisonTable(runs: readonly EvalRunRecord[]): RunComparisonTable {
	if (runs.length === 0) {
		return { suiteName: "", runs: [] };
	}

	assertSameSuite(runs);

	const suiteName = runs[0].suite.name;
	const runSummaries = runs.map(run => ({
		runId: run.id,
		suiteVersion: run.suite.version,
		variants: summarizeRunCells(run),
	}));

	return {
		suiteName,
		runs: runSummaries,
	};
}

/**
 * Merges multiple run records of the same suite into one combined run record.
 *
 * @throws {CrossSuiteComparisonError} if runs from different suites are provided.
 */
export function mergeRunRecords(runs: readonly EvalRunRecord[], mergedId?: string): EvalRunRecord {
	if (runs.length === 0) {
		throw new InvalidRunRecordError("Cannot merge an empty list of runs.");
	}
	if (runs.length === 1) {
		return runs[0];
	}

	assertSameSuite(runs);

	const first = runs[0];
	const allResults: TrialResultRecord[] = [];
	const taskSet = new Set<string>();
	const variantMap = new Map<string, Variant>();

	for (const run of runs) {
		for (const v of run.variants) {
			if (!variantMap.has(v.name)) {
				variantMap.set(v.name, v);
			}
		}
		for (const t of run.tasks) {
			taskSet.add(t);
		}
		allResults.push(...run.results);
	}

	return {
		id: mergedId ?? `merged-${runs.map(r => r.id).join("-")}`,
		suite: first.suite,
		variants: [...variantMap.values()],
		tasks: [...taskSet],
		repeats: Math.max(...runs.map(r => r.repeats)),
		results: allResults,
		createdAt: first.createdAt,
		completedAt: new Date().toISOString(),
	};
}
