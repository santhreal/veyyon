#!/usr/bin/env bun
/**
 * Emit a run's benchmark results into a FEATURE DOC page.
 *
 * Bench results belong next to the feature they measure, not in the
 * changelog: the doc page carries a marker-fenced block this tool inserts
 * or replaces in place, so re-benching a feature updates one canonical
 * block instead of scattering result tables through prose or CHANGELOG.
 *
 * Usage:
 *   bun packages/metaharness/src/bench-report.ts \
 *     --run <jobName> --doc docs/<page>.md [--key <block-key>] [--jobs-dir <dir>]
 *
 * `--key` names the block (defaults to the run's benchmark kind) so one page
 * can hold independent blocks for several benchmarks. The block is delimited
 * by `<!-- bench-results:<key> -->` / `<!-- /bench-results:<key> -->`; when
 * the markers are absent the block is appended under a "## Benchmark
 * results" heading.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BENCHMARK_DEFINITIONS, type BenchmarkSnapshot, readBenchmarkSnapshot } from "./benchmarks";
import { DEFAULT_JOBS_DIR } from "./paths";
import { type RunRow, RunStore } from "./store";

function formatMetric(value: number | null, format: "percent" | "number" | "usd"): string {
	if (value === null) return "n/a";
	if (format === "percent") return `${(value * 100).toFixed(1)}%`;
	if (format === "usd") return `$${value.toFixed(2)}`;
	return value.toFixed(2);
}

/** Render the canonical results block (markers included) for one run. */
export function renderBenchResultsBlock(run: RunRow, snapshot: BenchmarkSnapshot, key: string): string {
	const definition = BENCHMARK_DEFINITIONS.find(d => d.kind === run.benchmark);
	if (!definition) throw new Error(`No benchmark definition for kind ${run.benchmark}`);
	const finished = run.finishedAt ? new Date(run.finishedAt).toISOString().slice(0, 10) : "unfinished";
	const metricCells = definition.metrics.map(
		m => `| ${m.label} | ${formatMetric(snapshot.metrics[m.key] ?? null, m.format)} |`,
	);
	const lines = [
		`<!-- bench-results:${key} -->`,
		`**${definition.label}**: run \`${run.jobName}\` (${run.models || run.agent || "unknown model"}, ${finished})`,
		"",
		"| Metric | Value |",
		"| --- | --- |",
		...metricCells,
		`| Tasks pass / fail / error | ${snapshot.pass} / ${snapshot.fail} / ${snapshot.error} (of ${snapshot.total}) |`,
		`| Cost | $${snapshot.costUsd.toFixed(2)} |`,
	];
	if (run.note) lines.splice(2, 0, "", run.note.trim());
	lines.push(`<!-- /bench-results:${key} -->`);
	return lines.join("\n");
}

/**
 * Insert or replace the keyed block in a doc's text. Replacement spans the
 * existing marker pair exactly; a missing pair appends the block under a
 * "## Benchmark results" heading (created if absent) so the first emit
 * needs no manual doc preparation.
 */
export function upsertBenchResultsBlock(docText: string, key: string, block: string): string {
	const open = `<!-- bench-results:${key} -->`;
	const close = `<!-- /bench-results:${key} -->`;
	const start = docText.indexOf(open);
	if (start !== -1) {
		const end = docText.indexOf(close, start);
		if (end === -1) throw new Error(`Doc has an opening ${open} marker but no closing marker; fix the doc first.`);
		return docText.slice(0, start) + block + docText.slice(end + close.length);
	}
	const heading = "## Benchmark results";
	const base = docText.endsWith("\n") ? docText : `${docText}\n`;
	if (base.includes(`${heading}\n`)) return `${base}\n${block}\n`;
	return `${base}\n${heading}\n\n${block}\n`;
}

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg?.startsWith("--")) out[arg.slice(2)] = argv[++i] ?? "";
	}
	return out;
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	const runName = args.run;
	const docPath = args.doc;
	if (!runName || !docPath) {
		console.error("Usage: bun src/bench-report.ts --run <jobName> --doc <page.md> [--key <key>] [--jobs-dir <dir>]");
		process.exit(2);
	}
	const jobsDir = args["jobs-dir"] ? path.resolve(args["jobs-dir"]) : DEFAULT_JOBS_DIR;
	const store = new RunStore(jobsDir);
	const run = store.syncRun(runName);
	if (!run) {
		console.error(
			`No run named ${runName} in ${jobsDir}. \`bun src/bench-report.ts\` lists nothing; check the dashboard for names.`,
		);
		process.exit(1);
	}
	const snapshot = readBenchmarkSnapshot(run.benchmark, path.join(jobsDir, runName));
	const block = renderBenchResultsBlock(run, snapshot, args.key || run.benchmark);
	const resolvedDoc = path.resolve(docPath);
	if (!fs.existsSync(resolvedDoc)) {
		console.error(
			`Doc page ${resolvedDoc} does not exist. Bench results land in an existing feature doc, not a new file.`,
		);
		process.exit(1);
	}
	fs.writeFileSync(
		resolvedDoc,
		upsertBenchResultsBlock(fs.readFileSync(resolvedDoc, "utf8"), args.key || run.benchmark, block),
	);
	console.log(`Updated ${docPath} with results of ${runName}.`);
}
