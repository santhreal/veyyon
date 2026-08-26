/**
 * Run model and suite-tagged result records.
 *
 * Invariant: Cross-suite comparison is strictly refused. Pass rates and metrics
 * from different evaluation suites may never share a table or aggregate run.
 */

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
	readonly total: number;
	readonly passes: number;
	readonly errors: number;
	readonly passRate: number | null;
	readonly meanReward: number | null;
	readonly meanPartial: number | null;
	readonly totalCostUsd: number | null;
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
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
		const total = results.length;
		let passes = 0;
		let errors = 0;
		let sumReward = 0;
		let sumPartial = 0;
		let sumCost: number | null = null;
		let sumInputTokens = 0;
		let sumOutputTokens = 0;

		for (const res of results) {
			if (res.score.error !== null) {
				errors++;
			} else if (res.score.reward === 1) {
				passes++;
			}

			if (res.score.reward !== null) {
				sumReward += res.score.reward;
			}
			if (res.score.partial !== null) {
				sumPartial += res.score.partial;
			}

			if (res.score.usage?.costUsd != null) {
				sumCost = (sumCost ?? 0) + res.score.usage.costUsd;
			}
			if (res.score.usage?.inputTokens != null) {
				sumInputTokens += res.score.usage.inputTokens;
			}
			if (res.score.usage?.outputTokens != null) {
				sumOutputTokens += res.score.usage.outputTokens;
			}
		}

		summaries.push({
			variant: variantName,
			total,
			passes,
			errors,
			passRate: total > 0 ? passes / total : null,
			meanReward: total > 0 ? sumReward / total : null,
			meanPartial: total > 0 ? sumPartial / total : null,
			totalCostUsd: sumCost,
			totalInputTokens: sumInputTokens,
			totalOutputTokens: sumOutputTokens,
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
