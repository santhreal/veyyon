import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { terminalBenchDatasetDir } from "../../paths";

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

/**
 * Discovers all valid task names under the dataset root's `tasks/` directory in stable (sorted) order.
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
		try {
			const s = await stat(taskDir);
			if (!s.isDirectory()) {
				continue;
			}
			const configPath = join(taskDir, "task.toml");
			const configStat = await stat(configPath);
			if (configStat.isFile()) {
				taskNames.push(entry);
			}
		} catch {}
	}

	taskNames.sort();
	return Object.freeze(taskNames);
}

/**
 * Returns the path to a specific task directory.
 */
export function getTerminalBenchTaskDir(datasetRoot: string, taskId: string): string {
	return join(datasetRoot, "tasks", taskId);
}

/**
 * Returns the path to a task's task.toml file.
 */
export function getTerminalBenchTaskConfigPath(datasetRoot: string, taskId: string): string {
	return join(datasetRoot, "tasks", taskId, "task.toml");
}

/**
 * Returns the path to a task's instruction.md file.
 */
export function getTerminalBenchTaskInstructionPath(datasetRoot: string, taskId: string): string {
	return join(datasetRoot, "tasks", taskId, "instruction.md");
}
