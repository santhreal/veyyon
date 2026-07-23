// veyyon-side lifecycle for the argot shorthand cache. All the logic that decides
// WHICH dictionary a repository state gets — corpus gathering, cache keying, the
// git-vs-walk decision, budget validation, when it regenerates — lives in the
// `argot` package (`resolveProjectVocab`), so every harness behaves identically
// and veyyon carries no novel codec logic. This module is the thin harness
// adapter that argot's `INTEGRATING.md` describes: it supplies only the two
// capabilities argot cannot provide itself (running git, and the machine path
// where the cache lives) and wires argot's notices to the veyyon logger so no
// degrade is silent. Everything else is a call into argot.
//
// The dictionary is a local decode cache, never a repository file: it lives under
// the config root (getArgotCacheDir), keyed by content signature, immutable and
// content-addressed. See argot's project-vocab.ts for the full lifecycle.

import { getArgotCacheDir, logger } from "@veyyon/utils";
import {
	ARGOT_LOAD_TOOL,
	ArgotSession,
	type ProjectVocabIO,
	type ProjectVocabNotice,
	type ResolvedProjectVocab,
	resolveProjectRoot,
	resolveProjectVocab,
} from "argot";
import { head, ls } from "./utils/git";

/**
 * The one capability argot cannot supply itself: git access. `git rev-parse HEAD`
 * for the content signature, `git ls-files` (which respects `.gitignore`) for the
 * corpus. `head.sha` returns `null` for a non-git folder, at which point argot
 * treats it as a `.argot` project and walks the tree itself, never calling
 * `listTrackedFiles`.
 */
const gitIo: ProjectVocabIO = {
	gitHead: (root, signal) => head.sha(root, signal),
	listTrackedFiles: (root, signal) => ls.files(root, { signal }),
};

/**
 * Surface an argot notice through the veyyon logger so no recall-preserving
 * degrade or misconfiguration is ever swallowed (Law 10). A reached content
 * budget is expected under a huge tree, so it is informational; an invalid token
 * budget is an operator mistake, so it warns.
 */
function logArgotNotice(notice: ProjectVocabNotice): void {
	if (notice.code === "content-budget-reached") {
		logger.info(notice.message, notice.data);
	} else {
		logger.warn(notice.message, notice.data);
	}
}

/**
 * Resolve a folder to its project vocabulary through argot, plugging in the two
 * harness-owned inputs (git access, the cache directory) and the notice sink.
 * Both session arming and explicit folder loading go through this single call, so
 * they resolve, key, and generate identically — and identically to every other
 * harness, because the logic is argot's, not veyyon's.
 */
function resolveFolderVocab(
	folder: string,
	tokenBudget: number | undefined,
	signal?: AbortSignal,
): Promise<ResolvedProjectVocab | undefined> {
	return resolveProjectVocab({
		folder,
		cacheDir: getArgotCacheDir(),
		io: gitIo,
		tokenBudget,
		onNotice: logArgotNotice,
		signal,
	});
}

/** How a subagent starts with Argot shorthand. Mirrors the `argot.subagents` setting. */
export type ArgotSubagentMode = "off" | "fresh" | "inherit";

/** Inputs to {@link createArgotSession}: whether the feature is on, and the subagent policy. */
export interface ArgotSessionInit {
	/** Whether Argot is enabled at all (`argot.enabled`). When false, no session is built. */
	enabled: boolean;
	/** Whether this is a subagent session (a task-spawned child), which selects the subagent policy. */
	isSubagent: boolean;
	/** How a subagent starts (`argot.subagents`). Ignored for a top-level session. */
	subagentMode: ArgotSubagentMode;
	/** The parent session's codec, for `inherit`. Absent for a top-level session or a parent with Argot off. */
	parentArgot?: ArgotSession;
}

/**
 * Build the {@link ArgotSession} for a session, applying the subagent policy.
 *
 * Loading is agent-driven (the canonical flow in argot's SPEC): every session
 * starts UNARMED and the model loads the project it intends to work in through
 * the `argot_load` tool, so the launch directory never picks the wrong project
 * in a monorepo. An unarmed session is fully correct: expansion is identity
 * until a dictionary loads, so nothing decodes wrong and nothing leaks. A
 * session that is never loaded simply saves no tokens.
 *
 * - A top-level session starts as an empty {@link ArgotSession} (the feature off
 *   returns no codec at all).
 * - A subagent follows {@link ArgotSessionInit.subagentMode}: `off` gets no codec,
 *   `fresh` gets its own empty session and loads its task's project itself, and
 *   `inherit` starts as a detached {@link ArgotSession.fork} of the parent's
 *   loaded shorthand.
 *
 * `inherit` with no parent codec to fork (a revived subagent with no live parent,
 * or a parent that had Argot off) is not a silent failure: it starts unarmed
 * instead, which is a fully correct path, and says so loudly in the log rather
 * than leaving the subagent silently without shorthand.
 */
export function createArgotSession(init: ArgotSessionInit): ArgotSession | undefined {
	if (!init.enabled) {
		return undefined;
	}

	if (init.isSubagent) {
		if (init.subagentMode === "off") {
			return undefined;
		}
		if (init.subagentMode === "inherit") {
			if (init.parentArgot !== undefined) {
				return init.parentArgot.fork();
			}
			logger.info("argot: subagent set to inherit but no parent codec was available; starting unarmed instead");
			// fall through to fresh
		}
	}

	return new ArgotSession();
}

/**
 * Collect the project roots a persisted branch previously loaded through the
 * `argot_load` tool. The tool result's details carry the resolved root, so the
 * branch itself is the record of what the model chose to load — resume re-arms
 * exactly those projects, with no walking and no guessing. Error results and
 * foreign tool results are skipped; roots are deduplicated.
 */
export function collectArgotLoadedRoots(
	messages: readonly { role: string; toolName?: string; isError?: boolean; details?: unknown }[],
): string[] {
	const roots = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== ARGOT_LOAD_TOOL || message.isError === true) {
			continue;
		}
		const root = (message.details as { root?: unknown } | undefined)?.root;
		if (typeof root === "string" && root !== "") {
			roots.add(root);
		}
	}
	return [...roots];
}

/**
 * Re-arm a resumed session for DECODE ONLY. Persisted history keeps cheap
 * handles (replay stays cheap — the token win), so a resumed transcript can
 * hold `§handle` tokens from `argot_load` calls in earlier sessions. Expanding
 * them for the display/export/resume seams needs those dictionaries loaded.
 * Teaching stays agent-driven: every root loads with `teach: false`, so the
 * handle table is NOT put back in the prompt — the model re-decides what to
 * write in shorthand by calling `argot_load` again (which re-loads the same key
 * with teaching on). Best-effort per root: a pruned or moved cache is logged
 * loudly and skipped, never fatal to resume.
 */
export async function rearmArgotForDecode(
	argot: ArgotSession,
	roots: readonly string[],
	signal?: AbortSignal,
	tokenBudget?: number,
): Promise<void> {
	for (const root of roots) {
		try {
			const resolved = await resolveFolderVocab(root, tokenBudget, signal);
			if (resolved !== undefined && resolved.vocab.handles.size > 0) {
				argot.load(resolved.root, resolved.vocab, { teach: false });
			}
		} catch (error) {
			logger.warn(
				"argot: decode re-arm failed for a previously loaded project; handles from it in resumed history will show raw",
				{ root, error: String(error) },
			);
		}
	}
}

/**
 * Load the shorthand for an explicit folder into an already-armed session, so an
 * agent working several projects at once can teach the handles of each. Resolves
 * `folder` to its work-unit root, reads-or-generates that root's immutable cache
 * entry, and unions it into the session under the root as the key. A second load
 * of a different folder adds to the union; a repeat load of the same folder
 * replaces its entry with the freshly resolved one.
 *
 * Returns the resolved root and the number of handles loaded, or `undefined` when
 * `folder` has no project marker (`.git` or `.argot`) to scope a dictionary to.
 * Never throws for a missing project: that is a normal "nothing to load" answer,
 * surfaced to the caller as `undefined`, not an error.
 */
export async function loadArgotFolder(
	argot: ArgotSession,
	folder: string,
	signal?: AbortSignal,
	tokenBudget?: number,
): Promise<{ root: string; handles: number } | undefined> {
	const resolved = await resolveFolderVocab(folder, tokenBudget, signal);
	if (resolved === undefined) {
		return undefined;
	}
	argot.load(resolved.root, resolved.vocab);
	return { root: resolved.root, handles: resolved.vocab.handles.size };
}

/**
 * Stop teaching a folder's shorthand: resolve `folder` to its work-unit root and
 * drop that key from the session's teach set. Decoding stays on for every handle
 * already loaded, so anything the model wrote with them keeps expanding; only the
 * teaching (the handle table in the prompt) stops.
 *
 * Returns the resolved root and whether anything changed (`false` when the folder
 * was never loaded or was already not taught), or `undefined` when `folder` has no
 * project marker to resolve.
 */
export function unloadArgotFolder(argot: ArgotSession, folder: string): { root: string; changed: boolean } | undefined {
	const root = resolveProjectRoot(folder);
	if (root === undefined) {
		return undefined;
	}
	return { root, changed: argot.unload(root) };
}
