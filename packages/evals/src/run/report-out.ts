/**
 * What a settled run leaves in its own directory.
 *
 * A run used to persist one file, `trials.jsonl`, and print its summary to stdout. Nothing
 * on disk stated what the run measured, so `mergeIntoReport`, the manager's benchmark
 * snapshot and an operator reading the directory later all needed a `reaggregate` call
 * nobody had been told to make.
 *
 * Two writes, in this order. `run.json` is the record `executeRun` returns, so a run is
 * readable without the suite that produced it. Then the suite's own renderer, when it
 * declares one, which is free to read the backend's artifacts and write whatever report it
 * owns. A renderer runs after the record is safe on disk and its failure is reported rather
 * than thrown: a report is a reading of a run, never a condition of it.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { EvalRunRecord } from "../core/run-model";
import { runDirFor } from "../core/trial-naming";
import type { EvalSuite, SuiteReportContext } from "../core/types";

/** Filename the run record is written under, inside the run's directory. */
export const RUN_RECORD_FILE = "run.json";

export interface WriteRunOutputOptions {
	readonly runsDir: string;
	readonly suite: EvalSuite;
	readonly record: EvalRunRecord;
	/** Every model the plan ran, in plan order. */
	readonly models: readonly string[];
	readonly tasks: readonly string[];
	readonly repeats: number;
}

/**
 * The model a suite report names. A run of one model names it; a run of several names them
 * all, because a report that silently picked the first would attribute every row to it.
 */
function reportModel(models: readonly string[]): string {
	const distinct = [...new Set(models)];
	return distinct.length === 0 ? "unknown" : distinct.join(", ");
}

/**
 * Writes the run record, then the suite's report. Returns the renderer's failure when it
 * had one, so a caller states it beside the run's own verdict.
 */
export async function writeRunOutput(options: WriteRunOutputOptions): Promise<string | null> {
	const runDir = runDirFor(options.runsDir, options.record.id);
	await fs.mkdir(runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, RUN_RECORD_FILE), `${JSON.stringify(options.record, null, 2)}\n`);

	const render = options.suite.writeRunReport;
	if (!render) return null;
	const context: SuiteReportContext = {
		runDir,
		model: reportModel(options.models),
		tasks: options.tasks,
		repeats: options.repeats,
	};
	try {
		await render.call(options.suite, context);
		return null;
	} catch (error) {
		const reason = errorMessage(error);
		logger.error("suite report failed", { runId: options.record.id, suite: options.suite.name, error });
		return reason;
	}
}
