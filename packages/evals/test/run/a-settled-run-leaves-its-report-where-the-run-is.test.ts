/**
 * WHY THIS SUITE EXISTS. A run through `src/cli.ts` persisted one file: `trials.jsonl`. The
 * summary table went to stdout and nothing else was written, so a finished run left no
 * machine-readable record of itself and no report. Every later reader expects one:
 * `mergeIntoReport` refuses a directory without `results.json`, the manager's benchmark
 * snapshot reads `results.json`, and an operator reading a run in the morning has only the
 * terminal scrollback that ended with the process. Recovering a report meant knowing to call
 * `reaggregate` by hand on a path the run never printed.
 *
 * THE CLASS THIS CLOSES: a settled run whose own directory does not state what it measured.
 * Two things are asserted for every suite, present or future. `run.json` is suite-agnostic and
 * unconditional: it holds the record `executeRun` returns, so a run is readable without the
 * suite that produced it. The suite's own renderer is optional, and the sweep pins the suites
 * that decline one by exact equality, so a fourth suite turns this file red until someone
 * records the decision.
 *
 * A renderer runs after the rows are safe on disk and cannot take the run down with it: a
 * throwing renderer leaves `run.json`, the journal and the returned record intact, because a
 * report is a reading of a run and never a condition of it.
 *
 * WHAT IT DOES NOT CATCH: whether deep-swe's rendered numbers are right. That is the
 * aggregation's own contract, covered by the aggregate suites; here the assertion is that the
 * file exists, names the model the run used rather than "unknown", and carries the rows the
 * artifacts hold.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import type {
	EvalSuite,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	SuiteContext,
	SuiteProvenance,
	SuiteReportContext,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
} from "../../engine/contracts";
import { executeRun } from "../../engine/execute-run";
import { harnesses, suites } from "../../engine/loaded-members";
import { readRunJournal } from "../../engine/run-journal";
import { runDirFor } from "../../engine/run-layout";
import type { RunPlan } from "../../engine/run-plan";
import { buildRunPlan } from "../../engine/run-plan";
import { deepSweSuite } from "../../suites/deep-swe/main";

const selection = { harnesses: ["veyyon"], models: ["vendor/model-a"] } as const;

interface ProbeSuiteOptions {
	readonly writeRunReport?: (context: SuiteReportContext) => void;
}

function probeSuite(options: ProbeSuiteOptions = {}): EvalSuite {
	const suite: EvalSuite = {
		id: "probe",
		version: "1.0.0",
		displayName: "Probe",
		description: "A suite that exists to exercise what a settled run writes.",
		backend: "in-process",
		async discoverTasks(_context: SuiteContext): Promise<readonly string[]> {
			return ["task-one", "task-two"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: `/tasks/${taskId}`, timeBudgetSec: 60, instructionPath: null, metadata: {} };
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "probe", version: "1.0.0", sha: "deadbeef" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
		...(options.writeRunReport ? { writeRunReport: options.writeRunReport } : {}),
	};
	return suite;
}

function planFor(suite: EvalSuite, runId: string): Promise<RunPlan> {
	return buildRunPlan({ suite, selection, harnesses, runId });
}

const backend: ExecutionBackend = {
	id: "in-process",
	appliesVariantAxes: [],
	async preflight(): Promise<PreflightVerdict> {
		return { ok: true };
	},
	async prepare(_context: RunContext): Promise<void> {},
	async runTrial(cell: TrialCell): Promise<TrialArtifacts> {
		return { trialDir: `/runs/${cell.task}` };
	},
	async cleanup(): Promise<void> {},
};

describe("what a settled run leaves behind", () => {
	let temp: TempDir;
	let workDir: string;
	let runsDir: string;

	beforeEach(async () => {
		temp = await TempDir.create("run-report-");
		workDir = path.join(temp.path(), "work");
		runsDir = path.join(temp.path(), "runs");
		await fs.mkdir(workDir, { recursive: true });
	});

	afterEach(async () => {
		await temp.remove();
	});

	it("writes the run record into the run's own directory, whatever the suite", async () => {
		const plan = await planFor(probeSuite(), "record-run");
		const record = await executeRun({ plan, harnesses, backend, workDir, runsDir, jobs: 1 });

		const runDir = runDirFor(runsDir, "record-run");
		const written = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8")) as {
			id: string;
			suite: { name: string };
			tasks: string[];
			repeats: number;
			completedAt: string | null;
			results: { cell: { task: string; variant: string } }[];
		};

		expect(written.id).toBe("record-run");
		expect(written.suite.name).toBe("probe");
		expect(written.tasks).toEqual(["task-one", "task-two"]);
		expect(written.repeats).toBe(1);
		expect(written.completedAt).toBe(record.completedAt ?? null);
		expect(written.results.map(row => row.cell.task).sort()).toEqual(["task-one", "task-two"]);
		// The journal stays the row-by-row log; run.json is the settled run.
		expect(written.results).toHaveLength((await readRunJournal(runsDir, "record-run")).length);
	});

	it("hands a suite's renderer the run directory, the model and the tasks", async () => {
		const seen: SuiteReportContext[] = [];
		const plan = await planFor(
			probeSuite({
				writeRunReport(context: SuiteReportContext): void {
					seen.push(context);
					fsSync.writeFileSync(path.join(context.runDir, "report.md"), `# ${context.model}\n`);
				},
			}),
			"render-run",
		);
		await executeRun({ plan, harnesses, backend, workDir, runsDir, jobs: 1 });

		const runDir = runDirFor(runsDir, "render-run");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.runDir).toBe(runDir);
		expect(seen[0]?.model).toBe("vendor/model-a");
		expect(seen[0]?.tasks).toEqual(["task-one", "task-two"]);
		expect(seen[0]?.repeats).toBe(1);
		expect(await fs.readFile(path.join(runDir, "report.md"), "utf8")).toBe("# vendor/model-a\n");
	});

	it("keeps the run when a renderer throws, and writes the record first", async () => {
		const failures: string[] = [];
		const recordVisibleToRenderer: boolean[] = [];
		const plan = await planFor(
			probeSuite({
				writeRunReport(context: SuiteReportContext): void {
					// The order is the contract: a renderer reads a run whose rows are already on
					// disk, so a renderer that dies takes nothing with it.
					recordVisibleToRenderer.push(fsSync.existsSync(path.join(context.runDir, "run.json")));
					throw new Error("renderer exploded");
				},
			}),
			"throwing-run",
		);

		const record = await executeRun({
			plan,
			harnesses,
			backend,
			workDir,
			runsDir,
			jobs: 1,
			onReportFailure: (reason: string) => failures.push(reason),
		});

		expect(record.results).toHaveLength(2);
		expect(recordVisibleToRenderer).toEqual([true]);
		expect(failures).toEqual(["renderer exploded"]);
		const runDir = runDirFor(runsDir, "throwing-run");
		const written = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8")) as {
			results: unknown[];
		};
		expect(written.results).toHaveLength(2);
		expect(fsSync.existsSync(path.join(runDir, "report.md"))).toBe(false);
	});

	it("rewrites the record when a resumed run adds rows", async () => {
		const plan = await planFor(probeSuite(), "resumed-run");
		await executeRun({ plan, harnesses, backend, workDir, runsDir, jobs: 1 });
		const runDir = runDirFor(runsDir, "resumed-run");
		await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({ id: "stale", results: [] }));

		const resumed = await executeRun({ plan, harnesses, backend, workDir, runsDir, jobs: 1, resume: true });

		const written = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8")) as {
			id: string;
			results: unknown[];
		};
		expect(written.id).toBe("resumed-run");
		expect(written.results).toHaveLength(resumed.results.length);
		expect(written.results).toHaveLength(2);
	});
});

describe("every registered suite", () => {
	it("either renders its own report or is a recorded exception", () => {
		const allSuites = suites.list();
		expect(allSuites.length).toBeGreaterThanOrEqual(3);

		const declining = allSuites
			.filter(suite => typeof suite.writeRunReport !== "function")
			.map(suite => suite.id)
			.sort();

		// Pinned by exact equality: a new suite lands in this list and turns the file red until
		// someone decides whether it renders a report. terminal-bench and typescript-edit read
		// their rows from run.json and render nothing of their own.
		expect(declining).toEqual(["terminal-bench", "typescript-edit"]);
		expect(typeof deepSweSuite.writeRunReport).toBe("function");
	});
});

describe("the deep-swe renderer", () => {
	let temp: TempDir;

	beforeEach(async () => {
		temp = await TempDir.create("deep-swe-report-");
	});

	afterEach(async () => {
		await temp.remove();
	});

	/**
	 * Pier's own layout and its own `result.json`: a job directory holding one trial
	 * directory, the rewards under `verifier_result.rewards`, the token counts under
	 * `agent_result`. The parser reads those keys, so a fixture that invents a shape proves
	 * nothing about a real run.
	 */
	async function stageTrial(runDir: string, jobName: string, task: string, reward: number): Promise<void> {
		await fs.mkdir(path.join(runDir, "configs"), { recursive: true });
		await fs.writeFile(path.join(runDir, "configs", `${jobName}.yaml`), "agent:\n  name: veyyon\n");
		const trialDir = path.join(runDir, "jobs", jobName, `${task}__ABCDEFG`);
		await fs.mkdir(trialDir, { recursive: true });
		await fs.writeFile(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				trial_name: `${task}__ABCDEFG`,
				exception_info: null,
				agent_result: {
					n_input_tokens: 1000,
					n_output_tokens: 200,
					n_cache_tokens: 0,
					n_agent_steps: 4,
					cost_usd: 0,
					metadata: {},
				},
				verifier_result: {
					rewards: {
						reward,
						f2p_total: 4,
						f2p_passed: reward === 1 ? 4 : 0,
						p2p_total: 1,
						p2p_passed: 1,
						f2p: reward === 1 ? 1 : 0,
						p2p: 1,
						partial: reward === 1 ? 1 : 0.25,
					},
				},
			}),
		);
	}

	it("writes results.json and report.md naming the model the run used", async () => {
		const runDir = path.join(temp.path(), "run-1");
		await stageTrial(runDir, "run-1__baseline__task-one__r1", "task-one", 1);

		deepSweSuite.writeRunReport?.({
			runDir,
			model: "lm-studio/local-27b",
			tasks: ["task-one"],
			repeats: 1,
		});

		const results = JSON.parse(await fs.readFile(path.join(runDir, "results.json"), "utf8")) as {
			model: string;
			repeats: number;
			results: { task: string; reward: number | null; outputTokens: number | null }[];
		};
		expect(results.model).toBe("lm-studio/local-27b");
		expect(results.results).toHaveLength(1);
		expect(results.results[0]?.task).toBe("task-one");
		expect(results.results[0]?.reward).toBe(1);
		expect(results.results[0]?.outputTokens).toBe(200);
		// A modular job name carries `__r1`, and deriving the count from it reported two
		// repeats for a run that planned one.
		expect(results.repeats).toBe(1);

		const report = await fs.readFile(path.join(runDir, "report.md"), "utf8");
		expect(report).toContain("lm-studio/local-27b");
	});

	it("keeps a prior aggregation's model over the caller's default", async () => {
		const runDir = path.join(temp.path(), "run-2");
		await stageTrial(runDir, "run-2__baseline__task-one__r1", "task-one", 0);
		await fs.writeFile(
			path.join(runDir, "results.json"),
			JSON.stringify({ model: "vendor/recorded-model", results: [] }),
		);

		// A renderer that does not exist would leave the seeded file untouched and pass this
		// case for the wrong reason, so the hook is asserted before it is called.
		expect(typeof deepSweSuite.writeRunReport).toBe("function");
		deepSweSuite.writeRunReport?.({ runDir, model: "vendor/other-model", tasks: ["task-one"], repeats: 1 });

		const results = JSON.parse(await fs.readFile(path.join(runDir, "results.json"), "utf8")) as {
			model: string;
			results: unknown[];
		};
		// A reaggregation states what the run recorded; the caller's model is a default for a
		// directory that has never been aggregated, never an overwrite of the run's own fact.
		expect(results.model).toBe("vendor/recorded-model");
		// The seeded file held no rows, so the artifacts are what produced the row below: a
		// reaggregation that only echoed the prior file would leave this empty.
		expect(results.results).toHaveLength(1);
	});

	it("labels a modular run's rows by variant and task, not by run id", async () => {
		// `trialJobName` files a trial as `<run>__<variant>__<task>__r<n>`, and the legacy
		// three-part parse read the run id as the arm and `<variant>__<task>` as the task, so
		// every row of every modular run carried a task name no task list contains.
		const runDir = path.join(temp.path(), "overnight-veyyon-normal");
		await stageTrial(runDir, "overnight-veyyon-normal__baseline__ytt-jsonpath-query-api__r1", "ytt", 0);

		deepSweSuite.writeRunReport?.({ runDir, model: "vendor/m", tasks: ["ytt-jsonpath-query-api"], repeats: 1 });

		const results = JSON.parse(await fs.readFile(path.join(runDir, "results.json"), "utf8")) as {
			arms: string[];
			results: { arm: string; task: string; repeat: number }[];
		};
		expect(results.results[0]?.arm).toBe("baseline");
		expect(results.results[0]?.task).toBe("ytt-jsonpath-query-api");
		expect(results.results[0]?.repeat).toBe(1);
		expect(results.arms).toEqual(["baseline"]);
	});

	it("still reads a legacy job name that carries no run id", async () => {
		// The deep-swe executor's own runs file a trial as `<arm>__<task>__r<n>` under a
		// timestamped directory, and those directories are still read by --reaggregate.
		const runDir = path.join(temp.path(), "2026-01-01T00-00-00-000");
		await stageTrial(runDir, "unified__ts-pattern-match-each__r1", "tsp", 1);

		deepSweSuite.writeRunReport?.({ runDir, model: "vendor/m", tasks: ["ts-pattern-match-each"], repeats: 1 });

		const results = JSON.parse(await fs.readFile(path.join(runDir, "results.json"), "utf8")) as {
			results: { arm: string; task: string; reward: number | null }[];
		};
		expect(results.results[0]?.arm).toBe("unified");
		expect(results.results[0]?.task).toBe("ts-pattern-match-each");
		expect(results.results[0]?.reward).toBe(1);
	});
});
