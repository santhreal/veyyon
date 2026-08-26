#!/usr/bin/env bun

/**
 * The one entrypoint for every eval in this repository.
 *
 * `evals --suite <name>` selects a suite, the remaining flags select the other four
 * axes (harness, config, prompt variant, model) plus tasks and repeats. The suite
 * names the execution backend it needs, the run engine in `src/run/` decides the
 * cells and drives them, and nothing here knows what a container is.
 *
 * A suite-specific runner still exists where its flags are genuinely
 * suite-specific (`src/suites/deep-swe/run.ts` and its arm overlays). This CLI is
 * the cross-suite surface: the same invocation shape for Terminal-Bench, DeepSWE
 * and the TypeScript-edit benchmark.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { registerAllBackends } from "./backends";
import type { CellSummary, ConfigSpec, PromptVariantSpec, VariantMatrixSelection } from "./core";
import { requireBackend, requireSuite, summarizeRunCells } from "./core";
import { registerBuiltinHarnesses } from "./harnesses";
import { runsDir as defaultRunsDir } from "./paths";
import { buildRunPlan, describeRunPlan, executeRun } from "./run";
import { builtinSuites, registerAllSuites } from "./suites";

/** Flags that take a value. A flag outside this table never consumes the next argument. */
export const VALUE_FLAGS: Record<string, true> = {
	"--suite": true,
	"--harness": true,
	"--config": true,
	"--prompts": true,
	"--model": true,
	"--tasks": true,
	"--repeats": true,
	"--jobs": true,
	"--runs-dir": true,
	"--work-dir": true,
	"--dataset-dir": true,
	"--run-id": true,
};

export const BOOLEAN_FLAGS: Record<string, true> = {
	"--dry-run": true,
	"--list": true,
	"--help": true,
};

export interface EvalsCliArgs {
	readonly suite: string | null;
	readonly harnesses: readonly string[];
	readonly configs: readonly string[];
	readonly promptVariants: readonly string[];
	readonly models: readonly string[];
	readonly tasks: readonly string[];
	readonly repeats: number;
	readonly jobs: number;
	readonly runsDir: string | null;
	readonly workDir: string | null;
	readonly datasetDir: string | null;
	readonly runId: string | null;
	readonly dryRun: boolean;
	readonly list: boolean;
	readonly help: boolean;
}

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

/**
 * Parses argv into the five axes plus execution options.
 *
 * A value flag with no value is an error rather than a flag that swallows the next
 * one: `--tasks --dry-run` used to leave the run with a task named `--dry-run` and
 * no dry run at all.
 */
export function parseEvalsArgs(argv: readonly string[]): EvalsCliArgs {
	const harnesses: string[] = [];
	const configs: string[] = [];
	const promptVariants: string[] = [];
	const models: string[] = [];
	const tasks: string[] = [];
	let suite: string | null = null;
	let repeats = 1;
	let jobs = 1;
	let runsDir: string | null = null;
	let workDir: string | null = null;
	let datasetDir: string | null = null;
	let runId: string | null = null;
	let dryRun = false;
	let list = false;
	let help = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (!arg.startsWith("--")) {
			throw new CliUsageError(`Unexpected positional argument "${arg}". Every input is named by a flag.`);
		}

		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		let value: string | null = eq === -1 ? null : arg.slice(eq + 1);

		if (BOOLEAN_FLAGS[name]) {
			if (value !== null) {
				throw new CliUsageError(`${name} takes no value, got "${value}".`);
			}
			if (name === "--dry-run") dryRun = true;
			if (name === "--list") list = true;
			if (name === "--help") help = true;
			continue;
		}

		if (!VALUE_FLAGS[name]) {
			throw new CliUsageError(`Unknown flag "${name}". Run --help for the accepted flags.`);
		}

		if (value === null) {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new CliUsageError(`${name} needs a value.`);
			}
			value = next;
			index += 1;
		}
		if (value.length === 0) {
			throw new CliUsageError(`${name} needs a non-empty value.`);
		}

		const items = value
			.split(",")
			.map(item => item.trim())
			.filter(item => item.length > 0);

		switch (name) {
			case "--suite":
				suite = value;
				break;
			case "--harness":
				harnesses.push(...items);
				break;
			case "--config":
				configs.push(...items);
				break;
			case "--prompts":
				promptVariants.push(...items);
				break;
			case "--model":
				models.push(...items);
				break;
			case "--tasks":
				tasks.push(...items);
				break;
			case "--repeats": {
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1) {
					throw new CliUsageError(`--repeats must be an integer >= 1, got "${value}".`);
				}
				repeats = parsed;
				break;
			}
			case "--jobs": {
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1) {
					throw new CliUsageError(`--jobs must be an integer >= 1, got "${value}".`);
				}
				jobs = parsed;
				break;
			}
			case "--runs-dir":
				runsDir = value;
				break;
			case "--work-dir":
				workDir = value;
				break;
			case "--dataset-dir":
				datasetDir = value;
				break;
			case "--run-id":
				runId = value;
				break;
			default:
				throw new CliUsageError(`Unhandled flag "${name}".`);
		}
	}

	return {
		suite,
		harnesses,
		configs,
		promptVariants,
		models,
		tasks,
		repeats,
		jobs,
		runsDir,
		workDir,
		datasetDir,
		runId,
		dryRun,
		list,
		help,
	};
}

export const USAGE = `evals — run any evaluation suite in this repository

Usage:
  evals --list                                    list suites, backends and harnesses
  evals --list --suite <name>                     list the tasks of one suite
  evals --suite <name> --model <id> [options]     run a suite

Axes:
  --suite <name>            which evaluation suite (required to run)
  --harness <a,b>           harness axis (default: veyyon)
  --config <path,path>      config overlay files, one variant each
  --prompts <path,path>     prompt-variant overlay files, one variant each
  --model <id,id>           model axis, one variant each

Selection and execution:
  --tasks <ids|file>        task ids, or a task-list file (one id per line, # comments)
  --repeats <n>             trials per cell (default 1)
  --jobs <n>                trials in flight at once (default 1)
  --dataset-dir <path>      override the suite's dataset directory
  --runs-dir <path>         where trial output goes (default packages/evals/runs)
  --work-dir <path>         working directory handed to the backend (default cwd)
  --run-id <name>           name the run instead of generating a timestamped id
  --dry-run                 print the plan and every preflight verdict, run nothing
  --help                    this text
`;

/**
 * Task ids either arrive inline or in a file. A single argument that resolves to a
 * readable file is read as a task list; anything else is taken as an id.
 */
async function resolveTasks(tasks: readonly string[]): Promise<readonly string[]> {
	if (tasks.length !== 1) return tasks;
	const candidate = tasks[0] as string;
	let text: string;
	try {
		text = await fs.readFile(candidate, "utf8");
	} catch {
		return tasks;
	}
	const ids = text
		.split("\n")
		.map(line => line.replace(/#.*$/, "").trim())
		.filter(line => line.length > 0);
	if (ids.length === 0) {
		throw new CliUsageError(`Task list "${candidate}" holds no task ids.`);
	}
	return ids;
}

function summaryTable(summaries: readonly CellSummary[]): string {
	const header = "| variant | trials | passes | errors | pass rate | mean reward |";
	const divider = "| --- | --- | --- | --- | --- | --- |";
	const rows = summaries.map(summary => {
		const passRate = summary.passRate === null ? "—" : `${(summary.passRate * 100).toFixed(1)}%`;
		const meanReward = summary.meanReward === null ? "—" : summary.meanReward.toFixed(3);
		return `| ${summary.variant} | ${summary.total} | ${summary.passes} | ${summary.errors} | ${passRate} | ${meanReward} |`;
	});
	return [header, divider, ...rows].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	registerAllSuites();
	registerAllBackends();
	registerBuiltinHarnesses();

	let args: EvalsCliArgs;
	try {
		args = parseEvalsArgs(argv);
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
		return 2;
	}

	if (args.help || (argv.length === 0 && !args.list)) {
		process.stdout.write(USAGE);
		return 0;
	}

	if (args.list && args.suite === null) {
		const lines = builtinSuites.map(
			suite => `  ${suite.name.padEnd(18)} ${suite.backend.padEnd(12)} ${suite.description}`,
		);
		process.stdout.write(`suites (name, backend, description):\n${lines.join("\n")}\n`);
		return 0;
	}

	if (args.suite === null) {
		process.stderr.write(`--suite is required.\n\n${USAGE}`);
		return 2;
	}

	const suite = requireSuite(args.suite);
	const context = {
		datasetDir: args.datasetDir ?? undefined,
		workDir: args.workDir ?? process.cwd(),
	};

	if (args.list) {
		const ids = await suite.discoverTasks(context);
		process.stdout.write(`${ids.join("\n")}\n`);
		return 0;
	}

	if (args.models.length === 0) {
		process.stderr.write(`--model is required to run ${suite.name}.\n\n${USAGE}`);
		return 2;
	}

	const configs: readonly ConfigSpec[] | undefined =
		args.configs.length > 0 ? args.configs.map(file => ({ path: file })) : undefined;
	const promptVariants: readonly PromptVariantSpec[] | undefined =
		args.promptVariants.length > 0 ? args.promptVariants.map(file => ({ path: file })) : undefined;
	const selection: VariantMatrixSelection = {
		harnesses: args.harnesses.length > 0 ? args.harnesses : ["veyyon"],
		configs,
		promptVariants,
		models: args.models,
	};

	const plan = await buildRunPlan({
		suite,
		selection,
		tasks: await resolveTasks(args.tasks),
		repeats: args.repeats,
		context,
		runId: args.runId ?? undefined,
	});

	const backend = requireBackend(suite.backend);
	process.stdout.write(`${describeRunPlan(plan)}\n  backend    ${backend.id}\n`);

	if (args.dryRun) {
		const suiteVerdict = await suite.preflight(context);
		const runsDir = path.resolve(args.runsDir ?? defaultRunsDir());
		const backendVerdict = await backend.preflight({
			runId: plan.runId,
			suite,
			workDir: context.workDir,
			runsDir,
		});
		const verdicts = [
			`  suite      ${suiteVerdict.ok ? "ok" : `REFUSED — ${suiteVerdict.reason ?? "no reason given"}`}`,
			`  backend    ${backendVerdict.ok ? "ok" : `REFUSED — ${backendVerdict.reason ?? "no reason given"}`}`,
		].join("\n");
		process.stdout.write(`\npreflight:\n${verdicts}\n`);
		if (!suiteVerdict.ok || !backendVerdict.ok) return 1;
		process.stdout.write("\nDRY RUN — nothing was executed.\n");
		return 0;
	}

	const runsDir = path.resolve(args.runsDir ?? defaultRunsDir());
	await fs.mkdir(runsDir, { recursive: true });

	const total = plan.cells.length;
	const record = await executeRun({
		plan,
		backend,
		workDir: context.workDir,
		runsDir,
		jobs: args.jobs,
		options: { datasetDir: args.datasetDir ?? undefined },
		onTrial: (trial, index) => {
			const outcome = trial.score.error !== null ? `error: ${trial.score.error}` : `reward ${trial.score.reward}`;
			process.stdout.write(`[${index + 1}/${total}] ${trial.cell.variant} ${trial.cell.task} — ${outcome}\n`);
		},
	});

	process.stdout.write(`\n${summaryTable(summarizeRunCells(record))}\n`);
	const errors = record.results.filter(result => result.score.error !== null).length;
	process.stdout.write(`\nrun ${record.id}: ${record.results.length} trial(s), ${errors} error(s)\n`);
	return errors > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exitCode = await main();
}
