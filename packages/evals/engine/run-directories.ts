/**
 * The three directories every run reaches, checked before a trial starts.
 *
 * A run writes its journal and artifacts under the runs directory, executes trials with
 * the work directory as their root, and reads a suite's corpus from the dataset directory.
 * Without this check each one fails late and in a different voice: an `fs.mkdir` ENOTDIR
 * after preflight said `ok`, a backend spawning in a directory that does not exist, or a
 * raw `ENOENT: ... scandir ...` from a suite's discovery pass. All three are decidable
 * before anything runs, which is where they are decided.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Every directory a run reaches, as a value rather than a bare union, so a caller — and
 * the suite that covers this module — sweeps the roles instead of restating them.
 */
export const RUN_DIRECTORY_ROLES = ["runs-dir", "work-dir", "dataset-dir"] as const;

export type RunDirectoryRole = (typeof RUN_DIRECTORY_ROLES)[number];

export class UnusableRunDirectoryError extends Error {
	readonly role: RunDirectoryRole;
	readonly directory: string;
	readonly reason: string;

	constructor(role: RunDirectoryRole, directory: string, reason: string) {
		super(`${role} ${directory} ${reason}.`);
		this.name = "UnusableRunDirectoryError";
		this.role = role;
		this.directory = directory;
		this.reason = reason;
	}
}

export interface RunDirectories {
	/** Where the run journal and artifacts are written. Created when absent. */
	readonly runsDir: string;
	/** Where trials execute. Must already exist. */
	readonly workDir: string;
	/** A suite's corpus, when the caller named one. Must already exist. */
	readonly datasetDir?: string | undefined;
}

async function statOrNull(target: string): Promise<{ isDirectory: boolean } | null> {
	try {
		const info = await fs.stat(target);
		return { isDirectory: info.isDirectory() };
	} catch {
		return null;
	}
}

async function isWritable(target: string): Promise<boolean> {
	try {
		await fs.access(target, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The nearest ancestor of `target` that exists, or null when even the filesystem root
 * cannot be read. A run directory is created recursively, so the ancestor is what decides
 * whether that creation can succeed.
 */
async function nearestExisting(target: string): Promise<string | null> {
	let current = target;
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current) return null;
		if ((await statOrNull(parent)) !== null) return parent;
		current = parent;
	}
}

/** The work directory: trials execute with it as their root, so it must already exist. */
async function checkWorkDir(directory: string): Promise<UnusableRunDirectoryError | null> {
	const info = await statOrNull(directory);
	if (info === null) return new UnusableRunDirectoryError("work-dir", directory, "does not exist");
	if (!info.isDirectory) return new UnusableRunDirectoryError("work-dir", directory, "is not a directory");
	try {
		await fs.access(directory, fsConstants.R_OK | fsConstants.X_OK);
	} catch {
		return new UnusableRunDirectoryError("work-dir", directory, "is not readable");
	}
	return null;
}

/**
 * A suite's corpus. It is a directory for every suite but typescript-edit, which also
 * accepts a `.tar`/`.tar.gz` archive, so the shape a suite can read is the suite's
 * decision and existence is this check's. What no suite can read is a path that is not
 * there, which is what a mistyped --dataset-dir produces.
 */
async function checkDatasetPath(target: string): Promise<UnusableRunDirectoryError | null> {
	const info = await statOrNull(target);
	if (info === null) return new UnusableRunDirectoryError("dataset-dir", target, "does not exist");
	const mode = info.isDirectory ? fsConstants.R_OK | fsConstants.X_OK : fsConstants.R_OK;
	try {
		await fs.access(target, mode);
	} catch {
		return new UnusableRunDirectoryError("dataset-dir", target, "is not readable");
	}
	return null;
}

/** The runs directory: created when absent, so its nearest existing ancestor decides. */
async function checkRunsDir(directory: string): Promise<UnusableRunDirectoryError | null> {
	const info = await statOrNull(directory);
	if (info !== null) {
		if (!info.isDirectory) return new UnusableRunDirectoryError("runs-dir", directory, "is not a directory");
		if (!(await isWritable(directory)))
			return new UnusableRunDirectoryError("runs-dir", directory, "is not writable");
		return null;
	}
	const ancestor = await nearestExisting(directory);
	if (ancestor === null) {
		return new UnusableRunDirectoryError("runs-dir", directory, "cannot be created: no parent of it exists");
	}
	const ancestorInfo = await statOrNull(ancestor);
	if (ancestorInfo?.isDirectory !== true) {
		return new UnusableRunDirectoryError("runs-dir", directory, `cannot be created: ${ancestor} is not a directory`);
	}
	if (!(await isWritable(ancestor))) {
		return new UnusableRunDirectoryError("runs-dir", directory, `cannot be created: ${ancestor} is not writable`);
	}
	return null;
}

/**
 * Every directory problem this invocation holds, in a fixed order, so a dry run states
 * all of them instead of one per attempt.
 */
export async function checkRunDirectories(dirs: RunDirectories): Promise<readonly UnusableRunDirectoryError[]> {
	const problems: UnusableRunDirectoryError[] = [];
	const runs = await checkRunsDir(dirs.runsDir);
	if (runs !== null) problems.push(runs);
	const work = await checkWorkDir(dirs.workDir);
	if (work !== null) problems.push(work);
	if (dirs.datasetDir !== undefined) {
		const dataset = await checkDatasetPath(dirs.datasetDir);
		if (dataset !== null) problems.push(dataset);
	}
	return problems;
}

/** Throws the first problem `checkRunDirectories` found. */
export async function requireRunDirectories(dirs: RunDirectories): Promise<void> {
	const problems = await checkRunDirectories(dirs);
	const first = problems[0];
	if (first !== undefined) throw first;
}
