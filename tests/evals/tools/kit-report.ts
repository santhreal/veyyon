#!/usr/bin/env bun
/**
 * Render a kit suite's report for a finished run, and optionally grade it again first.
 *
 *   bun evals.ts tool kit-report --run runs/<run-id> [--regrade]
 *
 * A kit trial is graded from files it left (`state.json`, `answer.txt`), so after a check is fixed
 * the same trials can be graded by the fixed check without spending another token. `--regrade`
 * scores every trial again with the suite as it is now and writes `report-regraded.md` and
 * `summary-regraded.json` beside the run's own report, which it leaves as it was.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { renderKitReport, summarizeKitRun } from "../engine/kit/report";
import { isKitSuite } from "../engine/kit/suite";
import { suites } from "../engine/members/loaded";
import { type FlagGrammar, parseFlags, requireFlag } from "../engine/plan/flag-grammar";
import { readRunJournal } from "../engine/run/journal";
import { RUN_RECORD_FILE } from "../engine/run/output";
import type { TrialResultRecord } from "../engine/run/record";

export const KIT_REPORT_FLAGS = {
	valued: { run: true },
	valueless: { regrade: true, help: true },
} as const satisfies FlagGrammar;

const USAGE = "usage: bun evals.ts tool kit-report --run <run directory> [--regrade]";

/** The model ids the trials ran, joined, as a report names them. */
function modelsOf(records: readonly TrialResultRecord[]): string {
	const models = new Set<string>();
	for (const record of records) {
		const model = record.artifacts?.extra?.model;
		if (typeof model === "string") models.add(model);
	}
	return [...models].sort().join(", ") || "unknown";
}

/** The variants' names in plan order, from the run record; empty when the run never wrote one. */
async function planVariants(runDir: string): Promise<string[]> {
	let record: unknown;
	try {
		record = JSON.parse(await fs.readFile(path.join(runDir, RUN_RECORD_FILE), "utf8"));
	} catch {
		return [];
	}
	const variants: unknown = (record as { variants?: unknown } | null)?.variants;
	if (!Array.isArray(variants)) return [];
	return variants.flatMap((variant: unknown) => {
		const name = (variant as { name?: unknown } | null)?.name;
		return typeof name === "string" ? [name] : [];
	});
}

export async function kitReport(runDir: string, regrade: boolean): Promise<string> {
	const records = await readRunJournal(path.dirname(runDir), path.basename(runDir));
	const first = records[0];
	if (!first) throw new Error(`${runDir} holds no settled trial`);
	const suite = suites.require(first.cell.suite);
	if (!isKitSuite(suite)) throw new Error(`${suite.id} is not a kit suite; its report is its own`);
	const graded = regrade
		? await Promise.all(
				records.map(async record =>
					record.artifacts?.trialDir ? { ...record, score: await suite.scoreTrial(record.cell, record.artifacts) } : record,
				),
			)
		: records;
	const summary = summarizeKitRun(
		graded,
		{
			model: modelsOf(graded),
			tasks: [...new Set(graded.map(record => record.cell.task))],
			repeats: new Set(graded.map(record => record.cell.repeat)).size,
			variants: await planVariants(runDir),
		},
		suite.id,
	);
	const suffix = regrade ? "-regraded" : "";
	const report = path.join(runDir, `report${suffix}.md`);
	await fs.writeFile(path.join(runDir, `summary${suffix}.json`), `${JSON.stringify(summary, null, "\t")}\n`);
	await fs.writeFile(report, renderKitReport(summary, suite.spec.capabilities));
	return report;
}

if (import.meta.main) {
	let flags: Record<string, string>;
	try {
		flags = parseFlags(process.argv.slice(2), KIT_REPORT_FLAGS);
		if (flags.help !== undefined) {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		}
		const report = await kitReport(path.resolve(requireFlag(flags, "run", "e.g. --run runs/browser-main-vs-head")), flags.regrade !== undefined);
		process.stdout.write(`${report}\n`);
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n${USAGE}\n`);
		process.exit(2);
	}
}
