import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	defaultGitExecutor,
	discoverTerminalBenchTasks,
	TERMINAL_BENCH_COMMIT_SHA,
	TERMINAL_BENCH_GIT_REMOTE,
	TERMINAL_BENCH_TAG,
} from "./dataset";
import { TERMINAL_BENCH_SUITE_NAME } from "./paths";

export interface TerminalBenchProvenance {
	readonly suiteName: typeof TERMINAL_BENCH_SUITE_NAME;
	readonly version: string;
	readonly gitRemote: string;
	readonly resolvedCommitSha: string;
	readonly taskCount: number;
	readonly selectedTasks: readonly string[];
	readonly contentHash: string;
	readonly timestamp: string;
}

export interface ComputeTerminalBenchProvenanceOptions {
	readonly datasetRoot: string;
	readonly selectedTasks?: readonly string[];
	readonly version?: string;
	readonly gitRemote?: string;
	readonly commitSha?: string;
	readonly timestamp?: string;
}

/**
 * Computes a deterministic SHA-256 content hash over a set of task directories.
 * Hashes task.toml and instruction.md for each task in sorted order.
 */
export async function computeTaskSetContentHash(datasetRoot: string, tasks: readonly string[]): Promise<string> {
	const sortedTasks = [...tasks].sort();
	const hasher = createHash("sha256");

	for (const taskId of sortedTasks) {
		const taskDir = join(datasetRoot, "tasks", taskId);
		const tomlPath = join(taskDir, "task.toml");
		const instructionPath = join(taskDir, "instruction.md");

		let tomlBytes = Buffer.alloc(0);
		try {
			tomlBytes = await readFile(tomlPath);
		} catch {
			// task.toml missing
		}

		let instructionBytes = Buffer.alloc(0);
		try {
			instructionBytes = await readFile(instructionPath);
		} catch {
			// instruction.md missing
		}

		const taskHasher = createHash("sha256");
		taskHasher.update(tomlBytes);
		const tomlSha = taskHasher.digest("hex");

		const instHasher = createHash("sha256");
		instHasher.update(instructionBytes);
		const instSha = instHasher.digest("hex");

		hasher.update(`${taskId}:${tomlSha}:${instSha}\n`);
	}

	return hasher.digest("hex");
}

/**
 * Computes the complete dataset provenance for a Terminal-Bench run.
 */
export async function computeTerminalBenchProvenance(
	options: ComputeTerminalBenchProvenanceOptions,
): Promise<TerminalBenchProvenance> {
	const { datasetRoot } = options;
	const selectedTasks = options.selectedTasks
		? [...options.selectedTasks].sort()
		: await discoverTerminalBenchTasks(datasetRoot);

	let resolvedSha = options.commitSha;
	if (!resolvedSha) {
		try {
			resolvedSha = await defaultGitExecutor(["rev-parse", "HEAD"], datasetRoot);
		} catch {
			resolvedSha = TERMINAL_BENCH_COMMIT_SHA;
		}
	}

	const contentHash = await computeTaskSetContentHash(datasetRoot, selectedTasks);

	return Object.freeze({
		suiteName: TERMINAL_BENCH_SUITE_NAME,
		version: options.version ?? TERMINAL_BENCH_TAG,
		gitRemote: options.gitRemote ?? TERMINAL_BENCH_GIT_REMOTE,
		resolvedCommitSha: resolvedSha,
		taskCount: selectedTasks.length,
		selectedTasks: Object.freeze(selectedTasks),
		contentHash,
		timestamp: options.timestamp ?? new Date().toISOString(),
	});
}
