/**
 * Generic trial execution: drive one plan's cells through one execution backend and
 * score each with the suite that owns them.
 *
 * The engine knows nothing about Pier, Harbor, or in-process sessions. It owns four
 * things a per-suite runner kept re-implementing: a bounded worker pool, the mapping
 * from a thrown error to a scored-error row, cleanup that runs whether or not the
 * trial threw, and result order that follows the PLAN rather than completion time so
 * two runs of the same plan produce comparable records.
 */

import { errorMessage } from "@veyyon/utils";
import type {
	EvalRunRecord,
	ExecutionBackend,
	RunContext,
	RunProvenance,
	TrialArtifacts,
	TrialCell,
	TrialResultRecord,
	TrialScore,
} from "../core";
import { createRunRecord } from "../core";
import { preflightHarnesses } from "../harnesses";
import { cellKey, openRunJournal, readRunJournal, sanitizeTrialRecord } from "./journal";
import type { RunPlan } from "./plan";
export class BackendPreflightError extends Error {
	readonly backendId: string;
	readonly missingRequirements: readonly string[];

	constructor(backendId: string, reason: string | null | undefined, missing: readonly string[] | undefined) {
		const detail = reason ?? "no reason given";
		const requirements = missing && missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
		super(`Execution backend "${backendId}" refused to start: ${detail}.${requirements}`);
		this.name = "BackendPreflightError";
		this.backendId = backendId;
		this.missingRequirements = missing ? [...missing] : [];
	}
}

export class SuitePreflightError extends Error {
	readonly suiteName: string;
	readonly missingRequirements: readonly string[];

	constructor(suiteName: string, reason: string | null | undefined, missing: readonly string[] | undefined) {
		const detail = reason ?? "no reason given";
		const requirements = missing && missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
		super(`Eval suite "${suiteName}" refused to start: ${detail}.${requirements}`);
		this.name = "SuitePreflightError";
		this.suiteName = suiteName;
		this.missingRequirements = missing ? [...missing] : [];
	}
}

export class HarnessPreflightError extends Error {
	readonly harness: string;
	readonly variant: string;
	readonly reason: string | null;
	readonly missingRequirements: readonly string[];

	constructor(
		harness: string,
		variant: string,
		reason: string | null | undefined,
		missing: readonly string[] | undefined,
	) {
		const detail = reason ?? "no reason given";
		const requirements = missing && missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
		super(`Harness "${harness}" refused preflight for variant "${variant}": ${detail}.${requirements}`);
		this.name = "HarnessPreflightError";
		this.harness = harness;
		this.variant = variant;
		this.reason = reason ?? null;
		this.missingRequirements = missing ? [...missing] : [];
	}
}

export class InvalidConcurrencyError extends Error {
	constructor(jobs: number) {
		super(`jobs must be an integer >= 1, got ${jobs}.`);
		this.name = "InvalidConcurrencyError";
	}
}

export interface ExecuteRunOptions {
	readonly plan: RunPlan;
	readonly backend: ExecutionBackend;
	readonly workDir: string;
	readonly runsDir: string;
	/** Trials in flight at once. Defaults to 1. */
	readonly jobs?: number;
	readonly signal?: AbortSignal;
	readonly provenance?: RunProvenance;
	/** Called as each trial settles, in completion order, for live progress. */
	readonly onTrial?: (record: TrialResultRecord, index: number) => void;
	/** Called when resuming an existing run and skipping already-settled cells. */
	readonly onSkip?: (skippedCount: number, total: number) => void;
	/** When true, read existing trials.jsonl and skip already-settled cells. */
	readonly resume?: boolean;
	readonly options?: Readonly<Record<string, unknown>>;
	readonly now?: () => number;
}

function erroredScore(cause: unknown): TrialScore {
	return { reward: null, partial: null, error: errorMessage(cause), usage: null, extra: {} };
}

/**
 * Runs every cell in the plan and returns one record. A trial that throws becomes a
 * scored row with a non-null `error`, so a failed trial and a real reward of 0 are
 * never confused; an aborted run returns the trials that finished.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<EvalRunRecord> {
	const jobs = options.jobs ?? 1;
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new InvalidConcurrencyError(jobs);
	}

	const { plan, backend } = options;
	const clock = options.now ?? (() => Date.now());
	const context: RunContext = {
		runId: plan.runId,
		suite: plan.suite,
		workDir: options.workDir,
		runsDir: options.runsDir,
		signal: options.signal,
		options: {
			...options.options,
			variants: plan.variants,
		},
	};

	const suiteVerdict = await plan.suite.preflight(plan.context);
	if (!suiteVerdict.ok) {
		throw new SuitePreflightError(plan.suite.name, suiteVerdict.reason, suiteVerdict.missingRequirements);
	}

	const harnessReports = await preflightHarnesses(plan.variants, {
		backend: plan.suite.backend,
		options: context.options,
		signal: options.signal,
	});
	for (const report of harnessReports) {
		if (!report.verdict.ok) {
			throw new HarnessPreflightError(
				report.harness,
				report.variant,
				report.verdict.reason,
				report.verdict.missingRequirements,
			);
		}
	}

	const backendVerdict = await backend.preflight(context);
	if (!backendVerdict.ok) {
		throw new BackendPreflightError(backend.id, backendVerdict.reason, backendVerdict.missingRequirements);
	}

	await backend.prepare(context);

	const journal = await openRunJournal(options.runsDir, plan.runId);

	const results = new Array<TrialResultRecord | undefined>(plan.cells.length);
	let nextIndex = 0;
	let settled = 0;

	if (options.resume) {
		const priorRecords = await readRunJournal(options.runsDir, plan.runId);
		const settledMap = new Map<string, TrialResultRecord>();
		for (const record of priorRecords) {
			settledMap.set(cellKey(record.cell), record);
		}
		let skipped = 0;
		for (let i = 0; i < plan.cells.length; i++) {
			const cell = plan.cells[i];
			if (cell) {
				const existing = settledMap.get(cellKey(cell));
				if (existing) {
					results[i] = existing;
					skipped++;
				}
			}
		}
		settled = skipped;
		if (skipped > 0) {
			options.onSkip?.(skipped, plan.cells.length);
		}
	}

	const runOne = async (cell: TrialCell, index: number): Promise<void> => {
		const startedAtMs = clock();
		const startedAt = new Date(startedAtMs).toISOString();
		let artifacts: TrialArtifacts | undefined;
		let score: TrialScore;
		try {
			artifacts = await backend.runTrial(cell, context);
			score = await plan.suite.scoreTrial(cell, artifacts);
		} catch (cause) {
			score = erroredScore(cause);
		} finally {
			try {
				await backend.cleanup(cell, context);
			} catch {
				// A cleanup failure must not discard a scored trial. The backend owns
				// reporting it; losing the row would be the larger loss.
			}
		}
		const finishedAtMs = clock();
		const record: TrialResultRecord = sanitizeTrialRecord({
			cell,
			score,
			artifacts,
			startedAt,
			finishedAt: new Date(finishedAtMs).toISOString(),
			durationMs: finishedAtMs - startedAtMs,
		});
		await journal.append(record);
		results[index] = record;
		options.onTrial?.(record, settled++);
	};

	const worker = async (): Promise<void> => {
		while (true) {
			if (options.signal?.aborted) return;
			const index = nextIndex++;
			if (index >= plan.cells.length) return;
			if (results[index] !== undefined) continue;
			const cell = plan.cells[index];
			if (!cell) continue;
			await runOne(cell, index);
		}
	};

	try {
		await Promise.all(Array.from({ length: Math.min(jobs, plan.cells.length) }, worker));
	} finally {
		await journal.close();
	}

	return createRunRecord({
		id: plan.runId,
		suite: {
			name: plan.suite.name,
			version: plan.suite.version,
			provenanceSha: plan.provenance.sha ?? null,
		},
		variants: plan.variants,
		tasks: plan.tasks.map(task => task.id),
		repeats: plan.repeats,
		results: results.filter((record): record is TrialResultRecord => record !== undefined),
		provenance: options.provenance,
		completedAt: new Date(clock()).toISOString(),
	});
}
