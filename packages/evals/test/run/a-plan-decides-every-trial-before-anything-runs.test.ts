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

import { describe, expect, it } from "bun:test";
import type {
	EvalSuite,
	ExecutionBackend,
	PreflightVerdict,
	RunContext,
	SuiteContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
} from "../../src/core";
import { summarizeRunCells } from "../../src/core";
import {
	BackendPreflightError,
	buildRunPlan,
	describeRunPlan,
	EmptyTaskSelectionError,
	executeRun,
	InvalidConcurrencyError,
	InvalidRepeatsError,
	SuitePreflightError,
	UnknownTaskError,
} from "../../src/run";

interface ProbeSuiteOptions {
	readonly tasks?: readonly string[];
	readonly preflight?: PreflightVerdict;
	readonly score?: (cell: TrialCell, artifacts: TrialArtifacts) => TrialScore;
}

function probeSuite(options: ProbeSuiteOptions = {}): EvalSuite {
	const tasks = options.tasks ?? ["task-a", "task-b"];
	return {
		name: "probe",
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
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants, repeats: 2 });

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
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants });

		expect(plan.cells).toHaveLength(plan.variants.length * plan.tasks.length);
		expect(plan.repeats).toBe(1);
	});

	it("describes every requested task, in requested order", async () => {
		const plan = await buildRunPlan({
			suite: probeSuite({ tasks: ["a", "b", "c"] }),
			selection: twoVariants,
			tasks: ["c", "a"],
		});

		expect(plan.tasks.map(task => task.id)).toEqual(["c", "a"]);
	});

	it("refuses a requested task the suite does not hold, naming the missing ids", async () => {
		const attempt = buildRunPlan({
			suite: probeSuite({ tasks: ["a", "b"] }),
			selection: twoVariants,
			tasks: ["a", "ghost", "phantom"],
		});

		await expect(attempt).rejects.toThrow(UnknownTaskError);
		await expect(attempt).rejects.toThrow(/ghost, phantom/);
	});

	it("refuses a suite that discovers no tasks rather than reporting an empty pass rate", async () => {
		const attempt = buildRunPlan({ suite: probeSuite({ tasks: [] }), selection: twoVariants });

		await expect(attempt).rejects.toThrow(EmptyTaskSelectionError);
	});

	it.each([0, -1, 1.5])("refuses repeats=%p", async repeats => {
		const attempt = buildRunPlan({ suite: probeSuite(), selection: twoVariants, repeats });

		await expect(attempt).rejects.toThrow(InvalidRepeatsError);
	});

	it("carries the suite's dataset provenance into the plan", async () => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants });

		expect(plan.provenance.sha).toBe("deadbeef");
	});

	it("honours an explicit run id and otherwise generates one naming the suite", async () => {
		const named = await buildRunPlan({ suite: probeSuite(), selection: twoVariants, runId: "job-17" });
		const generated = await buildRunPlan({
			suite: probeSuite(),
			selection: twoVariants,
			now: () => new Date("2026-01-02T03:04:05.678Z"),
		});

		expect(named.runId).toBe("job-17");
		expect(generated.runId).toBe("probe-2026-01-02T03-04-05-678");
	});

	it("reports the queue size and every axis in its description", async () => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants, repeats: 3 });

		const described = describeRunPlan(plan);

		expect(described).toContain("queue      12 trial(s)");
		expect(described).toContain("variants   2: baseline, candidate");
		expect(described).toContain("models     vendor/model-a");
		expect(described).toContain("repeats    3");
	});
});

describe("executeRun", () => {
	it("records results in plan order even when trials finish out of order", async () => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants });
		const firstTaskGate = Promise.withResolvers<void>();
		let remainingSecondTask = 2;
		const probe = probeBackend({
			onRun: async cell => {
				// Every task-b cell settles before any task-a cell, inverting completion
				// order against plan order.
				if (cell.task === "task-b") {
					remainingSecondTask -= 1;
					if (remainingSecondTask === 0) firstTaskGate.resolve();
					return { trialDir: `/runs/${cell.task}` };
				}
				await firstTaskGate.promise;
				return { trialDir: `/runs/${cell.task}` };
			},
		});

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir: "/work",
			runsDir: "/runs",
			jobs: 4,
		});

		expect(record.results.map(result => `${result.cell.task}:${result.cell.variant}`)).toEqual(
			plan.cells.map(cell => `${cell.task}:${cell.variant}`),
		);
	});

	it.each([1, 2, 3])("holds exactly jobs=%p trials in flight and no more", async jobs => {
		const plan = await buildRunPlan({ suite: probeSuite({ tasks: ["a", "b", "c", "d"] }), selection: twoVariants });
		const probe = probeBackend();

		await executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs", jobs });

		expect(probe.counts.peak).toBe(jobs);
		expect(probe.counts.started).toBe(plan.cells.length);
	});

	it("prepares the backend exactly once per run", async () => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants });
		const probe = probeBackend();

		await executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs", jobs: 2 });

		expect(probe.prepared).toEqual([plan.runId]);
	});

	it("keeps a thrown trial distinguishable from a real reward of zero", async () => {
		const plan = await buildRunPlan({
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

		const record = await executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs" });

		const byTask = new Map(record.results.map(result => [result.cell.task, result.score]));
		expect(byTask.get("boom")?.error).toBe("container exited 137");
		expect(byTask.get("boom")?.reward).toBeNull();
		expect(byTask.get("zero")?.error).toBeNull();
		expect(byTask.get("zero")?.reward).toBe(0);
	});

	it("counts a thrown trial as an error and a zero as a non-pass in the run summary", async () => {
		const plan = await buildRunPlan({
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

		const record = await executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs" });
		const [summary] = summarizeRunCells(record);

		expect(summary.total).toBe(3);
		expect(summary.errors).toBe(1);
		expect(summary.passes).toBe(1);
	});

	it("cleans up every cell, including one whose trial threw", async () => {
		const plan = await buildRunPlan({ suite: probeSuite({ tasks: ["ok", "boom"] }), selection: oneVariant });
		const probe = probeBackend({
			onRun: async cell => {
				if (cell.task === "boom") throw new Error("spawn failed");
				return {};
			},
		});

		await executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs" });

		expect(probe.cleaned.sort()).toEqual(["boom/veyyon/1", "ok/veyyon/1"]);
	});

	it("keeps a scored trial when cleanup itself throws", async () => {
		const plan = await buildRunPlan({ suite: probeSuite({ tasks: ["ok"] }), selection: oneVariant });
		const probe = probeBackend();
		const backend: ExecutionBackend = {
			...probe.backend,
			async cleanup(): Promise<void> {
				throw new Error("docker rm refused");
			},
		};

		const record = await executeRun({ plan, backend, workDir: "/work", runsDir: "/runs" });

		expect(record.results).toHaveLength(1);
		expect(record.results[0].score.reward).toBe(1);
	});

	it("refuses to start when the suite's preflight fails, naming what is missing", async () => {
		const plan = await buildRunPlan({
			suite: probeSuite({
				preflight: { ok: false, reason: "corpus not acquired", missingRequirements: ["corpus"] },
			}),
			selection: twoVariants,
		});
		const probe = probeBackend();

		const attempt = executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs" });

		await expect(attempt).rejects.toThrow(SuitePreflightError);
		await expect(attempt).rejects.toThrow(/corpus not acquired.*Missing: corpus/s);
	});

	it("refuses to start when the backend's preflight fails, and runs no trial", async () => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants });
		const probe = probeBackend({
			preflight: { ok: false, reason: "harbor not found on PATH", missingRequirements: ["harbor"] },
		});

		const attempt = executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs" });

		await expect(attempt).rejects.toThrow(BackendPreflightError);
		expect(probe.prepared).toEqual([]);
		expect(probe.counts.started).toBe(0);
	});

	it.each([0, -2, 2.5])("refuses jobs=%p", async jobs => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants });
		const probe = probeBackend();

		const attempt = executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs", jobs });

		await expect(attempt).rejects.toThrow(InvalidConcurrencyError);
	});

	it("terminates on abort and returns only the trials that finished", async () => {
		const plan = await buildRunPlan({
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
			workDir: "/work",
			runsDir: "/runs",
			jobs: 1,
			signal: controller.signal,
		});

		expect(probe.counts.started).toBe(1);
		expect(record.results).toHaveLength(1);
		expect(record.results.length).toBeLessThan(plan.cells.length);
	});

	it("tags the record with the suite identity and dataset sha so two suites cannot merge", async () => {
		const plan = await buildRunPlan({ suite: probeSuite(), selection: twoVariants, runId: "job-42" });
		const probe = probeBackend();

		const record = await executeRun({ plan, backend: probe.backend, workDir: "/work", runsDir: "/runs" });

		expect(record.id).toBe("job-42");
		expect(record.suite).toEqual({ name: "probe", version: "1.0.0", provenanceSha: "deadbeef" });
		expect(record.tasks).toEqual(["task-a", "task-b"]);
		expect(record.completedAt).not.toBeNull();
	});

	it("reports each settled trial once, in completion order, to a progress callback", async () => {
		const plan = await buildRunPlan({ suite: probeSuite({ tasks: ["slow", "fast"] }), selection: oneVariant });
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
			workDir: "/work",
			runsDir: "/runs",
			jobs: 2,
			onTrial: (record, index) => seen.push(`${index}:${record.cell.task}`),
		});

		expect(seen).toEqual(["0:fast", "1:slow"]);
	});
});
