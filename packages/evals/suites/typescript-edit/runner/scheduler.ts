/**
 * Worker pool and queue scheduler for parallel edit benchmark task runs.
 *
 * Manages concurrent task execution across worker slots, fixture extraction,
 * progress reporting, and snapshot generation.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage } from "@veyyon/utils";
import { discoverSharedInfra, type SharedInfra } from "../../../backends/in-process/client";
import { runsDir } from "../../../engine/package-paths";
import type { EditTask } from "../tasks";
import { runSingleTask } from "./session";
import { buildBenchmarkResult } from "./stats";
import type { BenchmarkConfig, BenchmarkResult, ProgressEvent, TaskRunItem, TaskRunResult } from "./types";

export async function copyFixtures(task: EditTask, destDir: string): Promise<void> {
	if (!task.inputDir) {
		throw new Error(`Task ${task.id} has no inputDir`);
	}
	const entries = await fs.readdir(task.inputDir, { withFileTypes: true });
	await Promise.all(
		entries.map(entry =>
			fs.cp(path.join(task.inputDir!, entry.name), path.join(destDir, entry.name), { recursive: true }),
		),
	);
}

export function buildFailureResult(item: TaskRunItem, error: string): TaskRunResult {
	return {
		runIndex: item.runIndex,
		success: false,
		patchApplied: false,
		verificationPassed: false,
		error,
		tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
		duration: 0,
		toolCalls: {
			read: 0,
			edit: 0,
			write: 0,
			editSuccesses: 0,
			editFailures: 0,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 0,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
	};
}

export function shuffle<T>(items: T[]): T[] {
	const copy = items.slice();
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

export async function runConcurrentBenchmarkRun(
	item: TaskRunItem,
	config: BenchmarkConfig,
	tempRoot: string,
	onProgress?: (event: ProgressEvent) => void,
	shared?: SharedInfra,
): Promise<{ task: EditTask; result: TaskRunResult }> {
	const workDir = path.join(tempRoot, `${item.task.id}-${item.runIndex}-${Math.random().toString(36).slice(2, 8)}`);
	await fs.mkdir(workDir, { recursive: true });

	try {
		await copyFixtures(item.task, workDir);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "started" });
		const result = await runSingleTask(
			item.task,
			item.runIndex,
			config,
			workDir,
			item.task.expectedDir,
			shared,
			tempRoot,
		);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	} catch (err) {
		const message = errorMessage(err);
		const result = buildFailureResult(item, message);
		onProgress?.({ taskId: item.task.id, runIndex: item.runIndex, status: "completed", result });
		return { task: item.task, result };
	}
}

export async function runBenchmark(
	tasks: EditTask[],
	config: BenchmarkConfig,
	onProgress?: (event: ProgressEvent) => void,
	onResultSnapshot?: (result: BenchmarkResult) => void,
): Promise<BenchmarkResult> {
	const startTime = new Date().toISOString();
	const tempRoot = path.join(runsDir(), `rb-${Math.random().toString(36).slice(2, 10)}`);
	await fs.mkdir(tempRoot, { recursive: true });

	// Discover shared infrastructure once for in-process mode
	const useInProcess = config.inProcess !== false;
	const shared = useInProcess
		? await discoverSharedInfra({
				editVariant: config.editVariant,
				editFuzzy: config.editFuzzy,
				editFuzzyThreshold: config.editFuzzyThreshold,
			})
		: undefined;

	try {
		const runsPerTask = Math.max(1, Math.floor(config.runsPerTask));
		const taskQueue = shuffle(tasks.slice());
		const resultsByTask = new Map<string, TaskRunResult[]>();
		const concurrency = Math.max(1, Math.floor(config.taskConcurrency));

		const recordResult = (task: EditTask, result: TaskRunResult) => {
			const list = resultsByTask.get(task.id) ?? [];
			list.push(result);
			resultsByTask.set(task.id, list);
			onResultSnapshot?.(buildBenchmarkResult({ tasks, config, resultsByTask, startTime }));
		};

		// Each worker takes one task at a time and launches all N runs for that
		// task concurrently. The best run is chosen later via summarizeTaskRuns;
		// taskConcurrency caps the number of in-flight tasks (not runs).
		const runTaskAllRuns = async (task: EditTask): Promise<void> => {
			const items: TaskRunItem[] = Array.from({ length: runsPerTask }, (_, runIndex) => ({ task, runIndex }));
			await Promise.all(
				items.map(async item => {
					const { result } = await runConcurrentBenchmarkRun(item, config, tempRoot, onProgress, shared);
					recordResult(task, result);
				}),
			);
		};

		const worker = async (): Promise<void> => {
			while (true) {
				const task = taskQueue.shift();
				if (!task) return;
				await runTaskAllRuns(task);
			}
		};

		const slots = Math.min(concurrency, taskQueue.length);
		const running: Promise<void>[] = [];
		for (let i = 0; i < slots; i++) {
			running.push(worker());
		}

		await Promise.all(running);

		return buildBenchmarkResult({ tasks, config, resultsByTask, startTime });
	} finally {
		shared?.authStorage.close();
	}
}
