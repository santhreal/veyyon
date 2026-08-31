/**
 * CLI handler for `veyyon worktree` — list and clean up agent-managed worktrees.
 *
 * Layout under `~/.veyyon/wt/`:
 *
 *   - **PR-checkout worktrees** (`tools/gh.ts`): a regular git worktree dir
 *     containing a `.git` *file* that points back at
 *     `<parent-repo>/.git/worktrees/<name>/`.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. These are ephemeral; `ensureIsolation`
 *     removes the base before re-creating it, so leftovers are crashed runs.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, formatCount, getWorktreesDir, isEnoent } from "@veyyon/utils";
import chalk from "chalk";
import * as git from "../utils/git";

type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.veyyon/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** When set, the entry is unhealthy and `veyyon worktree clear` will remove it. */
	orphanReason?: string;
	/**
	 * When set, something on disk could not be READ, so this entry's health is unknown.
	 *
	 * Kept strictly separate from `orphanReason`: an entry with an unknown state must never be deleted, and
	 * `clear` selects its targets by `orphanReason` alone. The text names the path and the underlying error so
	 * the operator can fix the permission or remount the volume and re-run.
	 */
	undeterminedReason?: string;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every entry, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No agent-managed worktrees found under ${getWorktreesDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason
			? chalk.yellow("orphaned")
			: entry.undeterminedReason
				? chalk.red("unknown ")
				: chalk.green("live    ");
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(`\n${live} live · ${orphaned} orphaned · ${entries.length} total`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
		return;
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${formatCount("dir", targets.length)} would be removed.`));
		}
		return;
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	const parentsToPrune = new Set<string>();
	for (const target of targets) {
		try {
			if (target.kind === "pr-checkout" && target.parentRepo && !target.orphanReason) {
				// Live worktree: ask git to remove it cleanly. If git refuses (locked,
				// dirty, etc.), fall back to fs.rm and rely on `worktree prune` to
				// clean the bookkeeping on the parent side.
				const removed = await git.worktree.tryRemove(target.parentRepo, target.path, { force: true });
				if (!removed) {
					await fs.rm(target.path, { recursive: true, force: true });
					parentsToPrune.add(target.parentRepo);
				}
			} else {
				await fs.rm(target.path, { recursive: true, force: true });
				if (target.parentRepo) parentsToPrune.add(target.parentRepo);
			}
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: errorMessage(err) });
		}
	}

	// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
	for (const parent of parentsToPrune) {
		try {
			await git.worktree.prune(parent);
		} catch {
			/* parent repo may already be gone or pruned — ignore */
		}
	}

	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	for (const result of results) {
		if (result.ok) {
			console.log(`${chalk.green("removed")}  ${result.path}`);
		} else {
			console.log(`${chalk.red("failed ")}  ${result.path}`);
			if (result.error) console.log(`          ${chalk.dim(result.error)}`);
		}
	}
	console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	if (failed > 0) process.exitCode = 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await statPath(dir);
		if (!stat) {
			// Unreadable, so its kind is unknown and it must not be swept. Surfaced, never dropped.
			entries.push({ path: dir, kind: "stray", undeterminedReason: `cannot stat ${dir}` });
			continue;
		}
		if (!stat.found?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.veyyon/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await statPath(childDir);
			if (!childStat) {
				entries.push({ path: childDir, kind: "stray", undeterminedReason: `cannot stat ${childDir}` });
				nested += 1;
				continue;
			}
			if (!childStat.found?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

/**
 * Stat a path, distinguishing "not there" from "could not look".
 *
 * This distinction decides whether files get DELETED. `veyyon worktree clear` removes every entry that
 * carries an `orphanReason`, and each orphan verdict below is reached by failing to stat something: a
 * missing `.git`, a parent repo that no longer tracks the worktree, a parent repo that is gone. When a
 * blanket `.catch(() => null)` collapsed both cases, a stat that failed for any other reason -- EACCES on
 * the parent repo, or a network volume that was briefly unreachable, which is the normal state of a repo
 * living on a mount -- read as "missing", and a LIVE worktree was reported as "parent repo missing" and
 * then deleted. Returning `undefined` for the unreadable case lets each caller fail closed toward keeping
 * the user's files.
 */
async function statPath(target: string): Promise<{ found: Stats | null } | undefined> {
	try {
		return { found: await fs.stat(target) };
	} catch (error) {
		if (isEnoent(error)) return { found: null };
		return undefined;
	}
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await statPath(gitEntry);
	if (!gitStat) {
		return { path: dir, kind: "stray", undeterminedReason: `cannot stat ${gitEntry}` };
	}
	if (gitStat.found?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
		const mountPath = path.join(dir, mountDir);
		const mountStat = await statPath(mountPath);
		if (!mountStat) {
			return { path: dir, kind: "task-isolation", undeterminedReason: `cannot stat ${mountPath}` };
		}
		if (!mountStat.found?.isDirectory()) continue;
		return {
			path: dir,
			kind: "task-isolation",
			orphanReason: "task-isolation leftover (no live task owns it)",
		};
	}
	return null;
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${errorMessage(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await statPath(parentGitDir);
	if (!parentDirStat) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			undeterminedReason: `cannot stat ${parentGitDir}`,
		};
	}
	if (!parentDirStat.found?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await statPath(parentRepo);
	if (!parentRepoStat) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			undeterminedReason: `cannot stat ${parentRepo}`,
		};
	}
	if (!parentRepoStat.found?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

/**
 * The branch a worktree has checked out, or undefined when it has none to name.
 *
 * Undefined already covers a detached HEAD, which the regex declines to match, so a HEAD file that cannot
 * be read reaches the same answer the listing already handles by showing the worktree without a branch.
 * The worktree itself is still listed, which matters more: hiding it because its HEAD was unreadable
 * would leave a directory on disk that the tool claims does not exist.
 */
async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation sandbox");
	} else if (entry.kind === "empty") {
		parts.push("legacy project shell");
	} else {
		parts.push("unrecognized contents");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	if (entry.undeterminedReason) parts.push(entry.undeterminedReason);
	return parts.join(" — ");
}
