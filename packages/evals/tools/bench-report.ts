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
 *   bun evals.ts tool bench-report \
 *     --run <jobName> --doc docs/<page>.md [--key <block-key>] [--jobs-dir <dir>]
 *
 * `--key` names the block (defaults to the run's benchmark kind) so one page
 * can hold independent blocks for several benchmarks. It holds letters, digits,
 * `.`, `_` or `-`, since it is interpolated into an HTML comment. The block is
 * delimited by `<!-- bench-results:<key> -->` / `<!-- /bench-results:<key> -->`;
 * when the markers are absent the block goes at the end of the "## Benchmark
 * results" section, which is created when the doc states none.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, parseFlags } from "../engine/flag-grammar";
import { type BenchmarkSnapshot, readBenchmarkSnapshot, requireBenchmark } from "../store/benchmarks";
import { type RunRow, RunStore } from "../store/sqlite";
import { harborJobsDir } from "../engine/package-paths";
import { formatUsd } from "../engine/store-shapes";

function formatMetric(value: number | null, format: "percent" | "number" | "usd"): string {
	if (format === "usd") return formatUsd(value, "n/a");
	if (value === null) return "n/a";
	if (format === "percent") return `${(value * 100).toFixed(1)}%`;
	return value.toFixed(2);
}

/** Characters a block key may hold. */
const BLOCK_KEY = /^[A-Za-z0-9._-]+$/;

/** The heading a results block is filed under when the doc states none. */
const RESULTS_HEADING = "## Benchmark results";

/**
 * Validate the key naming one results block.
 *
 * The key is interpolated into an HTML comment, so a key holding `-->`, a `<` or a newline closed
 * the comment early: the doc rendered the markers as prose, the pair could no longer be found, and
 * the next emit appended a second block instead of replacing the first.
 */
export function requireBlockKey(key: string): string {
	if (!BLOCK_KEY.test(key)) {
		throw new Error(
			`Invalid bench block key ${JSON.stringify(key)}: use letters, digits, ".", "_" or "-", and at least one character.`,
		);
	}
	return key;
}

/** Render the canonical results block (markers included) for one run. */
export function renderBenchResultsBlock(run: RunRow, snapshot: BenchmarkSnapshot, key: string): string {
	requireBlockKey(key);
	const definition = requireBenchmark(run.benchmark);
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
		`| Cost | ${formatMetric(snapshot.costUsd, "usd")} |`,
	];
	if (run.note) lines.splice(2, 0, "", run.note.trim());
	lines.push(`<!-- /bench-results:${key} -->`);
	return lines.join("\n");
}

/**
 * Insert or replace the keyed block in a doc's text. Replacement spans the
 * existing marker pair exactly; a missing pair files the block at the end of the
 * "## Benchmark results" section, creating that heading when the doc states none,
 * so the first emit needs no manual doc preparation.
 */
export function upsertBenchResultsBlock(docText: string, key: string, block: string): string {
	requireBlockKey(key);
	const open = `<!-- bench-results:${key} -->`;
	const close = `<!-- /bench-results:${key} -->`;
	const start = docText.indexOf(open);
	if (start !== -1) {
		const end = docText.indexOf(close, start);
		if (end === -1) throw new Error(`Doc has an opening ${open} marker but no closing marker; fix the doc first.`);
		return docText.slice(0, start) + block + docText.slice(end + close.length);
	}
	const base = docText.endsWith("\n") ? docText : `${docText}\n`;
	const headingAt = base.indexOf(`${RESULTS_HEADING}\n`);
	if (headingAt === -1) return `${base}\n${RESULTS_HEADING}\n\n${block}\n`;
	// The block belongs to that section. Appending at the end of the file filed it under whichever
	// heading happened to come last, so a page carrying another section after the results grew a
	// results block outside the section it names.
	const afterHeading = headingAt + RESULTS_HEADING.length + 1;
	const nextHeading = base.slice(afterHeading).search(/^#{1,2} /m);
	const cut = nextHeading === -1 ? base.length : afterHeading + nextHeading;
	const head = base.slice(0, cut);
	const tail = base.slice(cut);
	const spaced = head.endsWith("\n\n") ? head : `${head}\n`;
	return tail.length === 0 ? `${spaced}${block}\n` : `${spaced}${block}\n\n${tail}`;
}

/** Flags the bench-report writer accepts. */
export const BENCH_REPORT_FLAGS = {
	valued: { run: true, doc: true, key: true, "jobs-dir": true },
} as const satisfies FlagGrammar;

const BENCH_REPORT_USAGE =
	"Usage: bun src/bench-report.ts --run <jobName> --doc <page.md> [--key <key>] [--jobs-dir <dir>]";

if (import.meta.main) {
	let args: Record<string, string>;
	try {
		args = parseFlags(process.argv.slice(2), BENCH_REPORT_FLAGS);
	} catch (error) {
		// A wrong command line wrote nothing, so it exits 2 rather than 1.
		console.error(errorMessage(error));
		console.error(BENCH_REPORT_USAGE);
		process.exit(2);
	}
	const runName = args.run;
	const docPath = args.doc;
	if (!runName || !docPath) {
		console.error(BENCH_REPORT_USAGE);
		process.exit(2);
	}
	if (args.key !== undefined) {
		try {
			requireBlockKey(args.key);
		} catch (error) {
			// A usage mistake exits 2, and it does so before a store is opened or a doc is read.
			console.error(errorMessage(error));
			process.exit(2);
		}
	}
	const jobsDir = args["jobs-dir"] ? path.resolve(args["jobs-dir"]) : harborJobsDir();
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
