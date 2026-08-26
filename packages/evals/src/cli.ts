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
	BackendId,
	CellSummary,
	ConfigSpec,
	EvalRunRecord,
	EvalSuite,
	HarnessAdapter,
	PromptVariantSpec,
	SuiteContext,
	VariantMatrixSelection,
} from "./core";
import {
	checkVariantSupport,
	judgeRunOutcome,
	listBackendIds,
	listHarnesses,
	listSuites,
	requireBackend,
	requireHarness,
	requireSuite,
	summarizeRunCells,
	type UnappliedVariantAxisError,
	variantSupportQuery,
} from "./core";
import { preflightHarnesses } from "./core/harness-preflight";
import { registerBuiltinHarnesses } from "./harnesses";
import { runsDir as defaultRunsDir, requirePathSegment } from "./paths";
import {
	buildRunPlan,
	checkRunDirectories,
	describeRunPlan,
	executeRun,
	journalExists,
	journalPathFor,
	type RunPlan,
	readRunJournal,
} from "./run";
import { registerAllSuites } from "./suites";

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
	"--resume": true,
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
	readonly resume: boolean;
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
	let resume = false;
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
			if (name === "--resume") resume = true;
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
				// The id names a directory under the runs directory. Refused here so a separator
				// or a `..` is a usage error, not a journal written outside the tree.
				runId = requirePathSegment(value, "--run-id value");
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
		resume,
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
                            A value holding a path separator or a .txt/.jsonl/.list/.tasks
                            extension names a file and must exist. Prefix an entry with a
                            suite name (--tasks deep-swe=smoke.txt) to scope it; an
                            unprefixed entry applies to every suite.
  --repeats <n>             trials per cell (default 1)
  --jobs <n>                trials in flight at once (default 1)
  --dataset-dir <path>      override the suite's dataset directory, which must exist (one
                            suite only)
  --runs-dir <path>         where trial output goes, created when absent (default
                            packages/evals/runs)
  --work-dir <path>         working directory handed to the backend, which must exist
                            (default cwd)
  --run-id <name>           name the run instead of generating a timestamped id; with
                            several suites each run is named <name>-<suite>
  --dry-run                 print the plan and every preflight verdict, run nothing
  --resume                  resume a prior run from its trials.jsonl journal
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
 * The extensions a task list is written with. Exported so a caller sweeps them rather than
 * restating the set, since every one of them is a value the CLI reads as a file.
 */
export const TASK_LIST_EXTENSIONS = [".txt", ".jsonl", ".list", ".tasks"] as const;

/**
 * A value that names a place rather than a task: it holds a path separator, or carries one
 * of the extensions a task list is written with. No suite discovers an id of that shape, so
 * reading such a value as an id can only ever be the wrong answer.
 */
function looksLikeTaskListPath(value: string): boolean {
	if (value.includes("/") || value.includes(path.sep)) return true;
	const lowered = value.toLowerCase();
	return TASK_LIST_EXTENSIONS.some(extension => lowered.endsWith(extension));
}

/**
 * Task ids either arrive inline or in a file. A single argument that resolves to a
 * readable file is read as a task list; anything else is taken as an id — unless it is
 * shaped like a path, in which case an unreadable value is refused by path. A mistyped
 * task-list file otherwise read as one unknown task id, and the refusal named the suite's
 * task count instead of the file that is missing.
 */
async function resolveTasks(tasks: readonly string[]): Promise<readonly string[]> {
	for (const entry of tasks) {
		if (!looksLikeTaskListPath(entry)) continue;
		try {
			await fs.access(entry);
		} catch (cause) {
			throw new CliUsageError(
				`--tasks names a task-list file that cannot be read: ${entry} (${errorMessage(cause)}).`,
			);
		}
		if (tasks.length > 1) {
			throw new CliUsageError(
				`--tasks takes either one task-list file or a list of ids, and this run got both: ${tasks.join(", ")}.`,
			);
		}
	}
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

/**
 * Renders one row per variant.
 *
 * `graded` is the denominator of both rates: a timed-out trial is a graded failure, and a trial
 * that never reached a grade is excluded and printed in its own column — `ungraded` for a trial
 * that settled with no reward and no error, `errors` for one that reported a failure — so a run
 * whose trials mostly crashed can never read as a high pass rate.
 */
function summaryTable(summaries: readonly CellSummary[]): string {
	const header = "| variant | trials | graded | passes | timeouts | ungraded | errors | pass rate | mean reward |";
	const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
	const rows = summaries.map(summary => {
		const passRate = summary.passRate === null ? "—" : `${(summary.passRate * 100).toFixed(1)}%`;
		const meanReward = summary.meanReward === null ? "—" : summary.meanReward.toFixed(3);
		return `| ${summary.variant} | ${summary.total} | ${summary.denominator} | ${summary.passes} | ${summary.timedOut} | ${summary.unscored} | ${summary.errors} | ${passRate} | ${meanReward} |`;
	});
	return [header, divider, ...rows].join("\n");
}

/**
 * What `--list` states without a suite: the three registries an invocation selects from.
 *
 * Every row is read from the registry rather than from a literal, so a suite, backend or
 * harness registered by anything outside this package is listed by the same call. A
 * harness states the backends it binds, because a harness the run backend cannot reach is
 * the refusal an operator hits after the container is already paid for.
 */
export function describeRegistries(
	suites: readonly Pick<EvalSuite, "name" | "backend" | "description">[],
	backends: readonly BackendId[],
	harnesses: readonly Pick<HarnessAdapter, "name" | "defaultModel" | "backends">[],
): string {
	const columns = (rows: readonly (readonly string[])[]): string[] => {
		const widths = rows.reduce<number[]>(
			(acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
			[],
		);
		return rows.map(row =>
			`  ${row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join("  ")}`.trimEnd(),
		);
	};

	const suiteRows = columns(
		[...suites]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(suite => [suite.name, suite.backend, suite.description]),
	);
	const backendRows = [...backends].sort().map(id => `  ${id}`);
	const harnessRows = columns(
		[...harnesses]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(harness => [
				harness.name,
				harness.defaultModel ?? "--model required",
				Object.keys(harness.backends).sort().join(", ") || "none",
			]),
	);
	return [
		"suites (name, backend, description):",
		...suiteRows,
		"",
		"backends (id):",
		...backendRows,
		"",
		"harnesses (name, default model, backends it binds):",
		...harnessRows,
		"",
	].join("\n");
}

/**
 * The `resume` verdict line's body: what a resume of this run id would find.
 *
 * A journal this build cannot read is a refusal here rather than an exception mid-run, and
 * a journal that exists but holds no settled trial is stated as such — a run interrupted
 * before its first trial is resumable, and reporting it as missing would send an operator
 * to a new run id for nothing.
 */
export async function describeResume(runsDir: string, runId: string): Promise<string> {
	const journal = journalPathFor(runsDir, runId);
	if (!(await journalExists(runsDir, runId))) {
		return `REFUSED — no trial journal at ${journal}: there is nothing to resume`;
	}
	try {
		const prior = await readRunJournal(runsDir, runId);
		return `ok — ${prior.length} settled trial(s) in ${journal} would be skipped`;
	} catch (error) {
		return `REFUSED — ${errorMessage(error)}`;
	}
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
		process.stdout.write(describeRegistries(listSuites(), listBackendIds(), listHarnesses()));
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
	const runsDir = path.resolve(args.runsDir ?? defaultRunsDir());
	// Directories decide before a plan does. A suite discovers its tasks out of the dataset
	// directory, so a mistyped --dataset-dir arrived as a raw ENOENT on the harness verdict
	// line; a runs directory that is a regular file, or a work directory that is not there,
	// was reported `ok` by a dry run and failed once a trial had already been paid for.
	const pathProblems = await checkRunDirectories({
		runsDir,
		workDir,
		datasetDir: args.datasetDir ?? undefined,
	});
	if (pathProblems.length > 0) {
		if (args.dryRun) {
			const lines = pathProblems.map(problem => `  paths      REFUSED — ${problem.message}`).join("\n");
			process.stdout.write(`\npreflight:\n${lines}\n`);
		} else {
			process.stderr.write(`${pathProblems.map(problem => problem.message).join("\n")}\n`);
		}
		return 1;
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
		// A mistyped flag value is a usage refusal wherever it is decided, and it is decided
		// here for --tasks, whose file is read while the plan is being built. Reporting it as
		// a `harness` verdict named an axis that had nothing to do with it, and returned the
		// exit code of a failed run instead of the one every other usage refusal returns.
		if (error instanceof CliUsageError) {
			process.stderr.write(`${errorMessage(error)}\n\n${USAGE}`);
			return 2;
		}
		if (args.dryRun) {
			process.stdout.write(`\npreflight:\n  harness    REFUSED — ${errorMessage(error)}\n`);
			return 1;
		}
		process.stderr.write(`${errorMessage(error)}\n`);
		return 1;
	}

	const backend = requireBackend(suite.backend);
	// Every axis this selection varies needs someone to apply it. `--prompts a,b` against a
	// backend that drops the path expands the matrix, names the cells apart, and runs the
	// same trial twice — a report comparing two identical arms. One line per axis and
	// refusing party, not one per variant, which would repeat the same sentence per cell.
	const unappliedAxes = new Map<string, UnappliedVariantAxisError>();
	for (const problem of checkVariantSupport(
		variantSupportQuery(backend, plan.variants, harness => requireHarness(harness).capabilities),
	)) {
		const key = `${problem.axis}\u0000${problem.holder}\u0000${problem.holderName}`;
		if (!unappliedAxes.has(key)) unappliedAxes.set(key, problem);
	}
	process.stdout.write(`${describeRunPlan(plan)}\n  backend    ${backend.id}\n`);

	// An axis nobody applies cannot be preflighted into working, so this refuses here rather
	// than stating verdicts for a run that will not happen — the same shape as an unusable
	// directory above.
	if (unappliedAxes.size > 0) {
		const reasons = [...unappliedAxes.values()].map(problem => errorMessage(problem));
		if (args.dryRun) {
			const lines = reasons.map(reason => `  axes       REFUSED — ${reason}`).join("\n");
			process.stdout.write(`\npreflight:\n  paths      ok\n${lines}\n`);
		} else {
			for (const reason of reasons) process.stderr.write(`${reason}\n`);
		}
		return 1;
	}

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
		// The harness axis is preflighted on the real run too, so a dry run that skipped it
		// promised a verdict the run then refused.
		const harnessReports = await preflightHarnesses(plan.variants, {
			backend: suite.backend,
			options: { ...context.options, variants: plan.variants },
		});
		const refusedHarness = harnessReports.filter(report => !report.verdict.ok);
		const harnessLine =
			refusedHarness.length === 0
				? "  harness    ok"
				: refusedHarness
						.map(
							report =>
								`  harness    REFUSED — ${report.harness} (${report.variant}): ${report.verdict.reason ?? "no reason given"}`,
						)
						.join("\n");
		// What --resume would find. A dry run that reported nothing about it let a mistyped
		// --run-id read as a plan for a fresh run, which is what the real invocation then
		// paid for.
		const resumeLine = args.resume ? `  resume     ${await describeResume(runsDir, plan.runId)}` : null;
		const verdicts = [
			// Reached only when the directories and the axes checked out above, which is why these
			// state `ok` rather than checking again: a dry run names the same verdicts the real run
			// reaches, and a refusal above never gets this far.
			"  paths      ok",
			"  axes       ok",
			`  suite      ${suiteVerdict.ok ? "ok" : `REFUSED — ${suiteVerdict.reason ?? "no reason given"}`}`,
			harnessLine,
			`  backend    ${backendVerdict.ok ? "ok" : `REFUSED — ${backendVerdict.reason ?? "no reason given"}`}`,
			...(resumeLine === null ? [] : [resumeLine]),
		].join("\n");
		process.stdout.write(`\npreflight:\n${verdicts}\n`);
		const resumeRefused = resumeLine?.includes("REFUSED") === true;
		if (!suiteVerdict.ok || !backendVerdict.ok || refusedHarness.length > 0 || resumeRefused) return 1;
		process.stdout.write("\nDRY RUN — nothing was executed.\n");
		return 0;
	}

	const total = plan.cells.length;
	const controller = new AbortController();
	let abortedSignal: string | null = null;
	const onSigInt = () => {
		if (!controller.signal.aborted) {
			abortedSignal = "SIGINT";
			controller.abort();
		}
	};
	const onSigTerm = () => {
		if (!controller.signal.aborted) {
			abortedSignal = "SIGTERM";
			controller.abort();
		}
	};

	process.on("SIGINT", onSigInt);
	process.on("SIGTERM", onSigTerm);

	let record: EvalRunRecord | undefined;
	try {
		record = await executeRun({
			plan,
			backend,
			workDir,
			runsDir,
			jobs: args.jobs,
			signal: controller.signal,
			resume: args.resume,
			options: { datasetDir: args.datasetDir ?? undefined },
			onSkip: (skipped, totalCount) => {
				process.stdout.write(
					`resumed run ${plan.runId}: skipping ${skipped} already-settled trial(s) out of ${totalCount}\n`,
				);
			},
			onTrial: (trial, index) => {
				const outcome = trial.score.error !== null ? `error: ${trial.score.error}` : `reward ${trial.score.reward}`;
				process.stdout.write(`[${index + 1}/${total}] ${trial.cell.variant} ${trial.cell.task} — ${outcome}\n`);
			},
		});
	} finally {
		process.removeListener("SIGINT", onSigInt);
		process.removeListener("SIGTERM", onSigTerm);
	}

	if (controller.signal.aborted || abortedSignal !== null) {
		const completedCount = record ? record.results.length : 0;
		process.stderr.write(
			`\nRun ${plan.runId} interrupted by ${abortedSignal ?? "signal"} (${completedCount}/${total} trials completed).\n` +
				`To resume this run:\n  evals --suite ${suite.name} --run-id ${plan.runId} --resume\n`,
		);
		return 130;
	}

	process.stdout.write(`\n${summaryTable(summarizeRunCells(record))}\n`);

	const verdict = judgeRunOutcome(record);
	process.stdout.write(
		`\nrun ${record.id}: ${verdict.settled} trial(s), ${verdict.measured} measured, ${verdict.errors} error(s)\n`,
	);
	if (verdict.failure === "no-trial-settled") {
		process.stderr.write(`\nRun ${record.id} settled no trial: there is nothing to report.\n`);
	} else if (verdict.failure === "nothing-measured") {
		process.stderr.write(
			`\nRun ${record.id} produced no measurement: ${verdict.settled} trial(s) settled and none reached a grade.\n`,
		);
	}
	return verdict.exitCode;
}

if (import.meta.main) {
	process.exitCode = await main();
}
