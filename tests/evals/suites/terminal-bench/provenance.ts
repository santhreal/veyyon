import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@veyyon/utils";
import {
	defaultGitExecutor,
	discoverTerminalBenchTasks,
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

		// A file that could not be read used to hash as the empty buffer, so a half-checked-out
		// dataset produced a content hash indistinguishable from a corpus of empty task files, and
		// that hash was recorded as the provenance of the run. A hash states what it read.
		let tomlBytes: Buffer;
		let instructionBytes: Buffer;
		try {
			tomlBytes = await readFile(tomlPath);
			instructionBytes = await readFile(instructionPath);
		} catch (error) {
			throw new Error(
				`Cannot hash Terminal-Bench task "${taskId}": ${errorMessage(error)}. ` +
					`A content hash covers ${tomlPath} and ${instructionPath}, so an unreadable file is not hashed as empty.`,
				{ cause: error },
			);
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

	// The pinned constant is what the checkout is supposed to be, not what it is. Substituting it
	// for a failed `rev-parse` recorded a commit nobody verified, which is the one field of this
	// record a later reader cannot check for themselves.
	let resolvedSha = options.commitSha;
	if (!resolvedSha) {
		try {
			resolvedSha = await defaultGitExecutor(["rev-parse", "HEAD"], datasetRoot);
		} catch (error) {
			throw new Error(
				`Cannot resolve the commit of the Terminal-Bench checkout at "${datasetRoot}": ${errorMessage(error)}. ` +
					`Provenance states the commit it read, so pass commitSha to record one explicitly.`,
				{ cause: error },
			);
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
