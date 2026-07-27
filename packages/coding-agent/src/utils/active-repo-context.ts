/**
 * Recognising a cwd that is not itself a repository but holds exactly one.
 *
 * This is the "you opened the parent directory of your project" case: the agent starts in a folder that
 * is not under version control, one of its direct children is, and everything the user means by "the
 * repository" lives in there. The prompt and the status line both want to know about it.
 *
 * The RULE lives in {@link singleChildRepo} and nowhere else. Exactly one direct child may be a
 * repository: zero means there is nothing to point at, and two or more means guessing which one the user
 * meant, which is worse than saying nothing. Everything else in this file is the two ways of gathering
 * the same facts -- one asynchronous for the prompt, which prepares it under a deadline, and one
 * synchronous for the status line, which renders without an await. Those two gatherers used to carry a
 * copy of the rule each, which is two chances for them to answer differently for the same directory.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { errorMessage, isEnoent, logger } from "@veyyon/utils";

import { type GitRepository, repo } from "./git";

export interface ActiveRepoContext {
	cwd: string;
	repoRoot: string;
	relativeRepoRoot: string;
	source: "single-direct-child-repo";
}

function compareEntryNames(left: fs.Dirent, right: fs.Dirent): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function buildContext(cwd: string, repoRoot: string): ActiveRepoContext {
	const resolvedCwd = path.resolve(cwd);
	const resolvedRepoRoot = path.resolve(repoRoot);
	return {
		cwd: resolvedCwd,
		repoRoot: resolvedRepoRoot,
		relativeRepoRoot: path.relative(resolvedCwd, resolvedRepoRoot),
		source: "single-direct-child-repo",
	};
}

/**
 * The rule, in one place: a context only when EXACTLY ONE direct child is a repository.
 *
 * Both gatherers hand their candidates here rather than deciding for themselves. Ambiguity has to answer
 * null, because naming one of several sibling repositories as "the" repository would put a confidently
 * wrong path in the prompt and in the status line, and the user has no way to see where it came from.
 */
function singleChildRepo(cwd: string, repoChildPaths: string[]): ActiveRepoContext | null {
	const only = repoChildPaths.length === 1 ? repoChildPaths[0] : undefined;
	return only === undefined ? null : buildContext(cwd, only);
}

/**
 * Report a cwd that could not be listed, which is the one failure here that changes the answer.
 *
 * An absent directory is silent: a cwd can be removed while a session is open, and the caller's answer
 * of "no active repository" is then simply correct. Anything else -- most often a directory this process
 * cannot read -- produced the SAME empty listing, so the detection quietly gave up and both the prompt
 * and the status line showed no repository at all, with nothing anywhere saying the check never ran.
 * The empty listing is still what the caller gets, because neither surface may fail over this.
 */
function reportUnlistableCwd(cwd: string, error: unknown): void {
	if (isEnoent(error)) return;
	logger.warn("The working directory could not be listed; a repository inside it will not be detected", {
		cwd,
		error: errorMessage(error),
	});
}

async function resolveRepository(cwd: string): Promise<GitRepository | null> {
	try {
		return await repo.resolve(cwd);
	} catch {
		// Null means "cwd is not inside a repository", and this resolution is a filesystem walk up the
		// directory chain, so a failure at any level means the same thing to the caller: keep looking for a
		// repository BELOW instead. A wrong answer here costs nothing, since the child scan is next.
		return null;
	}
}

function resolveRepositorySync(cwd: string): GitRepository | null {
	try {
		return repo.resolveSync(cwd);
	} catch {
		// Same verdict as the asynchronous twin above.
		return null;
	}
}

async function readDirectChildren(cwd: string): Promise<fs.Dirent[]> {
	try {
		const entries = await fsPromises.readdir(cwd, { withFileTypes: true });
		entries.sort(compareEntryNames);
		return entries;
	} catch (err) {
		reportUnlistableCwd(cwd, err);
		return [];
	}
}

function readDirectChildrenSync(cwd: string): fs.Dirent[] {
	try {
		const entries = fs.readdirSync(cwd, { withFileTypes: true });
		entries.sort(compareEntryNames);
		return entries;
	} catch (err) {
		reportUnlistableCwd(cwd, err);
		return [];
	}
}

async function resolveDirectChildDirectory(cwd: string, entry: fs.Dirent): Promise<string | null> {
	const childPath = path.join(cwd, entry.name);
	if (entry.isDirectory()) return childPath;
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = await fsPromises.stat(childPath);
		return stat.isDirectory() ? childPath : null;
	} catch {
		// A symlink that cannot be followed -- dangling, or pointing somewhere unreadable -- is not a
		// directory this scan can look inside, which is exactly what null says. Nothing is hidden: a link
		// that leads nowhere cannot hold the repository the user meant.
		return null;
	}
}

function resolveDirectChildDirectorySync(cwd: string, entry: fs.Dirent): string | null {
	const childPath = path.join(cwd, entry.name);
	if (entry.isDirectory()) return childPath;
	if (!entry.isSymbolicLink()) return null;
	try {
		const stat = fs.statSync(childPath);
		return stat.isDirectory() ? childPath : null;
	} catch {
		// Same verdict as the asynchronous twin above.
		return null;
	}
}

async function hasGitMarker(childPath: string): Promise<boolean> {
	try {
		const stat = await fsPromises.stat(path.join(childPath, ".git"));
		return stat.isDirectory() || stat.isFile();
	} catch {
		// No `.git` entry, so not a repository root. Absence is the ordinary answer here -- most children of
		// a project folder are not repositories -- and a child whose `.git` cannot be stat'ed is one this
		// session could not use as a repository anyway.
		return false;
	}
}

function hasGitMarkerSync(childPath: string): boolean {
	try {
		const stat = fs.statSync(path.join(childPath, ".git"));
		return stat.isDirectory() || stat.isFile();
	} catch {
		// Same verdict as the asynchronous twin above.
		return false;
	}
}

async function findSingleDirectChildRepo(cwd: string): Promise<ActiveRepoContext | null> {
	const repoChildPaths: string[] = [];
	for (const entry of await readDirectChildren(cwd)) {
		const childPath = await resolveDirectChildDirectory(cwd, entry);
		if (!childPath) continue;
		if (!(await hasGitMarker(childPath))) continue;
		repoChildPaths.push(childPath);
		// Two is already ambiguous, so there is nothing to learn from a third.
		if (repoChildPaths.length > 1) break;
	}
	return singleChildRepo(cwd, repoChildPaths);
}

function findSingleDirectChildRepoSync(cwd: string): ActiveRepoContext | null {
	const repoChildPaths: string[] = [];
	for (const entry of readDirectChildrenSync(cwd)) {
		const childPath = resolveDirectChildDirectorySync(cwd, entry);
		if (!childPath) continue;
		if (!hasGitMarkerSync(childPath)) continue;
		repoChildPaths.push(childPath);
		if (repoChildPaths.length > 1) break;
	}
	return singleChildRepo(cwd, repoChildPaths);
}

export async function resolveActiveRepoContext(cwd: string): Promise<ActiveRepoContext | null> {
	const resolvedCwd = path.resolve(cwd);
	if (await resolveRepository(resolvedCwd)) return null;
	return findSingleDirectChildRepo(resolvedCwd);
}

export function resolveActiveRepoContextSync(cwd: string): ActiveRepoContext | null {
	const resolvedCwd = path.resolve(cwd);
	if (resolveRepositorySync(resolvedCwd)) return null;
	return findSingleDirectChildRepoSync(resolvedCwd);
}
