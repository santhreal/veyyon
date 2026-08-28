/**
 * WHY THIS SUITE EXISTS. Every eval suite in this package used to own its own loop:
 * its own queue order, its own worker pool, its own "a trial threw" branch, its own
 * cleanup. Three copies meant three answers to the same questions, and two of them
 * were wrong in ways nothing caught — a thrown trial scored as reward 0, so a broken
 * container and a genuinely failing agent produced the same row, and results were
 * recorded in completion order, so two runs of one plan could not be diffed cell by
 * cell.
 *
 * THE CLASS THIS CLOSES: a suite-specific execution rule. `src/run/plan.ts` decides
 * the cells and `src/run/execute.ts` runs them for EVERY suite, so these assertions
 * hold for a suite that does not exist yet. The plan is asserted to be task-major
 * with variants innermost (what a paired-wave scheduler needs), the pool is asserted
 * to respect its bound and to terminate, a throw is asserted to stay distinguishable
 * from a real zero, and cleanup is asserted to run for a cell whose trial threw.
 *
 * Completion order is forced with promise gates rather than sleeps, so no assertion
 * here depends on wall-clock timing.
 *
 * WHAT IT DOES NOT CATCH: whether a particular backend really starts a container, and
 * whether a particular suite's reward parsing is right. Those are proved by the real
 * trials in each backend's and each suite's own tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import type {
	EvalSuite,
	ExecutionBackend,
	HarnessAdapter,
	PreflightVerdict,
	RunContext,
	SuiteContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
} from "../../engine/contracts";
import type { ExecuteRunOptions } from "../../engine/execute-run";
import {
	BackendPreflightError,
	executeRun as baseExecuteRun,
	HarnessPreflightError,
	InvalidConcurrencyError,
	SuitePreflightError,
} from "../../engine/execute-run";
import { harnesses as loadedHarnesses } from "../../engine/loaded-members";
import { MemberNotFoundError, Registry } from "../../engine/member-registry";
import { journalPathFor, readRunJournal } from "../../engine/run-journal";
import type { RunPlan, RunPlanRequest } from "../../engine/run-plan";
import {
	buildRunPlan,
	describeRunPlan,
	EmptyTaskSelectionError,
	InvalidRepeatsError,
	UnboundHarnessBackendError,
	UnknownTaskError,
} from "../../engine/run-plan";
import { summarizeRunCells } from "../../engine/run-record";

// The plan resolves each variant's harness before it expands a single cell, so every
// call here needs a registry holding the real builtin adapters. This file owns its own
// registry rather than reading the process-wide default: the default is populated by
// whichever module happened to import the harness barrel first, which makes a plan
// assertion pass or fail on test-file grouping.
const harnesses = new Registry<HarnessAdapter>("harness");
for (const h of loadedHarnesses.list()) {
	harnesses.register(h);
}

function planRun(request: Omit<RunPlanRequest, "harnesses">): Promise<RunPlan> {
	return buildRunPlan({ ...request, harnesses });
}

function executeRun(options: Omit<ExecuteRunOptions, "harnesses">) {
	return baseExecuteRun({ ...options, harnesses });
}

interface ProbeSuiteOptions {
	readonly tasks?: readonly string[];
	readonly preflight?: PreflightVerdict;
	readonly score?: (cell: TrialCell, artifacts: TrialArtifacts) => TrialScore;
}

function probeSuite(options: ProbeSuiteOptions = {}): EvalSuite {
	const tasks = options.tasks ?? ["task-a", "task-b"];
	return {
		id: "probe",
		version: "1.0.0",
		displayName: "Probe",
		description: "A suite that exists to exercise the engine.",
		backend: "in-process",
		async discoverTasks(_context: SuiteContext): Promise<readonly string[]> {
			return tasks;
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return { id: taskId, path: `/tasks/${taskId}`, timeBudgetSec: 60, instructionPath: null, metadata: {} };
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "probe", version: "1.0.0", sha: "deadbeef" };
		},
		async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
			if (options.score) return options.score(cell, artifacts);
			return { reward: 1, partial: null, error: null, usage: null, extra: {} };
		},
		async preflight(): Promise<PreflightVerdict> {
			return options.preflight ?? { ok: true };
		},
	};
}

interface ProbeBackendOptions {
	readonly preflight?: PreflightVerdict;
	readonly onRun?: (cell: TrialCell) => Promise<TrialArtifacts>;
}

interface ProbeBackend {
	readonly backend: ExecutionBackend;
	readonly cleaned: string[];
	readonly prepared: string[];
	/** Highest number of trials the engine held in flight at once. */
	readonly counts: { peak: number; started: number };
}

function probeBackend(options: ProbeBackendOptions = {}): ProbeBackend {
	const cleaned: string[] = [];
	const prepared: string[] = [];
	const counts = { peak: 0, started: 0 };
	let inFlight = 0;

	const backend: ExecutionBackend = {
		id: "in-process",
		// The plans here vary a config and a prompt overlay, and a backend that declared
		// neither would be refused before `executeRun` reached what these cases assert.
		appliesVariantAxes: ["config", "promptVariant"],
		async preflight(): Promise<PreflightVerdict> {
			return options.preflight ?? { ok: true };
		},
		async prepare(context: RunContext): Promise<void> {
			prepared.push(context.runId);
		},
		async runTrial(cell: TrialCell): Promise<TrialArtifacts> {
			inFlight += 1;
			counts.started += 1;
			counts.peak = Math.max(counts.peak, inFlight);
			try {
				// One microtask boundary, so a bounded pool's workers all enter before any
				// of them settles. Deterministic: no clock involved.
				await Promise.resolve();
				if (options.onRun) return await options.onRun(cell);
				return { trialDir: `/runs/${cell.task}-${cell.variant}` };
			} finally {
				inFlight -= 1;
			}
		},
		async cleanup(cell: TrialCell): Promise<void> {
			cleaned.push(`${cell.task}/${cell.variant}/${cell.repeat}`);
		},
	};

	return { backend, cleaned, prepared, counts };
}

const twoVariants = {
	harnesses: ["veyyon"],
	configs: ["baseline", "candidate"],
	models: ["vendor/model-a"],
} as const;

const oneVariant = { harnesses: ["veyyon"], models: ["vendor/model-a"] } as const;

describe("buildRunPlan", () => {
	it("orders cells task-major with variants innermost and repeats outermost", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants, repeats: 2 });

		expect(plan.cells.map(cell => `${cell.repeat}:${cell.task}:${cell.variant}`)).toEqual([
			"1:task-a:baseline",
			"1:task-a:candidate",
			"1:task-b:baseline",
			"1:task-b:candidate",
			"2:task-a:baseline",
			"2:task-a:candidate",
			"2:task-b:baseline",
			"2:task-b:candidate",
		]);
	});

	it("expands one cell per variant × task when repeats defaults to one", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants });

		expect(plan.cells).toHaveLength(plan.variants.length * plan.tasks.length);
		expect(plan.repeats).toBe(1);
	});

	it("describes every requested task, in requested order", async () => {
		const plan = await planRun({
			suite: probeSuite({ tasks: ["a", "b", "c"] }),
			selection: twoVariants,
			tasks: ["c", "a"],
		});

		expect(plan.tasks.map(task => task.id)).toEqual(["c", "a"]);
	});

	it("refuses a requested task the suite does not hold, naming the missing ids", async () => {
		const attempt = planRun({
			suite: probeSuite({ tasks: ["a", "b"] }),
			selection: twoVariants,
			tasks: ["a", "ghost", "phantom"],
		});

		await expect(attempt).rejects.toThrow(UnknownTaskError);
		await expect(attempt).rejects.toThrow(/ghost, phantom/);
	});

	it("refuses a suite that discovers no tasks rather than reporting an empty pass rate", async () => {
		const attempt = planRun({ suite: probeSuite({ tasks: [] }), selection: twoVariants });

		await expect(attempt).rejects.toThrow(EmptyTaskSelectionError);
	});

	it.each([0, -1, 1.5])("refuses repeats=%p", async repeats => {
		const attempt = planRun({ suite: probeSuite(), selection: twoVariants, repeats });

		await expect(attempt).rejects.toThrow(InvalidRepeatsError);
	});

	it("carries the suite's dataset provenance into the plan", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants });

		expect(plan.provenance.sha).toBe("deadbeef");
	});

	it("honours an explicit run id and otherwise generates one naming the suite", async () => {
		const named = await planRun({ suite: probeSuite(), selection: twoVariants, runId: "job-17" });
		const generated = await planRun({
			suite: probeSuite(),
			selection: twoVariants,
			now: () => new Date("2026-01-02T03:04:05.678Z"),
		});

		expect(named.runId).toBe("job-17");
		expect(generated.runId).toBe("probe-2026-01-02T03-04-05-678");
	});

	it("reports the queue size and every axis in its description", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants, repeats: 3 });

		const described = describeRunPlan(plan);

		expect(described).toContain("queue      12 trial(s)");
		expect(described).toContain("variants   2: baseline, candidate");
		expect(described).toContain("models     vendor/model-a");
		expect(described).toContain("repeats    3");
	});
	it("refuses a harness that has no binding for the suite backend, naming harness, suite and backend", async () => {
		const attempt = planRun({
			suite: probeSuite(), // backend: "in-process"
			selection: { harnesses: ["omp"], models: ["vendor/model-a"] }, // omp only binds pier
		});

		await expect(attempt).rejects.toThrow(UnboundHarnessBackendError);
		await expect(attempt).rejects.toThrow(/Harness "omp" has no binding for backend "in-process"/);
		await expect(attempt).rejects.toThrow(/required by suite "probe"/);
	});

	it("refuses a harness no registry holds, naming it and listing the registered ones", async () => {
		const attempt = planRun({
			suite: probeSuite(),
			selection: { harnesses: ["ghost-agent"], models: ["vendor/model-a"] },
		});

		await expect(attempt).rejects.toThrow(MemberNotFoundError);
		await expect(attempt).rejects.toThrow(/No harness named "ghost-agent"/);
		await expect(attempt).rejects.toThrow(/Registered: .*veyyon/);
	});

	it("produces a 2N cell matrix for two harnesses × N tasks in deterministic task-major order", async () => {
		const plan = await planRun({
			suite: {
				...probeSuite({ tasks: ["task-1", "task-2", "task-3"] }),
				backend: "pier", // both veyyon and omp bind pier
			},
			selection: {
				harnesses: ["veyyon", "omp"],
				models: ["vendor/model-a"],
			},
		});

		expect(plan.variants.map(v => v.harness)).toEqual(["veyyon", "omp"]);
		expect(plan.cells).toHaveLength(6);
		expect(plan.cells.map(c => `${c.task}:${c.variant}`)).toEqual([
			"task-1:veyyon",
			"task-1:omp",
			"task-2:veyyon",
			"task-2:omp",
			"task-3:veyyon",
			"task-3:omp",
		]);
	});
});

describe("executeRun", () => {
	let tempDir: TempDir;
	let workDir: string;
	let runsDir: string;

	beforeEach(async () => {
		tempDir = await TempDir.create("@evals-test-plan-execute-");
		workDir = tempDir.join("work");
		runsDir = tempDir.join("runs");
		// `executeRun` refuses a work directory that is not there, which is what an operator
		// naming one gets, so the directory these trials execute in exists here too.
		await fs.mkdir(workDir, { recursive: true });
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("records results in plan order even when trials finish out of order", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants });
		const firstTaskGate = Promise.withResolvers<void>();
		let remainingSecondTask = 2;
		const probe = probeBackend({
			onRun: async cell => {
				// Every task-b cell settles before any task-a cell, inverting completion
				// order against plan order.
				if (cell.task === "task-b") {
					remainingSecondTask -= 1;
					if (remainingSecondTask === 0) firstTaskGate.resolve();
					return { trialDir: `${runsDir}/${cell.task}` };
				}
				await firstTaskGate.promise;
				return { trialDir: `${runsDir}/${cell.task}` };
			},
		});

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			jobs: 4,
		});

		expect(record.results.map(result => `${result.cell.task}:${result.cell.variant}`)).toEqual(
			plan.cells.map(cell => `${cell.task}:${cell.variant}`),
		);
	});

	it.each([1, 2, 3])("holds exactly jobs=%p trials in flight and no more", async jobs => {
		const plan = await planRun({ suite: probeSuite({ tasks: ["a", "b", "c", "d"] }), selection: twoVariants });
		const probe = probeBackend();

		await executeRun({ plan, backend: probe.backend, workDir, runsDir, jobs });

		expect(probe.counts.peak).toBe(jobs);
		expect(probe.counts.started).toBe(plan.cells.length);
	});

	it("prepares the backend exactly once per run", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants });
		const probe = probeBackend();

		await executeRun({ plan, backend: probe.backend, workDir, runsDir, jobs: 2 });

		expect(probe.prepared).toEqual([plan.runId]);
	});

	it("keeps a thrown trial distinguishable from a real reward of zero", async () => {
		const plan = await planRun({
			suite: probeSuite({
				tasks: ["boom", "zero"],
				score: cell => ({
					reward: cell.task === "zero" ? 0 : 1,
					partial: null,
					error: null,
					usage: null,
					extra: {},
				}),
			}),
			selection: oneVariant,
		});
		const probe = probeBackend({
			onRun: async cell => {
				if (cell.task === "boom") throw new Error("container exited 137");
				return {};
			},
		});

		const record = await executeRun({ plan, backend: probe.backend, workDir, runsDir });

		const byTask = new Map(record.results.map(result => [result.cell.task, result.score]));
		expect(byTask.get("boom")?.error).toBe("container exited 137");
		expect(byTask.get("boom")?.reward).toBeNull();
		expect(byTask.get("zero")?.error).toBeNull();
		expect(byTask.get("zero")?.reward).toBe(0);
	});

	it("counts a thrown trial as an error and a zero as a non-pass in the run summary", async () => {
		const plan = await planRun({
			suite: probeSuite({
				tasks: ["boom", "zero", "pass"],
				score: cell => ({
					reward: cell.task === "pass" ? 1 : 0,
					partial: null,
					error: null,
					usage: null,
					extra: {},
				}),
			}),
			selection: oneVariant,
		});
		const probe = probeBackend({
			onRun: async cell => {
				if (cell.task === "boom") throw new Error("no such image");
				return {};
			},
		});

		const record = await executeRun({ plan, backend: probe.backend, workDir, runsDir, sleep: async () => {} });
		const [summary] = summarizeRunCells(record);

		expect(summary.total).toBe(3);
		expect(summary.errors).toBe(1);
		expect(summary.passes).toBe(1);
	});

	it("cleans up after every attempt, including each one whose trial threw", async () => {
		const plan = await planRun({ suite: probeSuite({ tasks: ["ok", "boom"] }), selection: oneVariant });
		const probe = probeBackend({
			onRun: async cell => {
				if (cell.task === "boom") throw new Error("spawn failed");
				return {};
			},
		});

		await executeRun({ plan, backend: probe.backend, workDir, runsDir, sleep: async () => {} });

		// The throwing cell is attempted twice by default, and each attempt cleans up after itself.
		expect(probe.cleaned.sort()).toEqual(["boom/veyyon/1", "boom/veyyon/1", "ok/veyyon/1"]);
	});

	it("keeps a scored trial when cleanup itself throws", async () => {
		const plan = await planRun({ suite: probeSuite({ tasks: ["ok"] }), selection: oneVariant });
		const probe = probeBackend();
		const backend: ExecutionBackend = {
			...probe.backend,
			async cleanup(): Promise<void> {
				throw new Error("docker rm refused");
			},
		};

		const record = await executeRun({ plan, backend, workDir, runsDir });

		expect(record.results).toHaveLength(1);
		expect(record.results[0].score.reward).toBe(1);
	});

	it("refuses to start when the suite's preflight fails, naming what is missing", async () => {
		const plan = await planRun({
			suite: probeSuite({
				preflight: { ok: false, reason: "corpus not acquired", missingRequirements: ["corpus"] },
			}),
			selection: twoVariants,
		});
		const probe = probeBackend();

		const attempt = executeRun({ plan, backend: probe.backend, workDir, runsDir });

		await expect(attempt).rejects.toThrow(SuitePreflightError);
		await expect(attempt).rejects.toThrow(/corpus not acquired.*Missing: corpus/s);
	});

	it("refuses to start when the backend's preflight fails, and runs no trial", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants });
		const probe = probeBackend({
			preflight: { ok: false, reason: "harbor not found on PATH", missingRequirements: ["harbor"] },
		});

		const attempt = executeRun({ plan, backend: probe.backend, workDir, runsDir });

		await expect(attempt).rejects.toThrow(BackendPreflightError);
		expect(probe.prepared).toEqual([]);
		expect(probe.counts.started).toBe(0);
	});

	it.each([0, -2, 2.5])("refuses jobs=%p", async jobs => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants });
		const probe = probeBackend();

		const attempt = executeRun({ plan, backend: probe.backend, workDir, runsDir, jobs });

		await expect(attempt).rejects.toThrow(InvalidConcurrencyError);
	});

	it("terminates on abort and returns only the trials that finished", async () => {
		const plan = await planRun({
			suite: probeSuite({ tasks: ["a", "b", "c", "d", "e", "f"] }),
			selection: oneVariant,
		});
		const controller = new AbortController();
		const probe = probeBackend({
			onRun: async () => {
				controller.abort();
				return {};
			},
		});

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			jobs: 1,
			signal: controller.signal,
		});

		expect(probe.counts.started).toBe(1);
		expect(record.results).toHaveLength(1);
		expect(record.results.length).toBeLessThan(plan.cells.length);
	});

	it("tags the record with the suite identity and dataset sha so two suites cannot merge", async () => {
		const plan = await planRun({ suite: probeSuite(), selection: twoVariants, runId: "job-42" });
		const probe = probeBackend();

		const record = await executeRun({ plan, backend: probe.backend, workDir, runsDir });

		expect(record.id).toBe("job-42");
		expect(record.suite).toEqual({ name: "probe", version: "1.0.0", provenanceSha: "deadbeef" });
		expect(record.tasks).toEqual(["task-a", "task-b"]);
		expect(record.completedAt).not.toBeNull();
	});

	it("reports each settled trial once, in completion order, to a progress callback", async () => {
		const plan = await planRun({ suite: probeSuite({ tasks: ["slow", "fast"] }), selection: oneVariant });
		const slowGate = Promise.withResolvers<void>();
		const probe = probeBackend({
			onRun: async cell => {
				if (cell.task === "fast") {
					slowGate.resolve();
					return {};
				}
				await slowGate.promise;
				return {};
			},
		});
		const seen: string[] = [];

		await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			jobs: 2,
			onTrial: (record, index) => seen.push(`${index}:${record.cell.task}`),
		});

		expect(seen).toEqual(["0:fast", "1:slow"]);
	});

	it("writes an append-only journal line per settled trial before the run returns", async () => {
		const plan = await planRun({
			suite: probeSuite({ tasks: ["t1", "t2"] }),
			selection: twoVariants,
		});
		const probe = probeBackend({
			onRun: async cell => ({
				trialDir: `${runsDir}/${cell.task}`,
				rawOutput: `output for ${cell.task}`,
				extra: { exitCode: 0 },
			}),
		});

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			jobs: 2,
		});

		const journalPath = journalPathFor(runsDir, plan.runId);
		const journalExists = await fs
			.stat(journalPath)
			.then(() => true)
			.catch(() => false);
		expect(journalExists).toBe(true);

		const journalRecords = await readRunJournal(runsDir, plan.runId);
		expect(journalRecords).toHaveLength(plan.cells.length);
		expect(record.results).toHaveLength(plan.cells.length);

		for (let i = 0; i < plan.cells.length; i++) {
			const cell = plan.cells[i];
			expect(cell).toBeDefined();
			const entry = journalRecords.find(
				r => r.cell.task === cell!.task && r.cell.variant === cell!.variant && r.cell.repeat === cell!.repeat,
			);
			expect(entry).toBeDefined();
			expect(entry?.score.reward).toBe(1);
			expect(entry?.artifacts?.trialDir).toBe(`${runsDir}/${cell!.task}`);
			expect(entry?.startedAt).toBeDefined();
			expect(entry?.finishedAt).toBeDefined();
		}
	});

	it("an abort mid-run leaves a journal whose lines are all parseable and whose count equals settled trials", async () => {
		const plan = await planRun({
			suite: probeSuite({ tasks: ["t1", "t2", "t3", "t4", "t5", "t6"] }),
			selection: oneVariant,
		});
		const controller = new AbortController();
		let completed = 0;
		const probe = probeBackend({
			onRun: async () => {
				completed++;
				if (completed === 2) {
					controller.abort();
				}
				return { trialDir: `${runsDir}/trial` };
			},
		});

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			jobs: 1,
			signal: controller.signal,
		});

		expect(record.results).toHaveLength(2);

		const journalRecords = await readRunJournal(runsDir, plan.runId);
		expect(journalRecords).toHaveLength(2);
		expect(journalRecords.every(r => r.cell && r.score && r.finishedAt)).toBe(true);
	});

	it("resumes a prior run with its journal, runs only remaining cells, and merges full record", async () => {
		const plan = await planRun({
			suite: probeSuite({ tasks: ["t1", "t2", "t3", "t4"] }),
			selection: oneVariant,
			runId: "resumable-run-1",
		});

		// First run: aborted after 2 trials settle
		const controller = new AbortController();
		let run1Count = 0;
		const probe1 = probeBackend({
			onRun: async () => {
				run1Count++;
				if (run1Count === 2) {
					controller.abort();
				}
				return { trialDir: `${runsDir}/trial` };
			},
		});

		const initialRecord = await executeRun({
			plan,
			backend: probe1.backend,
			workDir,
			runsDir,
			jobs: 1,
			signal: controller.signal,
		});
		expect(initialRecord.results).toHaveLength(2);

		// Second run: resume the run
		let skippedReported = 0;
		let totalReported = 0;
		const probe2 = probeBackend({
			onRun: async () => ({ trialDir: `${runsDir}/trial-resumed` }),
		});

		const resumedRecord = await executeRun({
			plan,
			backend: probe2.backend,
			workDir,
			runsDir,
			jobs: 2,
			resume: true,
			onSkip: (skipped, total) => {
				skippedReported = skipped;
				totalReported = total;
			},
		});

		// Only remaining 2 trials should be started in probe2
		expect(skippedReported).toBe(2);
		expect(totalReported).toBe(4);
		expect(probe2.counts.started).toBe(2);

		// Merged record contains all 4 results in plan order
		expect(resumedRecord.results).toHaveLength(4);
		expect(resumedRecord.results.map(r => r.cell.task)).toEqual(["t1", "t2", "t3", "t4"]);

		// Journal on disk now holds all 4 settled trials
		const allJournalRecords = await readRunJournal(runsDir, plan.runId);
		expect(allJournalRecords).toHaveLength(4);
	});

	it("refuses to run when harness preflight refuses, executing zero trials", async () => {
		const refusingHarness: HarnessAdapter = {
			id: "refusing-harness",
			displayName: "Refusing Harness",
			description: "Refuses preflight",
			flags: [],
			defaultModel: "test-model",
			capabilities: { replay: false, compaction: false, armAttachments: false, promptOverrides: false },
			backends: { "in-process": {} },
			async stageAssets() {},
			async preflight() {
				return { ok: false, reason: "Missing API key in environment", missingRequirements: ["API_KEY"] };
			},
		};
		harnesses.registerOnce(refusingHarness);
		const plan = await planRun({
			suite: probeSuite(),
			selection: { harnesses: ["refusing-harness"], models: ["test-model"] },
		});
		const probe = probeBackend();

		const attempt = executeRun({ plan, backend: probe.backend, workDir, runsDir });
		await expect(attempt).rejects.toThrow(HarnessPreflightError);
		await expect(attempt).rejects.toThrow(/refusing-harness.*Missing API key/);
		expect(probe.counts.started).toBe(0);
	});

	it("asserts an aborted run settles rather than hanging indefinitely", async () => {
		const plan = await planRun({
			suite: probeSuite({ tasks: ["hang-1", "hang-2"] }),
			selection: oneVariant,
		});
		const controller = new AbortController();
		const probe = probeBackend({
			onRun: async () => {
				controller.abort();
				return {};
			},
		});

		const start = Date.now();
		const recordPromise = executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			jobs: 1,
			signal: controller.signal,
		});

		const record = await recordPromise;
		const duration = Date.now() - start;

		expect(duration).toBeLessThan(2000);
		expect(record).toBeDefined();
	});
});
