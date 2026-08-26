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
import type {
	CellSummary,
	ConfigSpec,
	EvalSuite,
	PromptVariantSpec,
	SuiteContext,
	VariantMatrixSelection,
} from "./core";
import { requireBackend, requireSuite, summarizeRunCells } from "./core";
import { registerBuiltinHarnesses } from "./harnesses";
import { runsDir as defaultRunsDir } from "./paths";
import { buildRunPlan, describeRunPlan, executeRun, type RunPlan } from "./run";
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
	readonly suites: readonly string[];
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
	const suites: string[] = [];
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
				suites.push(...items);
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
		suites,
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
  evals --list --suite <name,name>                list the tasks of each named suite
  evals --suite <name,name> --model <id>          run one or more suites

Axes:
  --suite <name,name>       evaluation suites, one run record each (required to run)
  --harness <a,b>           harness axis (default: veyyon)
  --config <path,path>      config overlay files, one variant each
  --prompts <path,path>     prompt-variant overlay files, one variant each
  --model <id,id>           model axis, one variant each

Selection and execution:
  --tasks <ids|file>        task ids, or a task-list file (one id per line, # comments).
                            Prefix an entry with a suite name (--tasks deep-swe=smoke.txt)
                            to scope it; an unprefixed entry applies to every suite.
  --repeats <n>             trials per cell (default 1)
  --jobs <n>                trials in flight at once (default 1)
  --dataset-dir <path>      override the suite's dataset directory (one suite only)
  --runs-dir <path>         where trial output goes (default packages/evals/runs)
  --work-dir <path>         working directory handed to the backend (default cwd)
  --run-id <name>           name the run instead of generating a timestamped id; with
                            several suites each run is named <name>-<suite>
  --dry-run                 print the plan and every preflight verdict, run nothing
  --help                    this text
`;

/**
 * The entries of `--tasks` that apply to one suite: those carrying its name as a
 * `<suite>=<entry>` prefix, or, when no entry names this suite, every unprefixed
 * entry. A prefix naming a suite the invocation does not run is a usage error
 * rather than a silently dropped task list.
 */
export function tasksForSuite(tasks: readonly string[], suite: string, running: readonly string[]): readonly string[] {
	const scoped: string[] = [];
	const unscoped: string[] = [];
	for (const entry of tasks) {
		const eq = entry.indexOf("=");
		if (eq === -1) {
			unscoped.push(entry);
			continue;
		}
		const prefix = entry.slice(0, eq);
		if (!running.includes(prefix)) {
			throw new CliUsageError(
				`--tasks entry "${entry}" names suite "${prefix}", which this run does not include (${running.join(", ")}).`,
			);
		}
		if (prefix === suite) scoped.push(entry.slice(eq + 1));
	}
	return scoped.length > 0 ? scoped : unscoped;
}

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

	if (args.list && args.suites.length === 0) {
		const lines = builtinSuites.map(
			suite => `  ${suite.name.padEnd(18)} ${suite.backend.padEnd(12)} ${suite.description}`,
		);
		process.stdout.write(`suites (name, backend, description):\n${lines.join("\n")}\n`);
		return 0;
	}

	if (args.suites.length === 0) {
		process.stderr.write(`--suite is required.\n\n${USAGE}`);
		return 2;
	}

	const names = [...new Set(args.suites)];
	if (names.length > 1 && args.datasetDir !== null) {
		process.stderr.write(
			`--dataset-dir names one suite's dataset, and this run has ${names.length} (${names.join(", ")}).\n`,
		);
		return 2;
	}

	let suites: readonly EvalSuite[];
	try {
		suites = names.map(name => requireSuite(name));
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
		return 2;
	}

	if (args.list) {
		for (const suite of suites) {
			const ids = await suite.discoverTasks(suiteContext(args, suite));
			const header = suites.length > 1 ? `# ${suite.name}\n` : "";
			process.stdout.write(`${header}${ids.join("\n")}\n`);
		}
		return 0;
	}

	if (args.models.length === 0) {
		process.stderr.write(`--model is required to run ${names.join(", ")}.\n\n${USAGE}`);
		return 2;
	}

	// One run record per suite: a record is suite-tagged, and two suites' trials are
	// never comparable, so the store and the report refuse to merge them. The exit
	// code is the worst any suite produced, and a suite that refuses does not stop
	// the ones after it.
	let worst = 0;
	for (const suite of suites) {
		if (suites.length > 1) process.stdout.write(`\n=== ${suite.name} ===\n`);
		const code = await runOneSuite(args, suite, names);
		if (code > worst) worst = code;
	}
	return worst;
}

/** The context every suite call takes: dataset override, working directory, run options. */
function suiteContext(args: EvalsCliArgs, suite: EvalSuite): SuiteContext {
	return {
		datasetDir: args.datasetDir ?? undefined,
		workDir: args.workDir ?? process.cwd(),
		options: {
			dryRun: args.dryRun,
			ensureBinary: !args.dryRun,
			model: args.models[0],
			suite: suite.name,
		},
	};
}

/**
 * Plans and runs one suite. Returns the process exit code this suite earned: 0
 * clean, 1 a refusal or a trial error.
 */
async function runOneSuite(args: EvalsCliArgs, suite: EvalSuite, running: readonly string[]): Promise<number> {
	const context = suiteContext(args, suite);
	const workDir = args.workDir ?? process.cwd();
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
	const runId = args.runId === null ? undefined : running.length > 1 ? `${args.runId}-${suite.name}` : args.runId;

	let plan: RunPlan;
	try {
		plan = await buildRunPlan({
			suite,
			selection,
			tasks: await resolveTasks(tasksForSuite(args.tasks, suite.name, running)),
			repeats: args.repeats,
			context,
			runId,
		});
	} catch (error) {
		if (args.dryRun) {
			process.stdout.write(`\npreflight:\n  harness    REFUSED — ${errorMessage(error)}\n`);
			return 1;
		}
		process.stderr.write(`${errorMessage(error)}\n`);
		return 1;
	}

	const backend = requireBackend(suite.backend);
	process.stdout.write(`${describeRunPlan(plan)}\n  backend    ${backend.id}\n`);
	const runsDir = path.resolve(args.runsDir ?? defaultRunsDir());

	if (args.dryRun) {
		const suiteVerdict = await suite.preflight(context);
		// The same context `executeRun` would hand the backend: a preflight that cannot see
		// the plan's variants validates no overlay, so a dry run passed an unknown prompt id
		// and the refusal arrived on the real run instead.
		const backendVerdict = await backend.preflight({
			runId: plan.runId,
			suite,
			workDir,
			runsDir,
			options: { ...context.options, variants: plan.variants },
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

	await fs.mkdir(runsDir, { recursive: true });

	const total = plan.cells.length;
	const record = await executeRun({
		plan,
		backend,
		workDir,
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
