#!/usr/bin/env bun
/** Manager-owned executable adapter for the TypeScript edit benchmark. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import {
	type FlagGrammar,
	FlagValueError,
	flagCount,
	parseFlags,
	requireFlag,
	UnknownFlagError,
} from "../../../core/flags";
import { extractFixtures } from "../extract";
import { loadTasksFromDir } from "../tasks";
import { generateJsonReport } from "./report";
import { runBenchmark } from "./runner/scheduler";
import type { BenchmarkConfig } from "./runner/types";

/** Tasks measured when a run states no limit. */
export const DEFAULT_MAX_TASKS = 80;

/** Tasks measured at once when a run states no concurrency. */
export const DEFAULT_TASK_CONCURRENCY = 32;

/** Flags this adapter accepts, read through the one grammar every evals entry point uses. */
export const EDIT_ADAPTER_FLAGS = {
	valued: {
		model: true,
		output: true,
		"max-tasks": true,
		tasks: true,
		"task-concurrency": true,
		runs: true,
		"fixtures-archive": true,
	},
	valueless: { list: true, help: true },
} as const satisfies FlagGrammar;

/** Usage text, printed for `--help` and after a refusal. */
export const EDIT_ADAPTER_USAGE = `typescript-edit adapter — run the edit benchmark and write its JSON report

Usage:
  cli.ts --model <provider/model-id> --output <report.json> [options]
  cli.ts --list
  cli.ts --help

Flags:
  --model <provider/model-id>  model the trials run (required)
  --output <path>              JSON report path; the conversation dump lands beside it (required)
  --tasks <ids>                comma-separated task ids to run (default: a spread of the corpus)
  --max-tasks <n>              tasks to measure when --tasks is absent, integer >= 1 (default: ${DEFAULT_MAX_TASKS})
  --task-concurrency <n>       tasks measured at once, integer >= 1 (default: ${DEFAULT_TASK_CONCURRENCY})
  --runs <n>                   trials per task, integer >= 1 (default: 1)
  --fixtures-archive <path>    measure this fixtures archive instead of the bundled one
  --list                       print the task ids and names as JSON, then exit
  --help                       this text
`;

/** Execute an edit benchmark and continuously materialize its normalized source artifact. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const flags = parseFlags(argv, EDIT_ADAPTER_FLAGS);
	if (flags.help !== undefined) {
		process.stdout.write(EDIT_ADAPTER_USAGE);
		return;
	}
	// Every count is read through the grammar, so `--runs abc` refuses instead of reaching the
	// scheduler as NaN and measuring nothing, and `--task-concurrency 0` cannot ask for a run
	// with no workers.
	const maxTasks = flagCount(flags, "max-tasks") ?? DEFAULT_MAX_TASKS;
	const taskConcurrency = flagCount(flags, "task-concurrency") ?? DEFAULT_TASK_CONCURRENCY;
	const runsPerTask = flagCount(flags, "runs") ?? 1;

	// A run may measure a regenerated archive without replacing the bundled one.
	const archivePath = flags["fixtures-archive"];

	if (flags.list !== undefined) {
		const listing = await extractFixtures({ archivePath });
		try {
			const tasks = await loadTasksFromDir(listing.dir);
			process.stdout.write(`${JSON.stringify(tasks.map(task => ({ id: task.id, name: task.name })))}\n`);
		} finally {
			await listing.cleanup();
		}
		return;
	}

	// Every refusal above and below happens before the fixture archive is unpacked, so a wrong
	// command line costs the invocation rather than an extraction.
	const model = requireFlag(flags, "model", "provider/model-id the trials run");
	const output = requireFlag(flags, "output", "path the JSON report is written to");

	const fixtures = await extractFixtures({ archivePath });
	try {
		let tasks = await loadTasksFromDir(fixtures.dir);
		if (flags.tasks !== undefined) {
			const selected = flags.tasks
				.split(",")
				.map(value => value.trim())
				.filter(Boolean);
			if (selected.length === 0) {
				throw new FlagValueError(`--tasks names nothing, got ${JSON.stringify(flags.tasks)}`);
			}
			const known = new Set(tasks.map(task => task.id));
			const missing = selected.filter(id => !known.has(id));
			if (missing.length > 0) {
				throw new FlagValueError(`--tasks names ${missing.length} unknown edit task id(s): ${missing.join(", ")}`);
			}
			const wanted = new Set(selected);
			tasks = tasks.filter(task => wanted.has(task.id));
		} else {
			const limit = maxTasks;
			if (tasks.length > limit) {
				const sorted = tasks.slice().sort((a, b) => a.id.localeCompare(b.id));
				const step = sorted.length / limit;
				tasks = Array.from({ length: limit }, (_, index) => sorted[Math.floor(index * step)]!);
			}
		}
		const slash = model.indexOf("/");
		const config: BenchmarkConfig = {
			provider: slash === -1 ? "anthropic" : model.slice(0, slash),
			model,
			runsPerTask,
			timeout: 120_000,
			connectionTimeout: 30_000,
			maxTurns: 30,
			taskConcurrency,
			guided: false,
			maxAttempts: 1,
			noOpRetryLimit: 2,
			maxTimeoutRetries: 3,
			maxProviderFailureRetries: 3,
			mutationScopeWindow: 20,
			conversationDumpDir: path.join(path.dirname(output), "result.dump"),
			inProcess: true,
			earlyStopOnMatch: true,
		};
		let writes = Promise.resolve();
		const result = await runBenchmark(tasks, config, undefined, snapshot => {
			writes = writes.then(async () => {
				await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
				await fs.writeFile(output, generateJsonReport(snapshot), "utf8");
			});
		});
		await writes;
		await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
		await fs.writeFile(output, generateJsonReport(result), "utf8");
	} finally {
		await fixtures.cleanup();
	}
}

if (import.meta.main) {
	main().catch(error => {
		const usage = error instanceof UnknownFlagError || error instanceof FlagValueError;
		process.stderr.write(`${errorMessage(error)}\n${usage ? `\n${EDIT_ADAPTER_USAGE}` : ""}`);
		// A wrong command line means nothing ran, which a caller reads apart from a failed run.
		process.exitCode = usage ? 2 : 1;
	});
}
