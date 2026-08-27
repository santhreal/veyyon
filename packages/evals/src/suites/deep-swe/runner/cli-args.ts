/**
 * CLI argument parsing and help definitions for the DeepSWE bench runner.
 */

import { flagCount, parseFlags } from "../../../core/flags";

export interface BenchCliArgs {
	tasksFile?: string;
	tasksRoot?: string;
	arms?: string[];
	model?: string;
	limit?: number;
	repeats?: number;
	jobs?: number;
	outDir?: string;
	runDir?: string;
	mergeDirs?: string[];
	reaggregate?: boolean;
	dryRun?: boolean;
	trialTimeout?: string;
	help?: boolean;
	list?: boolean;
	comparisonSystems?: string[];
	raw: Record<string, string>;
}

/**
 * Flags that take no value. `--dry-run tasks/smoke.txt` must leave the path
 * alone rather than swallowing it, and the registry is what the invariant suite
 * sweeps, so a new valueless flag is covered the moment it is declared here.
 */
export const VALUELESS_FLAGS = {
	"dry-run": true,
	help: true,
	list: true,
	"system-comparison": true,
} as const satisfies Record<string, true>;

/**
 * Flags that take a value. The harness adapters contribute their own on top of these, so
 * `--omp-binary` is accepted where the omp adapter is registered and nowhere else.
 */
export const VALUED_FLAGS = {
	tasks: true,
	"tasks-root": true,
	arms: true,
	model: true,
	limit: true,
	repeats: true,
	jobs: true,
	out: true,
	"run-dir": true,
	reaggregate: true,
	merge: true,
	"trial-timeout": true,
	systems: true,
	binary: true,
	"replay-root": true,
} as const satisfies Record<string, true>;

/** Short spellings the runner accepts, mapped onto the long key. */
const ALIASES = { h: "help" } as const satisfies Record<string, string>;

export function parseArgs(argv: string[], harnessFlags: readonly string[] = []): Record<string, string> {
	return parseFlags(argv, {
		valued: VALUED_FLAGS,
		valueless: VALUELESS_FLAGS,
		aliases: ALIASES,
		extraValued: harnessFlags,
	});
}

export function parseBenchCliArgs(argv: string[], harnessFlags: readonly string[] = []): BenchCliArgs {
	const raw = parseArgs(argv, harnessFlags);
	return {
		tasksFile: raw.tasks,
		tasksRoot: raw["tasks-root"],
		arms: raw.arms
			? raw.arms
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: undefined,
		model: raw.model,
		// Counts go through the grammar rather than `Number(...)`: `--limit abc` used to read as
		// NaN, which compares false against the task count and ran the whole list while the flag
		// said otherwise; `--repeats 0` queued no trial; `--jobs abc` sized the worker pool NaN.
		limit: flagCount(raw, "limit"),
		repeats: flagCount(raw, "repeats"),
		jobs: flagCount(raw, "jobs"),
		outDir: raw.out,
		runDir: raw["run-dir"] || raw.reaggregate,
		mergeDirs: raw.merge
			? raw.merge
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: undefined,
		reaggregate: Boolean(raw.reaggregate || raw["run-dir"]),
		dryRun: raw["dry-run"] === "true" || raw["dry-run"] === "",
		trialTimeout: raw["trial-timeout"],
		help: raw.help !== undefined,
		list: raw.list === "true" || raw.list === "",
		comparisonSystems: raw.systems
			? raw.systems
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: undefined,
		raw,
	};
}

export function printHelp(): void {
	console.log(`
DeepSWE Bench Runner — Evaluation and comparison harness for coding agents.

Usage:
  bun src/suites/deep-swe/run.ts --list                          List available arms, systems, and task sets
  bun src/suites/deep-swe/run.ts --tasks tasks/smoke.txt --arms baseline --dry-run
  bun src/suites/deep-swe/run.ts --tasks tasks/pilot-10.txt --arms baseline,candidate-bash-trim
  bun src/suites/deep-swe/run.ts --tasks tasks/pilot-10.txt --arms baseline,omp --model opencode/deepseek-ai/DeepSeek-V3.2
  bun src/suites/deep-swe/run.ts --arms veyyon,omp --model opencode/deepseek-ai/DeepSeek-V3.2
  bun src/suites/deep-swe/run.ts --reaggregate runs/<run-name>
  bun src/suites/deep-swe/run.ts --merge runs/run1,runs/run2 --out runs/merged

Options:
  --list                    List available arms, systems, and task sets, then exit
  --tasks <path>            Path to task list file (e.g. tasks/smoke.txt, tasks/pilot-10.txt)
  --tasks-root <path>       Root directory containing DeepSWE task definitions
  --arms <list>             Comma-separated arms: config arms (baseline,decode,full) and/or
                            system adapters (veyyon,omp,factory,hermes) in any combination
  --model <name>            Model ID or provider routing target (e.g. opencode/deepseek-ai/DeepSeek-V3.2)
  --limit <n>               Maximum number of tasks to run (evenly selected across task list)
  --repeats <n>             Number of repeated samples per (arm, task) cell (default: 1)
  --jobs <n>                Number of concurrent trial jobs to run (default: 2)
  --out <dir>               Custom output directory for run artifacts
  --reaggregate <dir>       Recompute aggregations and regenerate report for an existing run
  --merge <dirs>            Merge multiple runs into a pooled report
  --trial-timeout <sec>     Override per-trial timeout in seconds
  --systems <list>          Legacy alias for --arms with system adapter names
  --system-comparison       Legacy: shorthand for --arms with all registered systems
  --dry-run                 Validate preflight, stage configs, and print plan without executing
  --help, -h                Show this help message
`);
}
