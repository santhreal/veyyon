/**
 * WHY THIS SUITE EXISTS. A trial that threw measured nothing: the container never started, the
 * gateway refused, a socket closed mid-stream. The engine recorded one infrastructure-error row and
 * moved on, so the task was gone from that arm's comparison and the only recovery was another run of
 * everything. On a 500-trial run a one-percent flake rate removed five tasks in silence.
 *
 * THE CLASS THIS CLOSES: a run that ends with fewer measured trials than it planned because of a
 * failure that had nothing to do with the task. The retry decision lives in one place —
 * `src/core/trial-retry.ts` — and `src/run/execute.ts` applies it to every cell of every suite on
 * every backend, so these assertions hold for a suite and a backend that do not exist yet. The two
 * kinds of failure that must NOT be retried are asserted alongside: a spent deadline (the budget is
 * gone, and a second answer would bias the arm toward whichever attempt read better) and a cancelled
 * run (a retry fights the operator). Every attempt is asserted to clean up after itself, and the
 * journal is asserted to hold exactly one row per cell however many attempts it took.
 *
 * Backoff is injected, so no assertion here depends on wall-clock timing. The bound is asserted by
 * a backend that never succeeds: a retry loop with no ceiling would run forever, so the case is
 * written to terminate with the wrong attempt count rather than to hang.
 *
 * WHAT IT DOES NOT CATCH: whether a particular backend throws rather than returning artifacts for a
 * given infrastructure failure. A backend that swallows its own spawn error and returns empty
 * artifacts produces a graded zero, which is that backend's defect and is covered by its own tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
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
import {
	DEFAULT_TRIAL_ATTEMPTS,
	HarnessRegistry,
	isRetryableTrialFailure,
	MAX_TRIAL_ATTEMPTS,
	resolveTrialAttempts,
	summarizeRunCells,
	TRIAL_RETRY_BASE_DELAY_MS,
	TRIAL_RETRY_MAX_DELAY_MS,
	trialRetryDelayMs,
} from "../../src/core";
import { registerBuiltinHarnesses } from "../../src/harnesses";
import { buildRunPlan, executeRun, type RunPlan, readRunJournal } from "../../src/run";

const harnesses = new HarnessRegistry();
registerBuiltinHarnesses(harnesses);

const selection = { harnesses: ["veyyon"], models: ["vendor/model-a"] } as const;

function planOneTask(task: string): Promise<RunPlan> {
	const suite: EvalSuite = {
		name: "probe",
		version: "1.0.0",
		displayName: "Probe",
		description: "A suite that exists to exercise the retry decision.",
		backend: "in-process",
		async discoverTasks(_context: SuiteContext): Promise<readonly string[]> {
			return [task];
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
	};
	return buildRunPlan({ suite, selection, harnessRegistry: harnesses });
}

interface FlakyBackend {
	readonly backend: ExecutionBackend;
	readonly cleaned: string[];
	/** One entry per `runTrial` call. */
	readonly attempts: number[];
}

/** A backend that throws `thrown(attempt)` for the first `failures` attempts, then succeeds. */
function flakyBackend(failures: number, thrown: (attempt: number) => unknown): FlakyBackend {
	const cleaned: string[] = [];
	const attempts: number[] = [];
	const backend: ExecutionBackend = {
		id: "in-process",
		appliesVariantAxes: [],
		async preflight(): Promise<PreflightVerdict> {
			return { ok: true };
		},
		async prepare(_context: RunContext): Promise<void> {},
		async runTrial(): Promise<TrialArtifacts> {
			const attempt = attempts.length + 1;
			attempts.push(attempt);
			if (attempt <= failures) throw thrown(attempt);
			return { trialDir: `/runs/attempt-${attempt}` };
		},
		async cleanup(cell: TrialCell): Promise<void> {
			cleaned.push(`${cell.task}/${cell.variant}/${cell.repeat}`);
		},
	};
	return { backend, cleaned, attempts };
}

describe("the retry decision", () => {
	it("bounds one trial at five attempts and retries a throw once by default", () => {
		// Pinned as literals: every other assertion here derives its expectation from these two
		// constants, so a cap that drifted to 50 would leave this file green while one dead task
		// paid for fifty container starts.
		expect(DEFAULT_TRIAL_ATTEMPTS).toBe(2);
		expect(MAX_TRIAL_ATTEMPTS).toBe(5);
	});

	it("clamps a stated count into 1..MAX", () => {
		expect(resolveTrialAttempts(undefined)).toBe(DEFAULT_TRIAL_ATTEMPTS);
		expect(resolveTrialAttempts({})).toBe(DEFAULT_TRIAL_ATTEMPTS);
		expect(resolveTrialAttempts({ trialAttempts: "3" })).toBe(DEFAULT_TRIAL_ATTEMPTS);
		expect(resolveTrialAttempts({ trialAttempts: Number.NaN })).toBe(DEFAULT_TRIAL_ATTEMPTS);
		expect(resolveTrialAttempts({ trialAttempts: 1 })).toBe(1);
		expect(resolveTrialAttempts({ trialAttempts: 0 })).toBe(1);
		expect(resolveTrialAttempts({ trialAttempts: -4 })).toBe(1);
		expect(resolveTrialAttempts({ trialAttempts: 3.7 })).toBe(3);
		expect(resolveTrialAttempts({ trialAttempts: 6 })).toBe(5);
		expect(resolveTrialAttempts({ trialAttempts: 900 })).toBe(5);
		expect(resolveTrialAttempts({ trialAttempts: Number.POSITIVE_INFINITY })).toBe(DEFAULT_TRIAL_ATTEMPTS);
	});

	it("backs off by doubling and never waits longer than the cap", () => {
		expect(trialRetryDelayMs(2)).toBe(TRIAL_RETRY_BASE_DELAY_MS);
		expect(trialRetryDelayMs(3)).toBe(TRIAL_RETRY_BASE_DELAY_MS * 2);
		expect(trialRetryDelayMs(4)).toBe(TRIAL_RETRY_BASE_DELAY_MS * 4);
		expect(trialRetryDelayMs(40)).toBe(TRIAL_RETRY_MAX_DELAY_MS);
		// Attempt 1 is never delayed, but a caller that asks must not get a negative wait.
		expect(trialRetryDelayMs(1)).toBe(TRIAL_RETRY_BASE_DELAY_MS);
	});

	it.each([
		["a refused container", new Error("failed to start container: connection refused"), true],
		["a provider 503", new Error("provider returned 503 Service Unavailable"), true],
		["a closed socket", new Error("socket hang up"), true],
		["a non-Error throw", "spawn ENOENT", true],
		["a spent trial deadline", new Error("trial timed out after 1800s"), false],
		["a bare timeout", new Error("Timeout"), false],
		["an exceeded deadline", new Error("exceeded deadline for task foo"), false],
		["an aborted request", new Error("The operation was aborted"), false],
		["an abort without the d", new Error("fetch abort"), false],
	] as [string, unknown, boolean][])("decides %s", (_label, cause, expected) => {
		expect(isRetryableTrialFailure(cause)).toBe(expected);
	});

	it("refuses every retry once the run is cancelled, whatever the failure says", () => {
		const controller = new AbortController();
		controller.abort();

		expect(isRetryableTrialFailure(new Error("connection refused"), controller.signal)).toBe(false);
		// The same failure earns an attempt while the run is live.
		expect(isRetryableTrialFailure(new Error("connection refused"), new AbortController().signal)).toBe(true);
	});
});

describe("executeRun retries a thrown trial", () => {
	let temp: TempDir;
	let workDir: string;
	let runsDir: string;
	const noSleep = async (): Promise<void> => {};

	beforeEach(async () => {
		temp = await TempDir.create("evals-retry-");
		workDir = temp.join("work");
		runsDir = temp.join("runs");
		await fs.mkdir(workDir, { recursive: true });
		await fs.mkdir(runsDir, { recursive: true });
	});

	afterEach(async () => {
		await temp.remove();
	});

	it("records the pass a retried trial earned, not the throw that preceded it", async () => {
		const plan = await planOneTask("flake");
		const probe = flakyBackend(1, () => new Error("failed to start container: connection refused"));
		const retried: Array<{ failedAttempt: number; message: string }> = [];

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			sleep: noSleep,
			onRetry: (_cell, failedAttempt, cause) => {
				retried.push({ failedAttempt, message: cause instanceof Error ? cause.message : String(cause) });
			},
		});
		const [summary] = summarizeRunCells(record);

		expect(probe.attempts).toEqual([1, 2]);
		expect(summary?.passes).toBe(1);
		expect(summary?.errors).toBe(0);
		expect(record.results[0]?.score.reward).toBe(1);
		expect(record.results[0]?.score.error).toBeNull();
		// The row states how many attempts it cost, so a flaky task is visible in the record.
		expect(record.results[0]?.score.extra.attempts).toBe(2);
		expect(retried).toEqual([{ failedAttempt: 1, message: "failed to start container: connection refused" }]);
	});

	it("cleans up after every attempt and writes exactly one journal row for the cell", async () => {
		const plan = await planOneTask("flake");
		const probe = flakyBackend(1, () => new Error("connection refused"));

		const record = await executeRun({ plan, backend: probe.backend, workDir, runsDir, sleep: noSleep });
		const journal = await readRunJournal(runsDir, record.id);

		expect(probe.cleaned).toEqual(["flake/veyyon/1", "flake/veyyon/1"]);
		expect(journal.length).toBe(1);
		expect(journal[0]?.cell.task).toBe("flake");
	});

	it("stops at the attempt ceiling and records an error rather than retrying forever", async () => {
		const plan = await planOneTask("dead");
		// Never succeeds, and from attempt 8 the failure is one nothing retries. A loop with no
		// ceiling therefore ends with the wrong attempt count instead of hanging the suite, which is
		// what a ceiling this test cannot see would do to CI.
		const probe = flakyBackend(Number.MAX_SAFE_INTEGER, attempt =>
			attempt < 8 ? new Error("connection refused") : new Error("trial timed out after 60s"),
		);
		const waits: number[] = [];

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			options: { trialAttempts: 3 },
			sleep: async (ms: number) => {
				waits.push(ms);
			},
		});
		const [summary] = summarizeRunCells(record);

		expect(probe.attempts).toEqual([1, 2, 3]);
		expect(waits).toEqual([TRIAL_RETRY_BASE_DELAY_MS, TRIAL_RETRY_BASE_DELAY_MS * 2]);
		expect(summary?.errors).toBe(1);
		expect(record.results[0]?.score.reward).toBeNull();
		expect(record.results[0]?.score.error).toBe("connection refused");
		expect(record.results[0]?.score.extra.attempts).toBe(3);
	});

	it("clamps a stated count above the ceiling instead of honouring it", async () => {
		const plan = await planOneTask("dead");
		const probe = flakyBackend(Number.MAX_SAFE_INTEGER, attempt =>
			attempt < 20 ? new Error("connection refused") : new Error("trial timed out after 60s"),
		);

		await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			options: { trialAttempts: 99 },
			sleep: noSleep,
		});

		expect(probe.attempts.length).toBe(5);
	});

	it("attempts a trial once when the run states one attempt", async () => {
		const plan = await planOneTask("flake");
		const probe = flakyBackend(1, () => new Error("connection refused"));

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			options: { trialAttempts: 1 },
			sleep: noSleep,
		});

		expect(probe.attempts).toEqual([1]);
		expect(record.results[0]?.score.error).toBe("connection refused");
		// One attempt is the ordinary case, so the row does not carry an attempt count.
		expect(record.results[0]?.score.extra.attempts).toBeUndefined();
	});

	it("never attempts a trial again once its deadline is spent", async () => {
		const plan = await planOneTask("slow");
		const probe = flakyBackend(1, () => new Error("trial timed out after 60s"));
		const retried: number[] = [];

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			sleep: noSleep,
			onRetry: (_cell, failedAttempt) => retried.push(failedAttempt),
		});

		expect(probe.attempts).toEqual([1]);
		expect(retried).toEqual([]);
		expect(record.results[0]?.score.error).toBe("trial timed out after 60s");
		expect(probe.cleaned).toEqual(["slow/veyyon/1"]);
	});

	it("never attempts a trial again once the run is cancelled", async () => {
		const plan = await planOneTask("cancelled");
		const controller = new AbortController();
		const probe = flakyBackend(1, () => {
			controller.abort();
			return new Error("connection refused");
		});

		const record = await executeRun({
			plan,
			backend: probe.backend,
			workDir,
			runsDir,
			signal: controller.signal,
			sleep: noSleep,
		});

		expect(probe.attempts).toEqual([1]);
		expect(record.results[0]?.score.error).toBe("connection refused");
	});
});
