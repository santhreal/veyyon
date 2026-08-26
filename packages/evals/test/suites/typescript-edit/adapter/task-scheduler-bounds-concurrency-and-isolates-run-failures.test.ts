/**
 * WHY:
 * Parallel benchmark execution relies on strict concurrency bounds, fair task queue
 * dispatching, fixture sandbox isolation, and failure resilience. A queue scheduler
 * that drops tasks, exceeds concurrency limits, strands workers on thrown exceptions,
 * or hangs on unhandled child errors invalidates benchmark trial comparisons and can
 * exhaust host process or memory resources.
 *
 * This suite verifies:
 * 1. copyFixtures copies task inputs and fails closed when inputDir is missing.
 * 2. buildFailureResult creates well-formed TaskRunResult objects with zeroed metrics.
 * 3. shuffle produces random permutations while preserving all task elements.
 * 4. runConcurrentBenchmarkRun isolates fixture setup and handles runSingleTask failures cleanly.
 * 5. runBenchmark bounds concurrent in-flight tasks strictly to taskConcurrency.
 * 6. runBenchmark dispatches every task exactly once and executes all N runs per task.
 * 7. runBenchmark terminates reliably within bounded time and handles thrown task exceptions without deadlock.
 * 8. runBenchmark emits progress events and snapshot updates incrementally.
 * 9. runBenchmark ensures shared infrastructure cleanup in all termination paths.
 *
 * What this does not catch:
 * OS-level thread scheduling latency or filesystem I/O driver anomalies.
 */

import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import * as inProcessClientModule from "../../../../src/backends/in-process/client";
import {
	buildFailureResult,
	copyFixtures,
	runBenchmark,
	runConcurrentBenchmarkRun,
	shuffle,
} from "../../../../src/suites/typescript-edit/adapter/runner/scheduler";
import * as sessionModule from "../../../../src/suites/typescript-edit/adapter/runner/session";
import type {
	BenchmarkConfig,
	BenchmarkResult,
	ProgressEvent,
	TaskRunItem,
	TaskRunResult,
} from "../../../../src/suites/typescript-edit/adapter/runner/types";
import type { EditTask } from "../../../../src/suites/typescript-edit/tasks";

const tempDirs: TempDir[] = [];

async function createTempDir(prefix: string): Promise<TempDir> {
	const dir = await TempDir.create(prefix);
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map(async dir => {
			await dir.remove();
		}),
	);
});

function createSampleConfig(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
	return {
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		runsPerTask: 1,
		timeout: 60000,
		taskConcurrency: 2,
		inProcess: false,
		...overrides,
	};
}

function createSampleTask(id: string, inputDir: string, expectedDir: string): EditTask {
	return {
		id,
		name: `Task ${id}`,
		prompt: `Prompt for ${id}`,
		files: ["index.ts"],
		inputDir,
		expectedDir,
	};
}

function createSampleSuccessfulResult(runIndex: number, overrides: Partial<TaskRunResult> = {}): TaskRunResult {
	return {
		runIndex,
		success: true,
		patchApplied: true,
		verificationPassed: true,
		tokens: { input: 100, output: 50, reasoning: 0, total: 150 },
		duration: 250,
		toolCalls: {
			read: 1,
			edit: 1,
			write: 0,
			editSuccesses: 1,
			editFailures: 0,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 120,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
		...overrides,
	};
}

describe("copyFixtures", () => {
	it("fails closed with an explicit error when inputDir is not defined", async () => {
		const tempDir = await createTempDir("evals-copy-fixtures-missing-");
		const destDir = tempDir.join("dest");
		await fs.mkdir(destDir, { recursive: true });

		const task: EditTask = {
			id: "missing-input",
			name: "No input dir task",
			prompt: "fix",
			files: ["a.ts"],
			inputDir: (undefined as unknown as string),
			expectedDir: "/tmp/fake-expected",
		};

		await expect(copyFixtures(task, destDir)).rejects.toThrow("Task missing-input has no inputDir");
	});

	it("recursively copies all files and nested directory trees to destDir", async () => {
		const tempDir = await createTempDir("evals-copy-fixtures-valid-");
		const inputDir = tempDir.join("input");
		const destDir = tempDir.join("dest");
		await fs.mkdir(path.join(inputDir, "nested", "deep"), { recursive: true });
		await fs.mkdir(destDir, { recursive: true });

		await fs.writeFile(path.join(inputDir, "root.ts"), "const root = 1;", "utf8");
		await fs.writeFile(path.join(inputDir, "nested", "mid.ts"), "const mid = 2;", "utf8");
		await fs.writeFile(path.join(inputDir, "nested", "deep", "leaf.ts"), "const leaf = 3;", "utf8");

		const task = createSampleTask("valid-copy", inputDir, tempDir.join("expected"));
		await copyFixtures(task, destDir);

		const rootContent = await fs.readFile(path.join(destDir, "root.ts"), "utf8");
		const midContent = await fs.readFile(path.join(destDir, "nested", "mid.ts"), "utf8");
		const leafContent = await fs.readFile(path.join(destDir, "nested", "deep", "leaf.ts"), "utf8");

		expect(rootContent).toBe("const root = 1;");
		expect(midContent).toBe("const mid = 2;");
		expect(leafContent).toBe("const leaf = 3;");
	});
});

describe("buildFailureResult", () => {
	it("constructs a zeroed failure result capturing error message and runIndex", () => {
		const task = createSampleTask("task-fail", "/tmp/in", "/tmp/exp");
		const item: TaskRunItem = { task, runIndex: 3 };
		const errorMessage = "Subprocess exited with signal SIGKILL (OOM)";

		const result = buildFailureResult(item, errorMessage);

		expect(result.runIndex).toBe(3);
		expect(result.success).toBe(false);
		expect(result.patchApplied).toBe(false);
		expect(result.verificationPassed).toBe(false);
		expect(result.error).toBe(errorMessage);
		expect(result.duration).toBe(0);
		expect(result.tokens).toEqual({ input: 0, output: 0, reasoning: 0, total: 0 });
		expect(result.toolCalls).toEqual({
			read: 0,
			edit: 0,
			write: 0,
			editSuccesses: 0,
			editFailures: 0,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 0,
		});
		expect(result.editFailures).toEqual([]);
		expect(result.editWarnings).toEqual([]);
		expect(result.editAutocorrectCount).toBe(0);
	});
});

describe("shuffle", () => {
	it("returns a new array with identical element multiset without in-place mutation", () => {
		const original = ["task-1", "task-2", "task-3", "task-4", "task-5", "task-6", "task-7", "task-8"];
		const copy = [...original];

		const shuffled = shuffle(original);

		expect(shuffled).not.toBe(original);
		expect(original).toEqual(copy);
		expect([...shuffled].sort()).toEqual([...original].sort());
		expect(shuffled.length).toBe(original.length);
	});

	it("handles empty and single-element arrays predictably", () => {
		expect(shuffle([])).toEqual([]);
		expect(shuffle(["single"])).toEqual(["single"]);
	});
});

describe("runConcurrentBenchmarkRun", () => {
	it("executes single task, copies fixtures, and emits started and completed progress", async () => {
		const tempDir = await createTempDir("evals-concurrent-run-");
		const inputDir = tempDir.join("input");
		const expectedDir = tempDir.join("expected");
		const tempRoot = tempDir.join("runs");
		await fs.mkdir(inputDir, { recursive: true });
		await fs.mkdir(expectedDir, { recursive: true });
		await fs.mkdir(tempRoot, { recursive: true });

		await fs.writeFile(path.join(inputDir, "index.ts"), "const x = 1;", "utf8");

		const task = createSampleTask("task-success", inputDir, expectedDir);
		const config = createSampleConfig();
		const item: TaskRunItem = { task, runIndex: 0 };
		const progressEvents: ProgressEvent[] = [];

		const expectedResult = createSampleSuccessfulResult(0);
		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async () => expectedResult);

		try {
			const outcome = await runConcurrentBenchmarkRun(
				item,
				config,
				tempRoot,
				event => progressEvents.push(event),
			);

			expect(outcome.task.id).toBe("task-success");
			expect(outcome.result).toEqual(expectedResult);
			expect(progressEvents.map(e => e.status)).toEqual(["started", "completed"]);
			expect(progressEvents[1]?.result).toEqual(expectedResult);
		} finally {
			runSingleTaskSpy.mockRestore();
		}
	});

	it("catches runSingleTask exceptions and returns structured failure result without throwing", async () => {
		const tempDir = await createTempDir("evals-concurrent-throw-");
		const inputDir = tempDir.join("input");
		const expectedDir = tempDir.join("expected");
		const tempRoot = tempDir.join("runs");
		await fs.mkdir(inputDir, { recursive: true });
		await fs.mkdir(expectedDir, { recursive: true });
		await fs.mkdir(tempRoot, { recursive: true });

		await fs.writeFile(path.join(inputDir, "index.ts"), "const x = 1;", "utf8");

		const task = createSampleTask("task-crash", inputDir, expectedDir);
		const config = createSampleConfig();
		const item: TaskRunItem = { task, runIndex: 1 };
		const progressEvents: ProgressEvent[] = [];

		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async () => {
			throw new Error("RPC socket closed unexpectedly");
		});

		try {
			const outcome = await runConcurrentBenchmarkRun(
				item,
				config,
				tempRoot,
				event => progressEvents.push(event),
			);

			expect(outcome.task.id).toBe("task-crash");
			expect(outcome.result.success).toBe(false);
			expect(outcome.result.error).toContain("RPC socket closed unexpectedly");
			expect(progressEvents.map(e => e.status)).toEqual(["started", "completed"]);
			expect(progressEvents[1]?.result?.success).toBe(false);
		} finally {
			runSingleTaskSpy.mockRestore();
		}
	});

	it("catches copyFixtures errors and returns failure result", async () => {
		const tempDir = await createTempDir("evals-concurrent-copy-err-");
		const tempRoot = tempDir.join("runs");
		await fs.mkdir(tempRoot, { recursive: true });

		// Non-existent inputDir triggers fs error during copyFixtures
		const task = createSampleTask("task-bad-dir", tempDir.join("non-existent"), tempDir.join("expected"));
		const config = createSampleConfig();
		const item: TaskRunItem = { task, runIndex: 0 };
		const progressEvents: ProgressEvent[] = [];

		const outcome = await runConcurrentBenchmarkRun(
			item,
			config,
			tempRoot,
			event => progressEvents.push(event),
		);

		expect(outcome.task.id).toBe("task-bad-dir");
		expect(outcome.result.success).toBe(false);
		expect(outcome.result.error).toBeTruthy();
		expect(progressEvents.map(e => e.status)).toEqual(["completed"]);
	});
});

describe("runBenchmark concurrency and queue execution", () => {
	it("strictly respects taskConcurrency bound and dispatches every task exactly once", async () => {
		const tempDir = await createTempDir("evals-benchmark-concurrency-");
		const tasksCount = 6;
		const concurrencyCap = 2;
		const tasks: EditTask[] = [];

		for (let i = 0; i < tasksCount; i++) {
			const inputDir = tempDir.join(`input-${i}`);
			const expectedDir = tempDir.join(`expected-${i}`);
			await fs.mkdir(inputDir, { recursive: true });
			await fs.mkdir(expectedDir, { recursive: true });
			await fs.writeFile(path.join(inputDir, "index.ts"), `const v = ${i};`, "utf8");
			tasks.push(createSampleTask(`task-${i}`, inputDir, expectedDir));
		}

		const config = createSampleConfig({
			taskConcurrency: concurrencyCap,
			runsPerTask: 1,
			inProcess: false,
		});
		let inFlightTasks = 0;
		let maxObservedInFlightTasks = 0;
		let activeStartedTasks = 0;
		let maxActiveStartedTasks = 0;
		const executedTaskIds: string[] = [];
		const allSlotsStartedGate = Promise.withResolvers<void>();
		const releaseGate = Promise.withResolvers<void>();

		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async task => {
			inFlightTasks++;
			maxObservedInFlightTasks = Math.max(maxObservedInFlightTasks, inFlightTasks);
			executedTaskIds.push(task.id);

			await releaseGate.promise;

			inFlightTasks--;
			return createSampleSuccessfulResult(0);
		});

		try {
			const runPromise = runBenchmark(
				tasks,
				config,
				event => {
					if (event.status === "started") {
						activeStartedTasks++;
						maxActiveStartedTasks = Math.max(maxActiveStartedTasks, activeStartedTasks);
						if (activeStartedTasks >= concurrencyCap) {
							allSlotsStartedGate.resolve();
						}
					} else if (event.status === "completed") {
						activeStartedTasks--;
					}
				},
			);

			// Await all initial concurrency slots to reach "started" status while held
			await allSlotsStartedGate.promise;

			// Release the held tasks so the queue can drain
			releaseGate.resolve();

			const result = await runPromise;
			expect(maxObservedInFlightTasks).toBe(concurrencyCap);
			expect(maxActiveStartedTasks).toBe(concurrencyCap);
			expect(maxObservedInFlightTasks).toBeLessThanOrEqual(concurrencyCap);
			expect(maxActiveStartedTasks).toBeLessThanOrEqual(concurrencyCap);
			expect(executedTaskIds.length).toBe(tasksCount);
			expect([...executedTaskIds].sort()).toEqual(tasks.map(t => t.id).sort());
			expect(result.summary.totalTasks).toBe(tasksCount);
			expect(result.summary.totalRuns).toBe(tasksCount);
			expect(result.summary.successfulTasks).toBe(tasksCount);
			expect(result.tasks.length).toBe(tasksCount);
		} finally {
			runSingleTaskSpy.mockRestore();
		}
	});

	it("executes all N runs per task concurrently across worker slots", async () => {
		const tempDir = await createTempDir("evals-benchmark-multi-runs-");
		const tasksCount = 3;
		const runsPerTask = 3;
		const tasks: EditTask[] = [];

		for (let i = 0; i < tasksCount; i++) {
			const inputDir = tempDir.join(`input-${i}`);
			const expectedDir = tempDir.join(`expected-${i}`);
			await fs.mkdir(inputDir, { recursive: true });
			await fs.mkdir(expectedDir, { recursive: true });
			await fs.writeFile(path.join(inputDir, "index.ts"), `const x = ${i};`, "utf8");
			tasks.push(createSampleTask(`multi-task-${i}`, inputDir, expectedDir));
		}

		const config = createSampleConfig({
			taskConcurrency: 2,
			runsPerTask,
			inProcess: false,
		});

		const executedRuns: Array<{ taskId: string; runIndex: number }> = [];

		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async (task, runIndex) => {
			executedRuns.push({ taskId: task.id, runIndex });
			await Promise.resolve();
			return createSampleSuccessfulResult(runIndex);
		});

		try {
			const result = await runBenchmark(tasks, config);

			expect(executedRuns.length).toBe(tasksCount * runsPerTask);
			expect(result.summary.totalTasks).toBe(tasksCount);
			expect(result.summary.totalRuns).toBe(tasksCount * runsPerTask);

			for (const taskResult of result.tasks) {
				expect(taskResult.runs.length).toBe(runsPerTask);
				expect(taskResult.runs.map(r => r.runIndex).sort()).toEqual([0, 1, 2]);
			}
		} finally {
			runSingleTaskSpy.mockRestore();
		}
	});

	it("isolates thrown task errors without stranding remaining queued tasks or hanging", async () => {
		const tempDir = await createTempDir("evals-benchmark-fault-isolation-");
		const tasks: EditTask[] = [];

		for (let i = 0; i < 4; i++) {
			const inputDir = tempDir.join(`input-${i}`);
			const expectedDir = tempDir.join(`expected-${i}`);
			await fs.mkdir(inputDir, { recursive: true });
			await fs.mkdir(expectedDir, { recursive: true });
			await fs.writeFile(path.join(inputDir, "index.ts"), `const n = ${i};`, "utf8");
			tasks.push(createSampleTask(`fault-task-${i}`, inputDir, expectedDir));
		}

		const config = createSampleConfig({
			taskConcurrency: 2,
			runsPerTask: 1,
			inProcess: false,
		});

		const executedTaskIds: string[] = [];

		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async task => {
			executedTaskIds.push(task.id);
			await Promise.resolve();
			if (task.id === "fault-task-1") {
				throw new Error("Uncaught fatal exception inside task-1 sandbox");
			}
			return createSampleSuccessfulResult(0);
		});

		try {
			const result = await runBenchmark(tasks, config);

			expect(executedTaskIds.length).toBe(4);
			expect([...executedTaskIds].sort()).toEqual(tasks.map(t => t.id).sort());
			expect(result.summary.totalTasks).toBe(4);
			expect(result.summary.successfulTasks).toBe(3);

			const failedTaskResult = result.tasks.find(t => t.id === "fault-task-1");
			expect(failedTaskResult?.success).toBe(false);
			expect(failedTaskResult?.runs[0]?.error).toContain("Uncaught fatal exception inside task-1 sandbox");

			const successTasks = result.tasks.filter(t => t.id !== "fault-task-1");
			expect(successTasks.every(t => t.success)).toBe(true);
		} finally {
			runSingleTaskSpy.mockRestore();
		}
	});

	it("emits incremental progress events and result snapshots during execution", async () => {
		const tempDir = await createTempDir("evals-benchmark-snapshots-");
		const tasks: EditTask[] = [];

		for (let i = 0; i < 3; i++) {
			const inputDir = tempDir.join(`input-${i}`);
			const expectedDir = tempDir.join(`expected-${i}`);
			await fs.mkdir(inputDir, { recursive: true });
			await fs.mkdir(expectedDir, { recursive: true });
			await fs.writeFile(path.join(inputDir, "index.ts"), `const a = ${i};`, "utf8");
			tasks.push(createSampleTask(`snap-task-${i}`, inputDir, expectedDir));
		}

		const config = createSampleConfig({
			taskConcurrency: 1,
			runsPerTask: 1,
			inProcess: false,
		});

		const progressStatuses: string[] = [];
		const snapshotTotalRuns: number[] = [];

		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async () => {
			await Promise.resolve();
			return createSampleSuccessfulResult(0);
		});

		try {
			const finalResult = await runBenchmark(
				tasks,
				config,
				event => progressStatuses.push(event.status),
				snapshot => snapshotTotalRuns.push(snapshot.summary.totalRuns),
			);

			expect(progressStatuses).toEqual(["started", "completed", "started", "completed", "started", "completed"]);
			expect(snapshotTotalRuns).toEqual([1, 2, 3]);
			expect(finalResult.summary.totalRuns).toBe(3);
		} finally {
			runSingleTaskSpy.mockRestore();
		}
	});

	it("returns an empty benchmark result immediately when given an empty task list", async () => {
		const config = createSampleConfig({ taskConcurrency: 4 });
		const result = await runBenchmark([], config);

		expect(result.tasks).toEqual([]);
		expect(result.summary.totalTasks).toBe(0);
		expect(result.summary.totalRuns).toBe(0);
		expect(result.summary.successfulTasks).toBe(0);
	});

	it("closes shared authStorage during cleanup in all execution paths", async () => {
		const tempDir = await createTempDir("evals-benchmark-cleanup-");
		const inputDir = tempDir.join("input");
		const expectedDir = tempDir.join("expected");
		await fs.mkdir(inputDir, { recursive: true });
		await fs.mkdir(expectedDir, { recursive: true });
		await fs.writeFile(path.join(inputDir, "index.ts"), "const x = 1;", "utf8");

		const task = createSampleTask("cleanup-task", inputDir, expectedDir);
		const config = createSampleConfig({
			taskConcurrency: 1,
			runsPerTask: 1,
			inProcess: true,
		});

		let authStorageClosed = false;
		const fakeShared = {
			authStorage: {
				close: () => {
					authStorageClosed = true;
				},
			},
			modelRegistry: {},
		};

		const discoverSpy = spyOn(inProcessClientModule, "discoverSharedInfra").mockImplementation(
			async () => fakeShared as unknown as inProcessClientModule.SharedInfra,
		);
		const runSingleTaskSpy = spyOn(sessionModule, "runSingleTask").mockImplementation(async () => {
			return createSampleSuccessfulResult(0);
		});

		try {
			await runBenchmark([task], config);
			expect(authStorageClosed).toBe(true);
		} finally {
			discoverSpy.mockRestore();
			runSingleTaskSpy.mockRestore();
		}
	});
});
