/**
 * WHY: a cancelled run (SIGINT or SIGTERM through `runUnderSignals`) settles before the process
 * exits, so every trial in flight ends by throwing its backend's abort. The engine scored each of
 * those throws as an error row and journaled it. A resume treats every journaled cell as settled, so
 * `evals --resume`, the command the interruption note prints, skipped the cells the cancel had cut
 * short: with `--jobs 8`, eight tasks were lost from the run for good and reported as errors.
 *
 * THE CLASS: a trial that measured nothing because the run was cancelled being recorded as a
 * settled outcome. The cases cancel a run from inside a trial, the way a signal lands mid-trial, and
 * assert the trial gets no row in the journal or the record, that a resume of the same run id runs
 * it, and that a trial which finished and was scored before the cancel is kept and not run again.
 *
 * Not caught: a backend that returns artifacts for a cancelled trial instead of throwing, which the
 * suite then grades. Every backend in this package throws on its run's cancellation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import type {
	EvalSuite,
	ExecutionBackend,
	PreflightVerdict,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
} from "../../engine/contracts";
import { harnesses } from "../../engine/members/loaded";
import { buildRunPlan, type RunPlan } from "../../engine/plan/run-plan";
import { executeRun } from "../../engine/run/execute";
import { readRunJournal } from "../../engine/run/journal";

function planTasks(tasks: readonly string[]): Promise<RunPlan> {
	const suite: EvalSuite = {
		id: "cancel-probe",
		version: "1.0.0",
		displayName: "Cancel probe",
		description: "A suite that exists to be cancelled mid-run.",
		backend: "in-process",
		async discoverTasks(): Promise<readonly string[]> {
			return tasks;
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: null, timeBudgetSec: 60, instructionPath: null, metadata: {} };
		},
		async provenance() {
			return { suite: "cancel-probe", version: "1.0.0", sha: "deadbeef" };
		},
		async scoreTrial(): Promise<TrialScore> {
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
	};
	return buildRunPlan({
		suite,
		selection: { harnesses: ["veyyon"], models: ["vendor/model-a"] },
		harnesses,
		runId: "cancelled-run",
	});
}

/** A backend that runs each cell through `run`, recording the task of every trial it started. */
function backendRunning(run: (cell: TrialCell) => Promise<TrialArtifacts>): {
	readonly backend: ExecutionBackend;
	readonly started: string[];
} {
	const started: string[] = [];
	return {
		started,
		backend: {
			id: "in-process",
			appliesVariantAxes: [],
			async preflight(): Promise<PreflightVerdict> {
				return { ok: true };
			},
			async prepare(): Promise<void> {},
			async runTrial(cell: TrialCell): Promise<TrialArtifacts> {
				started.push(cell.task);
				return await run(cell);
			},
			async cleanup(): Promise<void> {},
		},
	};
}

describe("a trial the run's cancellation cut short", () => {
	let temp: TempDir;
	let workDir: string;
	let runsDir: string;

	beforeEach(async () => {
		temp = await TempDir.create("evals-cancelled-trial-");
		workDir = temp.join("work");
		runsDir = temp.join("runs");
		await fs.mkdir(workDir, { recursive: true });
		await fs.mkdir(runsDir, { recursive: true });
	});

	afterEach(async () => {
		await temp.remove();
	});

	it("gets no row, and a resume of the run runs it", async () => {
		const plan = await planTasks(["finished", "cut-short", "never-started"]);
		const controller = new AbortController();
		const first = backendRunning(async cell => {
			if (cell.task === "finished") return { trialDir: "/runs/finished" };
			// The signal lands while the agent runs; the backend ends it and says so.
			controller.abort();
			throw new Error("Trial aborted: pier execution cancelled");
		});

		const interrupted = await executeRun({
			plan,
			harnesses,
			backend: first.backend,
			workDir,
			runsDir,
			signal: controller.signal,
		});

		expect(first.started).toEqual(["finished", "cut-short"]);
		expect(interrupted.results.map(row => row.cell.task)).toEqual(["finished"]);
		expect((await readRunJournal(runsDir, plan.runId)).map(row => row.cell.task)).toEqual(["finished"]);

		const second = backendRunning(async cell => ({ trialDir: `/runs/${cell.task}` }));
		const resumed = await executeRun({
			plan,
			harnesses,
			backend: second.backend,
			workDir,
			runsDir,
			resume: true,
		});

		expect(second.started).toEqual(["cut-short", "never-started"]);
		expect(resumed.results.map(row => [row.cell.task, row.score.reward])).toEqual([
			["finished", 1],
			["cut-short", 1],
			["never-started", 1],
		]);
		expect((await readRunJournal(runsDir, plan.runId)).map(row => row.cell.task)).toEqual([
			"finished",
			"cut-short",
			"never-started",
		]);
	});

	it("gets no row when its scoring is what the cancel interrupted", async () => {
		const controller = new AbortController();
		const plan = await planTasks(["scored-after-cancel"]);
		const scoring: EvalSuite = {
			...plan.suite,
			async scoreTrial(): Promise<TrialScore> {
				controller.abort();
				throw new Error("the grader was stopped by the run's cancellation");
			},
		};
		const probe = backendRunning(async () => ({ trialDir: "/runs/scored" }));

		const record = await executeRun({
			plan: { ...plan, suite: scoring },
			harnesses,
			backend: probe.backend,
			workDir,
			runsDir,
			signal: controller.signal,
		});

		expect(record.results).toEqual([]);
		expect(await readRunJournal(runsDir, plan.runId)).toEqual([]);
	});
});
