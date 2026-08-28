// veyyon-side lifecycle for the argot shorthand cache. All the logic that decides WHICH dictionary a repository state gets — corpus gathering, cache keying, the

import { errorMessage, getArgotCacheDir, logger } from "@veyyon/utils";
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

/** The one capability argot cannot supply itself: git access. `git rev-parse HEAD` for the content signature, `git ls-files` (which respects `.gitignore`) for the */
const gitIo: ProjectVocabIO = {
	gitHead: (root, signal) => head.sha(root, signal),
	listTrackedFiles: (root, signal) => ls.files(root, { signal }),
};

/** Surface an argot notice through the veyyon logger so no recall-preserving degrade or misconfiguration is ever swallowed (Law 10). A reached content */
function logArgotNotice(notice: ProjectVocabNotice): void {
	if (notice.code === "content-budget-reached") {
		logger.info(notice.message, notice.data);
	} else {
		logger.warn(notice.message, notice.data);
	}
}

/** Resolve a folder to its project vocabulary through argot, plugging in the two harness-owned inputs (git access, the cache directory) and the notice sink. */
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

/** Build the {@link ArgotSession} for a session, applying the subagent policy. Loading is agent-driven (the canonical flow in argot's SPEC): every session */
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

/** Decide whether the session loads its launch folder itself, or leaves every load to the agent's `argot_load` calls. This is the ONE owner of that decision: the */
export function shouldAutoloadArgotAtStartup(state: {
	enabled: boolean;
	autoload: boolean;
	argot: ArgotSession | undefined;
}): boolean {
	return state.enabled && state.autoload && state.argot !== undefined && !state.argot.loaded;
}

/** Collect the project roots a persisted branch previously loaded through the `argot_load` tool. The tool result's details carry the resolved root, so the */
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
	return Array.from(roots);
}

/** Re-arm a resumed session for DECODE ONLY. Persisted history keeps cheap handles (replay stays cheap — the token win), so a resumed transcript can */
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

/** Load the shorthand for an explicit folder into an already-armed session, so an agent working several projects at once can teach the handles of each. Resolves */
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

/** Stop teaching a folder's shorthand: resolve `folder` to its work-unit root and drop that key from the session's teach set. Decoding stays on for every handle */
export function unloadArgotFolder(argot: ArgotSession, folder: string): { root: string; changed: boolean } | undefined {
	const root = resolveProjectRoot(folder);
	if (root === undefined) {
		return undefined;
	}
	return { root, changed: argot.unload(root) };
}

/** Arm a session's shorthand in the background after startup. The first load in a project walks the repo to generate the dictionary, so awaiting it inline */
export async function armArgotAfterStartup(opts: {
	argot: ArgotSession;
	cwd: string;
	tokenBudget?: number;
	onArmed: () => Promise<void>;
	onResolved?: (vocab: { handles: number; entries: Record<string, string> }) => void;
	onFailed?: (info: { error: string }) => void;
}): Promise<void> {
	try {
		const loaded = await loadArgotFolder(opts.argot, opts.cwd, undefined, opts.tokenBudget);
		if (loaded !== undefined) {
			if (opts.onResolved !== undefined) {
				const entries: Record<string, string> = {};
				for (const [name, expansion] of opts.argot.vocabulary().handles) entries[name] = expansion;
				opts.onResolved({ handles: loaded.handles, entries });
			}
			if (loaded.handles > 0) {
				await opts.onArmed();
			}
		}
	} catch (error) {
		// A failed arm must be LOUD and RECORDED, never a quiet degrade. The session deliberately survives — a bad dictionary should not kill a coding session —
		const message = errorMessage(error);
		logger.error("Argot startup load failed; session stays UNARMED (no handles will be taught)", {
			cwd: opts.cwd,
			error: message,
		});
		opts.onFailed?.({ error: message });
	}
}
