/**
 * HEAD, read from the files git writes, without running git.
 *
 * `git.ts` reaches a repository two ways: by reading `.git` directly, and by
 * spawning the binary. Everything that can be answered from a file lives here,
 * so a caller that must not spawn a process — the launch card paints the
 * status row before the session exists, on the loop turn that owes the
 * terminal a frame — can import this module without importing the process
 * layer, the commit diff parser or the tool-error types beside it.
 *
 * The spawning half stays in `git.ts`, which composes the two: a reftable
 * repository has no ref FILES to read, so this module reports it cannot
 * answer and `git.ts` falls back to `git symbolic-ref`.
 *
 * One owner per question. `git.ts` calls these functions rather than keeping
 * a second copy of them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEisdir, isEnoent, isEnotdir } from "@veyyon/utils/fs-error";

export const HEAD_REF_PREFIX = "ref:";
export const LOCAL_BRANCH_PREFIX = "refs/heads/";

export interface GitRepository {
	commonDir: string;
	gitDir: string;
	gitEntryPath: string;
	headPath: string;
	repoRoot: string;
	isReftable?: boolean;
}

interface GitHeadBase extends GitRepository {
	headContent: string;
}

export interface GitRefHead extends GitHeadBase {
	branchName: string | null;
	commit: string | null;
	kind: "ref";
	ref: string;
}

export interface GitDetachedHead extends GitHeadBase {
	commit: string | null;
	kind: "detached";
}

export type GitHeadState = GitRefHead | GitDetachedHead;

/**
 * A multi-step git operation that is part-way through.
 *
 * These matter because HEAD alone does not describe them. A conflicted merge
 * leaves HEAD on its branch, so the repository looks ordinary while every
 * command behaves differently. A rebase is worse: it detaches HEAD, so the
 * branch you are rebasing disappears from view and the only honest thing HEAD
 * can say is "detached".
 */
export type GitOperationKind = "am" | "bisect" | "cherry-pick" | "merge" | "rebase" | "revert";

export interface GitInProgressOperation {
	kind: GitOperationKind;
	/**
	 * The branch the operation will return to, when git records one.
	 *
	 * A rebase writes the original branch to `head-name`, which is the only way
	 * to recover it while HEAD is detached. `null` when git records nothing,
	 * which includes rebasing a detached HEAD, and callers must handle it rather
	 * than assume a name is always available.
	 */
	branch: string | null;
}

export type EntryType = "directory" | "file";

/**
 * Bounded retry for synchronous I/O against `EINTR`. POSIX permits short syscalls
 * to be interrupted by signals; when that happens libc traditionally retries.
 * Node's sync wrappers surface the raw `EINTR` so we replicate the retry locally.
 * Any other error (and persistent EINTR after `EINTR_MAX_RETRIES`) is rethrown
 * for the caller's normal "optional metadata" classifier to handle.
 */
export const EINTR_MAX_RETRIES = 3;

export function shouldRetry(err: unknown, n: number): boolean {
	if (isEnoent(err) || isEisdir(err) || isEnotdir(err) || hasFsCode(err, "ENFILE") || hasFsCode(err, "EMFILE"))
		return false;
	if (hasFsCode(err, "EINTR")) return n < EINTR_MAX_RETRIES;
	if (n > EINTR_MAX_RETRIES) throw err;
	throw err;
}

export function retryOnEintrSync<T>(op: () => T): T | null {
	for (let attempt = 0; attempt <= EINTR_MAX_RETRIES; attempt += 1) {
		try {
			return op();
		} catch (err) {
			if (shouldRetry(err, attempt)) continue;
			return null;
		}
	}
	throw new Error("retryOnEintrSync: exhausted without resolution");
}

export function getEntryTypeSync(gitEntryPath: string): EntryType | null {
	return retryOnEintrSync(() => {
		const stat = fs.statSync(gitEntryPath);
		if (stat.isDirectory()) return "directory";
		if (stat.isFile()) return "file";
		return null;
	});
}

export function readOptionalTextSync(filePath: string): string | null {
	return retryOnEintrSync(() => fs.readFileSync(filePath, "utf8"));
}

export function parseGitDirPointer(content: string): string | null {
	const match = /^gitdir:\s*(.+)\s*$/iu.exec(content.trim());
	return match?.[1] ?? null;
}

function resolveGitDirSync(gitEntryPath: string, entryType: EntryType): string | null {
	if (entryType === "directory") return gitEntryPath;
	const content = readOptionalTextSync(gitEntryPath);
	if (content === null) return null;
	const parsed = parseGitDirPointer(content);
	if (!parsed) return null;
	const gitDir = path.resolve(path.dirname(gitEntryPath), parsed);
	return getEntryTypeSync(gitDir) === "directory" ? gitDir : null;
}

export function resolveCommonDirSync(gitDir: string): string {
	const content = readOptionalTextSync(path.join(gitDir, "commondir"));
	const relative = content?.trim();
	if (!relative) return gitDir;
	return path.resolve(gitDir, relative);
}

function resolveRepoFromEntrySync(repoRoot: string, gitEntryPath: string, entryType: EntryType): GitRepository | null {
	const gitDir = resolveGitDirSync(gitEntryPath, entryType);
	if (!gitDir) return null;
	return {
		commonDir: resolveCommonDirSync(gitDir),
		gitDir,
		gitEntryPath,
		headPath: path.join(gitDir, "HEAD"),
		repoRoot,
	};
}

export function resolveRepositorySync(startDir: string): GitRepository | null {
	let current = path.resolve(startDir);
	while (true) {
		const gitEntryPath = path.join(current, ".git");
		const entryType = getEntryTypeSync(gitEntryPath);
		if (entryType) {
			const repository = resolveRepoFromEntrySync(current, gitEntryPath, entryType);
			if (repository) return repository;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function getRefLookupDirs(repository: GitRepository): string[] {
	if (repository.gitDir === repository.commonDir) return [repository.gitDir];
	return [repository.gitDir, repository.commonDir];
}

export function normalizeRefValue(content: string | null): string | null {
	const trimmed = content?.trim() ?? "";
	return trimmed || null;
}

export function parsePackedRefs(content: string | null, targetRef: string): string | null {
	if (!content) return null;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
		const [sha, refName] = trimmed.split(" ", 2);
		if (refName === targetRef && sha) return sha;
	}
	return null;
}

function stripGitConfigComments(line: string): string {
	let clean = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
			clean += char;
		} else if (!inQuotes && (char === ";" || char === "#")) {
			break;
		} else {
			clean += char;
		}
	}
	return clean.trim();
}

export function parseGitConfigHasReftable(content: string): boolean {
	let inExtensions = false;
	for (const line of content.split("\n")) {
		const trimmed = stripGitConfigComments(line);
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const section = trimmed.slice(1, -1).trim().toLowerCase();
			inExtensions = section === "extensions";
		} else if (inExtensions) {
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex !== -1) {
				const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
				let value = trimmed.slice(eqIndex + 1).trim();
				if (key === "refstorage") {
					if (value.startsWith('"') && value.endsWith('"')) {
						value = value.slice(1, -1).trim();
					}
					const lowerValue = value.toLowerCase();
					if (lowerValue === "reftable" || lowerValue.startsWith("reftable:")) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

export function isReftableRepoSync(repository: GitRepository): boolean {
	if (repository.isReftable !== undefined) return repository.isReftable;
	const configPath = path.join(repository.commonDir, "config");
	const content = readOptionalTextSync(configPath);
	repository.isReftable = content ? parseGitConfigHasReftable(content) : false;
	return repository.isReftable;
}

/** A ref's value from the loose file, then from `packed-refs`. Reftable repositories keep neither. */
export function readRefFromFiles(repository: GitRepository, targetRef: string): string | null {
	for (const dir of getRefLookupDirs(repository)) {
		const value = normalizeRefValue(readOptionalTextSync(path.join(dir, targetRef)));
		if (value) return value;
	}
	for (const dir of getRefLookupDirs(repository)) {
		const value = parsePackedRefs(readOptionalTextSync(path.join(dir, "packed-refs")), targetRef);
		if (value) return value;
	}
	return null;
}

export function parseHeadStateFromFiles(repository: GitRepository, headContent: string): GitHeadState {
	const trimmed = headContent.trim();
	if (!trimmed?.startsWith(HEAD_REF_PREFIX)) {
		return { ...repository, commit: trimmed || null, headContent, kind: "detached" };
	}
	const refValue = trimmed.slice(HEAD_REF_PREFIX.length).trim();
	const branchName = refValue.startsWith(LOCAL_BRANCH_PREFIX) ? refValue.slice(LOCAL_BRANCH_PREFIX.length) : null;
	return {
		...repository,
		branchName,
		commit: readRefFromFiles(repository, refValue),
		headContent,
		kind: "ref",
		ref: refValue,
	};
}

/**
 * Read the branch a rebase or am recorded, as a bare branch name.
 *
 * git writes the full ref (`refs/heads/topic`) and occasionally the literal
 * `detached HEAD` when there was no branch to begin with, which must come back
 * as `null` rather than being shown to a user as if it were a branch called
 * "detached HEAD".
 */
function readOperationHeadName(directory: string): string | null {
	const raw = readOptionalTextSync(path.join(directory, "head-name"))?.trim();
	if (!raw?.startsWith(LOCAL_BRANCH_PREFIX)) return null;
	return raw.slice(LOCAL_BRANCH_PREFIX.length) || null;
}

/**
 * Which multi-step operation, if any, is part-way through in this repository.
 *
 * Detection is by the marker files git itself uses, and the ORDER is load
 * bearing rather than arbitrary. A conflicted rebase leaves both its own state
 * directory and, while a conflict is being resolved, marker files that a bare
 * merge or cherry-pick would also write, so the enclosing operation has to be
 * reported or the status line would announce a merge in the middle of a rebase.
 * `git`'s own status output resolves the same ambiguity the same way.
 *
 * `rebase-apply` is shared between `git rebase` and `git am`, which are told
 * apart by the `applying` marker that only am writes. Reporting an am as a
 * rebase would send a user to `git rebase --abort`, which does not apply.
 *
 * Cost is bounded and small, a handful of stats against the git directory, with
 * no subprocess: this runs on the status line's synchronous path, where
 * spawning `git` per render is exactly what must not happen.
 */
export function resolveInProgressOperation(repository: GitRepository): GitInProgressOperation | null {
	const gitDir = repository.gitDir;
	const rebaseMerge = path.join(gitDir, "rebase-merge");
	if (fs.existsSync(rebaseMerge)) {
		return { branch: readOperationHeadName(rebaseMerge), kind: "rebase" };
	}
	const rebaseApply = path.join(gitDir, "rebase-apply");
	if (fs.existsSync(rebaseApply)) {
		const isAm = fs.existsSync(path.join(rebaseApply, "applying"));
		return { branch: readOperationHeadName(rebaseApply), kind: isAm ? "am" : "rebase" };
	}
	// These leave HEAD alone, so the branch is whatever HEAD already says and
	// there is nothing to recover.
	if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return { branch: null, kind: "merge" };
	if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return { branch: null, kind: "cherry-pick" };
	if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) return { branch: null, kind: "revert" };
	if (fs.existsSync(path.join(gitDir, "BISECT_LOG"))) return { branch: null, kind: "bisect" };
	return null;
}

/**
 * How to name this checkout in one short label.
 *
 * The ONE owner of that phrasing. It was previously written inline at the
 * status line as `branchName ?? ref`, falling back to the bare string
 * "detached", which is wrong in the case that matters most: a rebase detaches
 * HEAD, so a user mid-rebase saw "detached" with neither the branch they were
 * rebasing nor any hint that a rebase was running. Recovering the branch from
 * the operation's own record and appending the operation is what git's status
 * output does, and what a reader already expects from a prompt.
 *
 * Shape is `branch|OPERATION`, e.g. `topic|REBASE`, and just `branch` when
 * nothing is in progress. A detached HEAD with no operation stays `detached`.
 */
export function headLabel(state: GitHeadState, operation: GitInProgressOperation | null): string {
	const fromHead = state.kind === "ref" ? (state.branchName ?? state.ref) : null;
	// The operation's recorded branch wins ONLY when HEAD cannot supply one,
	// which is the detached-during-rebase case. When HEAD is on a branch it is
	// the truth and the recorded name is at best a duplicate.
	const branch = fromHead ?? operation?.branch ?? "detached";
	return operation ? `${branch}|${operation.kind.toUpperCase()}` : branch;
}

/**
 * The branch name to look things up BY, or `null` when there is not one.
 *
 * Deliberately separate from {@link headLabel}. A label is for a human to read
 * and is decorated (`topic|REBASE`); handing that same string to a pull
 * request lookup would query a branch that does not exist. The two were one
 * value before, which worked only because the sole decoration was the literal
 * "detached" and the lookup special-cased that exact word.
 *
 * Returns `null` while an operation is in progress even though a branch name
 * may be recoverable: mid-rebase the branch does not yet point where it will,
 * so a pull request looked up against it describes a state that is about to
 * change.
 */
export function headBranchForLookup(state: GitHeadState, operation: GitInProgressOperation | null): string | null {
	if (operation) return null;
	if (state.kind !== "ref") return null;
	return state.branchName;
}

/**
 * HEAD, or `null` when it cannot be answered from files.
 *
 * Two different `null`s, deliberately not distinguished: there is no
 * repository here, or there is one whose refs live in a reftable and only the
 * binary can read them. Both mean the same thing to a caller that will not
 * spawn — it has no branch to show — and `git.ts` re-asks the reftable case
 * through the binary for callers that can afford to.
 */
export function resolveHeadStateFromFiles(cwd: string): GitHeadState | null {
	const repository = resolveRepositorySync(cwd);
	if (!repository) return null;
	if (isReftableRepoSync(repository)) return null;
	const content = readOptionalTextSync(repository.headPath);
	if (content === null) return null;
	return parseHeadStateFromFiles(repository, content);
}

/**
 * The branch to put on a status row, without running git.
 *
 * `null` when there is no repository, when its refs are in a reftable, or when
 * HEAD is detached with no operation to recover a name from — a row shows
 * nothing rather than the word "detached" it cannot act on.
 */
export function branchLabelFromFiles(cwd: string): string | null {
	const state = resolveHeadStateFromFiles(cwd);
	if (!state) return null;
	const operation = resolveInProgressOperation(state);
	const label = headLabel(state, operation);
	return label === "detached" ? null : label;
}
