/**
 * Uncommitted drift: how far the session's own edits have run ahead of the last commit.
 *
 * Feeds the `commit-drift` rule, which is the whole reason this exists. The advice
 * "commit often" is already in the model's head and in most projects' `AGENTS.md`; what
 * it cannot see cheaply is the number — that eleven files it changed itself are sitting
 * uncommitted. So the tracker's only job is to produce that count honestly, and to
 * refuse to produce it in the situations where acting on it would be wrong.
 *
 * Two refusals matter more than the count:
 *
 *  - **Only this session's files.** A working tree routinely carries other people's
 *    in-flight work, and this repository bans `git add -A` for exactly that reason. A
 *    count taken from `git status` would include those files, and a nudge carrying that
 *    number pushes the model to commit changes it did not make. So the set is built from
 *    completed mutation results, never from the tree.
 *  - **Never mid-operation.** A rebase, merge, cherry-pick, or bisect moves HEAD for
 *    reasons that have nothing to do with the model, and "commit now" during one
 *    produces a commit in the middle of someone else's sequence.
 *
 * Reading HEAD is a filesystem read of `.git/HEAD` and one ref file (see `git.head`), not
 * a subprocess, which is what makes it affordable on every edit.
 */

import * as path from "node:path";
import { mutatedPathsFromToolResult } from "@veyyon/agent-core/compaction";
import * as git from "../utils/git";

/** How many paths the nudge names before it stops listing them. */
const LISTED_PATH_LIMIT = 8;

export interface CommitDriftSummary {
	/** Distinct files this session changed that are not in a commit yet. */
	count: number;
	/** Up to {@link LISTED_PATH_LIMIT} of them, repo-relative, plus an "and N more" tail. */
	files: string;
}

export class CommitDriftTracker {
	/** Absolute paths this session mutated since the last HEAD it observed. */
	readonly #paths = new Set<string>();
	/**
	 * The HEAD commit as of the last observation. `undefined` means never observed,
	 * which is distinct from `null` (observed, and the repository has no commits yet).
	 */
	#head: string | null | undefined;

	/**
	 * Note the files a finished tool call changed.
	 *
	 * Takes the tool RESULT rather than its arguments, through the same extractor
	 * compaction uses, so a tool that reported no change contributes nothing and a tool
	 * that changed six files from one call contributes six.
	 */
	record(toolName: string, details: unknown, cwd: string): void {
		const mutation = mutatedPathsFromToolResult(toolName, details);
		if (!mutation) return;
		this.#observe(cwd);
		for (const mutated of mutation.paths) this.#paths.add(path.resolve(cwd, mutated));
	}

	/**
	 * The drift worth telling the model about, or `null` when there is none to report.
	 *
	 * Null covers every case where the nudge would be wrong rather than merely quiet:
	 * the threshold is off or unmet, the session is not in a git repository, or a
	 * multi-step git operation is part-way through.
	 */
	summary(cwd: string, threshold: number): CommitDriftSummary | null {
		if (!Number.isFinite(threshold) || threshold <= 0) return null;
		const state = this.#observe(cwd);
		if (!state) return null;
		if (git.head.operation(state)) return null;
		if (this.#paths.size < threshold) return null;

		const relative = [...this.#paths]
			.map(absolute => {
				const rel = path.relative(state.repoRoot, absolute);
				return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absolute;
			})
			.sort();
		const listed = relative.slice(0, LISTED_PATH_LIMIT);
		const remainder = relative.length - listed.length;
		const files = remainder > 0 ? `${listed.join(", ")}, and ${remainder} more` : listed.join(", ");
		return { count: relative.length, files };
	}

	/**
	 * Current head state, dropping the tracked set when HEAD moved. `null` outside a repository.
	 *
	 * A moved HEAD means a commit landed (or the branch changed under the session), so the
	 * accumulated paths no longer describe uncommitted work. Clearing ALL of them is
	 * deliberate even though a partial commit leaves some genuinely uncommitted: the
	 * alternative is a `git status` per file to find the leftovers, and re-nudging
	 * immediately after the model just did what was asked is the behavior that trains
	 * people to turn a reminder off. A leftover file re-enters the set the next time it is
	 * touched.
	 */
	#observe(cwd: string): git.GitHeadState | null {
		const state = git.head.resolveSync(cwd);
		if (!state) return null;
		const commit = state.commit;
		if (this.#head === undefined) {
			this.#head = commit;
			return state;
		}
		if (commit !== this.#head) {
			this.#head = commit;
			this.#paths.clear();
		}
		return state;
	}
}
