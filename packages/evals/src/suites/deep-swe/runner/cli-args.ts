/**
 * CLI argument parsing and help definitions for the DeepSWE bench runner.
 */

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
export const VALUELESS_FLAGS = { "dry-run": true, list: true } as const satisfies Record<string, true>;

export function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") {
			out.help = "true";
			continue;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) {
				out[arg.slice(2, eq)] = arg.slice(eq + 1);
				continue;
			}
			const name = arg.slice(2);
			if (Object.hasOwn(VALUELESS_FLAGS, name)) {
				out[name] = "";
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				out[name] = next;
				i++;
			} else {
				out[name] = "true";
			}
		}
	}
	return out;
}

export function parseBenchCliArgs(argv: string[]): BenchCliArgs {
	const raw = parseArgs(argv);
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
		limit: raw.limit ? Number(raw.limit) : undefined,
		repeats: raw.repeats ? Number(raw.repeats) : undefined,
		jobs: raw.jobs ? Number(raw.jobs) : undefined,
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
		help: raw.help === "true",
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
  bun run.ts --list                          List available arms, systems, and task sets
  bun run.ts --tasks tasks/smoke.txt --arms baseline --dry-run
  bun run.ts --tasks tasks/pilot-10.txt --arms baseline,candidate-bash-trim
  bun run.ts --tasks tasks/pilot-10.txt --arms baseline,omp --model opencode/deepseek-ai/DeepSeek-V3.2
  bun run.ts --arms veyyon,omp --model opencode/deepseek-ai/DeepSeek-V3.2
  bun run.ts --reaggregate runs/<run-name>
  bun run.ts --merge runs/run1,runs/run2 --out runs/merged

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
