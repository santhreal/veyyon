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

const gitIo: ProjectVocabIO = {
	gitHead: (root, signal) => head.sha(root, signal),
	listTrackedFiles: (root, signal) => ls.files(root, { signal }),
};

function logArgotNotice(notice: ProjectVocabNotice): void {
	if (notice.code === "content-budget-reached") {
		logger.info(notice.message, notice.data);
	} else {
		logger.warn(notice.message, notice.data);
	}
}

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

export type ArgotSubagentMode = "off" | "fresh" | "inherit";

export interface ArgotSessionInit {
	enabled: boolean;
	isSubagent: boolean;
	subagentMode: ArgotSubagentMode;
	parentArgot?: ArgotSession;
}

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
		}
	}

	return new ArgotSession();
}

export function shouldAutoloadArgotAtStartup(state: {
	enabled: boolean;
	autoload: boolean;
	argot: ArgotSession | undefined;
}): boolean {
	return state.enabled && state.autoload && state.argot !== undefined && !state.argot.loaded;
}

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

export function unloadArgotFolder(argot: ArgotSession, folder: string): { root: string; changed: boolean } | undefined {
	const root = resolveProjectRoot(folder);
	if (root === undefined) {
		return undefined;
	}
	return { root, changed: argot.unload(root) };
}

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
		const message = errorMessage(error);
		logger.error("Argot startup load failed; session stays UNARMED (no handles will be taught)", {
			cwd: opts.cwd,
			error: message,
		});
		opts.onFailed?.({ error: message });
	}
}
