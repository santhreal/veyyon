import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { requirePathSegment } from "../../engine/package-paths";
import { terminalBenchDatasetDir } from "./paths";

const execFileAsync = promisify(execFile);

export const TERMINAL_BENCH_GIT_REMOTE = "https://github.com/harbor-framework/terminal-bench.git";
export const TERMINAL_BENCH_TAG = "v3.0.0";
export const TERMINAL_BENCH_COMMIT_SHA = "2b0442c3c583b710ca8da14c8e601b99f2f1f244";

/**
 * Returns the default cache directory under packages/evals/.cache/datasets/terminal-bench/v3.0.0
 */
export function getDefaultTerminalBenchCacheDir(): string {
	return terminalBenchDatasetDir(TERMINAL_BENCH_TAG);
}

export type GitExecutor = (args: readonly string[], cwd?: string) => Promise<string>;

export async function defaultGitExecutor(args: readonly string[], cwd?: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args as string[], {
		cwd,
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout.trim();
}

export interface AcquireTerminalBenchOptions {
	readonly cacheDir?: string;
	readonly remoteUrl?: string;
	readonly tag?: string;
	readonly commitSha?: string;
	readonly force?: boolean;
	readonly git?: GitExecutor;
}

/**
 * Acquires and pins the Terminal-Bench dataset.
 *
 * Verifies that the resolved git commit SHA matches the pinned SHA exactly.
 * Refuses loudly if the commit SHA does not match.
 */
export async function acquireTerminalBenchDataset(options: AcquireTerminalBenchOptions = {}): Promise<string> {
	const cacheDir = options.cacheDir ?? getDefaultTerminalBenchCacheDir();
	const remoteUrl = options.remoteUrl ?? TERMINAL_BENCH_GIT_REMOTE;
	const tag = options.tag ?? TERMINAL_BENCH_TAG;
	const expectedSha = options.commitSha ?? TERMINAL_BENCH_COMMIT_SHA;
	const git = options.git ?? defaultGitExecutor;

	let alreadyExists = false;
	try {
		const s = await stat(cacheDir);
		if (s.isDirectory()) {
			alreadyExists = true;
		}
	} catch {
		alreadyExists = false;
	}

	if (alreadyExists && !options.force) {
		let actualSha: string;
		try {
			actualSha = await git(["rev-parse", "HEAD"], cacheDir);
		} catch (error) {
			throw new Error(`Failed to verify existing Terminal-Bench dataset at "${cacheDir}": ${String(error)}`, {
				cause: error,
			});
		}

		if (actualSha !== expectedSha) {
			throw new Error(
				`Terminal-Bench dataset at "${cacheDir}" resolved to commit "${actualSha}", ` +
					`expected pinned commit "${expectedSha}". Refusing to run on unpinned or corrupted dataset.`,
			);
		}

		return cacheDir;
	}

	// Clone the repository
	try {
		await git(["clone", "--depth", "1", "--branch", tag, remoteUrl, cacheDir]);
	} catch (error) {
		throw new Error(
			`Failed to clone Terminal-Bench dataset from "${remoteUrl}" at tag "${tag}" into "${cacheDir}": ${String(error)}`,
			{ cause: error },
		);
	}

	// Verify the commit SHA immediately after clone
	let resolvedSha: string;
	try {
		resolvedSha = await git(["rev-parse", "HEAD"], cacheDir);
	} catch (error) {
		throw new Error(
			`Failed to inspect commit SHA of freshly cloned Terminal-Bench dataset at "${cacheDir}": ${String(error)}`,
			{ cause: error },
		);
	}

	if (resolvedSha !== expectedSha) {
		throw new Error(
			`Cloned Terminal-Bench dataset from "${remoteUrl}" at tag "${tag}" resolved to commit "${resolvedSha}", ` +
				`expected pinned commit "${expectedSha}". Refusing acquisition.`,
		);
	}

	return cacheDir;
}

/** Whether a filesystem error means the path is not there, as opposed to not readable. */
function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Discovers all valid task names under the dataset root's `tasks/` directory in stable (sorted) order.
 *
 * A directory that carries no `task.toml` is not a task and is skipped. Anything else is a broken
 * checkout, and it refuses: swallowing it dropped tasks out of the run and out of the corpus hash
 * that states what the run read, leaving a shorter task set recorded as if it were the whole dataset.
 */
export async function discoverTerminalBenchTasks(datasetRoot: string): Promise<readonly string[]> {
	const tasksDir = join(datasetRoot, "tasks");
	let entries: string[];
	try {
		entries = await readdir(tasksDir);
	} catch (error) {
		throw new Error(`Failed to read Terminal-Bench tasks directory at "${tasksDir}": ${String(error)}`, {
			cause: error,
		});
	}

	const taskNames: string[] = [];
	for (const entry of entries) {
		const taskDir = join(tasksDir, entry);
		let entryStat: Stats;
		try {
			entryStat = await stat(taskDir);
		} catch (error) {
			if (isMissing(error)) continue; // removed between the listing and the stat
			throw new Error(`Cannot read Terminal-Bench task directory "${taskDir}": ${String(error)}`, { cause: error });
		}
		if (!entryStat.isDirectory()) continue;
		const configPath = join(taskDir, "task.toml");
		let configStat: Stats;
		try {
			configStat = await stat(configPath);
		} catch (error) {
			if (isMissing(error)) continue; // not a task directory
			throw new Error(`Cannot read Terminal-Bench task config "${configPath}": ${String(error)}`, { cause: error });
		}
		if (!configStat.isFile()) {
			throw new Error(`Terminal-Bench task config "${configPath}" is not a file`);
		}
		taskNames.push(entry);
	}

	if (taskNames.length === 0) {
		throw new Error(`Terminal-Bench dataset at "${datasetRoot}" holds no task under "${tasksDir}"`);
	}
	taskNames.sort();
	return Object.freeze(taskNames);
}

/**
 * Returns the path to a specific task directory.
 *
 * A task id arrives from a task list file, which is data, so it goes through the one path-segment
 * validator before it is joined onto the dataset root.
 */
export function getTerminalBenchTaskDir(datasetRoot: string, taskId: string): string {
	return join(datasetRoot, "tasks", requirePathSegment(taskId, "terminal-bench task id"));
}

/**
 * Returns the path to a task's task.toml file.
 */
export function getTerminalBenchTaskConfigPath(datasetRoot: string, taskId: string): string {
	return join(getTerminalBenchTaskDir(datasetRoot, taskId), "task.toml");
}

/**
 * Returns the path to a task's instruction.md file.
 */
export function getTerminalBenchTaskInstructionPath(datasetRoot: string, taskId: string): string {
	return join(getTerminalBenchTaskDir(datasetRoot, taskId), "instruction.md");
}
