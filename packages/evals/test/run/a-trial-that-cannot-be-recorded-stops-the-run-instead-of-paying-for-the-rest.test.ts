/**
 * WHY THIS SUITE EXISTS.
 *
 * `executeRun` drove its cells through `jobs` workers awaited by `Promise.all`, which rejects on
 * the first failure and leaves every other worker running. `runOne` catches a failed trial and a
 * failed score, so the paths that escaped it were the ones that record the trial: a runs
 * directory that filled up or went read-only mid-run, and a score carrying a value
 * `JSON.stringify` refuses. On any of them the run reported the failure at once and then went on
 * spawning trials in the background — each a container and a provider bill — appending their rows
 * to a handle it had already closed, so the work was paid for and discarded.
 *
 * The class this closes: an error escaping one worker while the pool keeps handing out cells.
 * The failure is now held, every worker stops at its next cell, and the cause is rethrown once
 * nothing is left running. The suite counts the trials the backend was asked for after the
 * rejection has been observed, so a pool that keeps going turns it red.
 *
 * What it does not catch: a backend that ignores `context.signal` and leaves a container running
 * after its own trial was abandoned, which is the backend's cleanup contract rather than the
 * pool's.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { TempDir } from "@veyyon/utils";
import type {
	EvalSuite,
	ExecutionBackend,
	PreflightVerdict,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	Variant,
	VariantAxis,
} from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { executeRun } from "../../src/run/execute";
import { journalPathFor, readRunJournal } from "../../src/run/journal";
import type { RunPlan } from "../../src/run/plan";

registerBuiltinHarnesses();

const VARIANT: Variant = {
	name: "default",
	harness: "veyyon",
	configPath: null,
	promptVariantPath: null,
	model: "anthropic/claude-sonnet-4-6",
	attachments: [],
};

const PROVENANCE: SuiteProvenance = { suite: "recording-probe", version: "1.0.0" };

/** Counts what the pool actually asked for, which is what a leaked worker keeps spending. */
class CountingBackend implements ExecutionBackend {
	readonly id = "in-process" as const;
	readonly appliesVariantAxes: readonly VariantAxis[] = [];
	trials = 0;

	async preflight(): Promise<PreflightVerdict> {
		return { ok: true };
	}

	async prepare(): Promise<void> {}

	async runTrial(cell: TrialCell): Promise<TrialArtifacts> {
		this.trials += 1;
		return { trialDir: null, logPaths: [], rawOutput: `ran ${cell.task}`, filePaths: {}, extra: {} };
	}

	async cleanup(): Promise<void> {}
}

/** A score holding a bigint: `JSON.stringify` throws on it, so the row cannot be journaled. */
function probeSuite(unwritableTasks: readonly string[]): EvalSuite {
	return {
		name: "recording-probe",
		version: "1.0.0",
		displayName: "Recording Probe",
		description: "Suite whose scores can be made unwritable",
		backend: "in-process",
		async discoverTasks() {
			return TASKS;
		},
		async describeTask(id: string): Promise<TaskDescriptor> {
			return { id, path: null, timeBudgetSec: 30, instructionPath: null, metadata: {} };
		},
		async provenance(): Promise<SuiteProvenance> {
			return PROVENANCE;
		},
		async scoreTrial(cell: TrialCell): Promise<TrialScore> {
			return {
				reward: 1,
				partial: 1,
				error: null,
				usage: null,
				extra: unwritableTasks.includes(cell.task) ? { billed: BigInt(7) } : {},
			};
		},
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
	};
}

const TASKS: readonly string[] = Array.from({ length: 12 }, (_, index) => `task-${index}`);

/** The cell the first worker takes, so the pool has eleven more it must not spend. */
const FIRST_TASK = "task-0";

async function planFor(suite: EvalSuite, runId: string, workDir: string): Promise<RunPlan> {
	const tasks = await Promise.all(TASKS.map(id => suite.describeTask(id, { workDir })));
	return {
		runId,
		suite,
		variants: [VARIANT],
		tasks,
		repeats: 1,
		cells: tasks.map(task => ({ suite: suite.name, variant: VARIANT.name, task: task.id, repeat: 0 })),
		provenance: PROVENANCE,
		context: { workDir, options: {} },
	};
}

const JOBS = 4;

async function runProbe(unwritableTasks: readonly string[]): Promise<{
	backend: CountingBackend;
	temp: TempDir;
	runsDir: string;
	error: unknown;
	trialsAtRejection: number;
	trialsAfterSettling: number;
}> {
	const temp = await TempDir.create("@evals-test-record-failure-");
	const runsDir = temp.join("runs");
	await fs.mkdir(runsDir, { recursive: true });
	const suite = probeSuite(unwritableTasks);
	const backend = new CountingBackend();
	const plan = await planFor(suite, "record-failure-run", temp.absolute());

	let error: unknown = null;
	try {
		await executeRun({ plan, backend, runsDir, workDir: temp.absolute(), jobs: JOBS });
	} catch (cause) {
		error = cause;
	}
	const trialsAtRejection = backend.trials;
	// A pool that kept its workers would run the remaining cells right after the rejection.
	await delay(75);
	return { backend, temp, runsDir, error, trialsAtRejection, trialsAfterSettling: backend.trials };
}

describe("a trial whose row cannot be written", () => {
	it("stops the pool instead of spending the rest of the plan", async () => {
		const probe = await runProbe([FIRST_TASK]);
		try {
			expect(probe.error).toBeInstanceOf(TypeError);
			// Each of the four workers is already inside its own trial when the first row fails.
			expect(probe.trialsAtRejection).toBeLessThanOrEqual(JOBS);
			expect(probe.trialsAtRejection).toBeGreaterThan(0);
			// Nothing runs after the caller has seen the failure.
			expect(probe.trialsAfterSettling).toBe(probe.trialsAtRejection);
			expect(probe.trialsAfterSettling).toBeLessThan(TASKS.length);
		} finally {
			await probe.temp.remove();
		}
	});

	it("records the rows it could write and never the one it could not", async () => {
		const probe = await runProbe([FIRST_TASK]);
		try {
			const records = await readRunJournal(probe.runsDir, "record-failure-run");
			expect(records.length).toBeLessThan(TASKS.length);
			expect(records.map(record => record.cell.task)).not.toContain(FIRST_TASK);
			// One header line plus one line per row that was written, and nothing torn.
			const written = await fs.readFile(journalPathFor(probe.runsDir, "record-failure-run"), "utf-8");
			expect(written.trim().split("\n")).toHaveLength(records.length + 1);
		} finally {
			await probe.temp.remove();
		}
	});

	it("runs and records every cell when the rows are writable, so the guard costs nothing", async () => {
		const probe = await runProbe([]);
		try {
			expect(probe.error).toBeNull();
			expect(probe.trialsAtRejection).toBe(TASKS.length);
			const records = await readRunJournal(probe.runsDir, "record-failure-run");
			expect(records).toHaveLength(TASKS.length);
			expect(new Set(records.map(record => record.cell.task)).size).toBe(TASKS.length);
		} finally {
			await probe.temp.remove();
		}
	});

	it("reports the run's own record when nothing failed", async () => {
		const temp = await TempDir.create("@evals-test-record-ok-");
		try {
			const runsDir = temp.join("runs");
			await fs.mkdir(runsDir, { recursive: true });
			const suite = probeSuite([]);
			const backend = new CountingBackend();
			const plan = await planFor(suite, "record-ok-run", temp.absolute());
			const record = await executeRun({
				plan,
				backend,
				runsDir,
				workDir: temp.absolute(),
				jobs: JOBS,
			});
			expect(record.results).toHaveLength(TASKS.length);
			expect(record.results.every(result => result.score.error === null)).toBe(true);
		} finally {
			await temp.remove();
		}
	});
});
