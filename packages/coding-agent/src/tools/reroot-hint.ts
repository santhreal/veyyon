import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { errorMessage } from "@veyyon/utils";
import { hasFilesystemTargets } from "./cwd-boundary";
import { isPathWithinCwd, resolveToCwd, splitPathAndSel } from "./path-utils";
import type { RerootHint } from "./reroot-hint-helpers";
import {
	isNonProjectDirectory,
	MAX_ANCESTOR_DEPTH,
	MAX_HINTS,
	MISROOTED_FILE_THRESHOLD,
	outranks,
	REROOT_FILE_THRESHOLD,
	resolveProjectRoot,
	SET_CWD_TOOL_NAME,
} from "./reroot-hint-helpers";

export type { NonProjectReason } from "./reroot-hint-helpers";
export {
	isNonProjectRoot,
	isRepositoryContainer,
	NON_PROJECT_REASON_TEXT,
	PROJECT_ROOT_MARKERS,
} from "./reroot-hint-helpers";
export {
	isNonProjectDirectory,
	MAX_HINTS,
	MISROOTED_FILE_THRESHOLD,
	REROOT_FILE_THRESHOLD,
	resolveProjectRoot,
	SET_CWD_TOOL_NAME,
};

export class RerootDetector {
	readonly #filesByDirectory = new Map<string, Set<string>>();
	readonly #announced = new Set<string>();
	readonly #announcedRoots = new Set<string>();
	#hintsEmitted = 0;
	#workingDirectoryCalls = 0;

	observe(targets: readonly string[], cwd: string, workingDirectory?: string): RerootHint | undefined {
		if (!cwd || this.#hintsEmitted >= MAX_HINTS) return undefined;

		if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
			const resolved = resolveToCwd(workingDirectory, cwd);
			const usable = isPathWithinCwd(resolved, cwd)
				? isNonProjectDirectory(cwd) && resolved !== path.resolve(cwd)
				: true;
			if (usable) {
				this.#workingDirectoryCalls++;
				this.#credit(`run#${this.#workingDirectoryCalls}`, resolved, cwd);
			}
		}

		const misrooted = isNonProjectDirectory(cwd);
		const root = path.resolve(cwd);

		for (const raw of targets) {
			if (typeof raw !== "string" || raw.trim().length === 0) continue;
			const resolved = resolveToCwd(splitPathAndSel(raw).path, cwd);
			const directory = path.dirname(resolved);
			if (isPathWithinCwd(resolved, cwd)) {
				if (!misrooted) continue;
				if (directory === root) continue;
			}
			this.#credit(resolved, directory, cwd);
		}

		return this.#dueHint(cwd);
	}

	#credit(key: string, startDirectory: string, cwd: string): void {
		let directory = startDirectory;
		for (let step = 0; step < MAX_ANCESTOR_DEPTH; step++) {
			if (isPathWithinCwd(cwd, directory)) break;
			let files = this.#filesByDirectory.get(directory);
			if (!files) {
				files = new Set();
				this.#filesByDirectory.set(directory, files);
			}
			files.add(key);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}

	#dueHint(cwd: string): RerootHint | undefined {
		const threshold = isNonProjectDirectory(cwd) ? MISROOTED_FILE_THRESHOLD : REROOT_FILE_THRESHOLD;

		let best: { directory: string; fileCount: number } | undefined;
		for (const [directory, files] of this.#filesByDirectory) {
			if (files.size < threshold || this.#announced.has(directory)) continue;
			if (this.#isInsideAnnouncedRoot(directory)) continue;
			if (!best || outranks({ directory, fileCount: files.size }, best)) {
				best = { directory, fileCount: files.size };
			}
		}
		if (!best) return undefined;

		for (const directory of this.#filesByDirectory.keys()) {
			if (best.directory === directory || isPathWithinCwd(best.directory, directory)) {
				this.#announced.add(directory);
			}
		}
		this.#hintsEmitted++;
		return { ...best, text: formatRerootHint(best.directory, best.fileCount, cwd) };
	}

	#isInsideAnnouncedRoot(directory: string): boolean {
		for (const root of this.#announcedRoots) {
			if (isPathWithinCwd(directory, root)) return true;
		}
		return false;
	}

	recordAnnouncedRoot(root: string): void {
		this.#announcedRoots.add(path.resolve(root));
	}
}

export function formatRerootHint(
	directory: string,
	fileCount: number,
	cwd: string,
	options: { callable?: boolean } = {},
): string {
	const evidence = fileCount === 1 ? "1 file or command so far" : `${fileCount} files or commands now`;
	const inside = isPathWithinCwd(directory, cwd);
	const observation = inside
		? `The session working directory (${cwd}) is not a project root, and the work is under ${directory} (${evidence}). `
		: `You keep working under ${directory} (${evidence}), which is outside the session working directory (${cwd}). `;
	const payoff = `paths in tool headers become relative instead of absolute, and that project's AGENTS.md rules load. `;
	const optOut = inside
		? "If the work is not really there, ignore this."
		: "If you are only passing through, ignore this.";
	return options.callable === false
		? `${observation}If the rest of this task is there, re-root to it: ${payoff}` +
				`The ${SET_CWD_TOOL_NAME} tool is NOT in your active toolset and this session could not activate it, so find and activate it first (search_tool_bm25) instead of calling it blind. ` +
				optOut
		: `${observation}If the rest of this task is there, call ${SET_CWD_TOOL_NAME} with ${directory}: ${payoff}${optOut}`;
}

export interface RerootHintSession {
	readonly cwd: string;
	isToolActive?(name: string): boolean;
	activateDiscoveredTools?(toolNames: string[]): Promise<string[]>;
}

export async function ensureSetCwdCallable(session: RerootHintSession): Promise<boolean> {
	if (!session.isToolActive) return true;
	if (session.isToolActive(SET_CWD_TOOL_NAME)) return true;
	if (!session.activateDiscoveredTools) return false;
	const activated = await session.activateDiscoveredTools([SET_CWD_TOOL_NAME]);
	return activated.includes(SET_CWD_TOOL_NAME) || session.isToolActive(SET_CWD_TOOL_NAME);
}

function workingDirectoryArg(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const cwd = (args as { cwd?: unknown }).cwd;
	return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

const kRerootWrapped = Symbol.for("veyyon.rerootHintWrapped");

export function wrapToolWithRerootHint<T extends AgentTool<any, any, any>>(
	tool: T,
	detector: RerootDetector,
	session: RerootHintSession,
): T {
	if (kRerootWrapped in tool) return tool;

	const originalExecute = tool.execute.bind(tool);
	const wrapped = async (...args: Parameters<typeof originalExecute>): Promise<AgentToolResult<unknown>> => {
		const result = await originalExecute(...args);
		let hint: RerootHint | undefined;
		try {
			const targets = hasFilesystemTargets(tool) ? tool.filesystemTargets(args[1], session.cwd) : [];
			hint = detector.observe(targets, session.cwd, workingDirectoryArg(args[1]));
		} catch {
			return result;
		}
		if (!hint || result.isError) return result;
		let target = hint.directory;
		try {
			target = await resolveProjectRoot(hint.directory, session.cwd);
		} catch {
			target = hint.directory;
		}
		detector.recordAnnouncedRoot(target);

		let text = formatRerootHint(target, hint.fileCount, session.cwd);
		try {
			if (!(await ensureSetCwdCallable(session))) {
				text = formatRerootHint(target, hint.fileCount, session.cwd, { callable: false });
			}
		} catch (error) {
			text = `${formatRerootHint(target, hint.fileCount, session.cwd, { callable: false })} (Activating ${SET_CWD_TOOL_NAME} failed: ${errorMessage(error)}.)`;
		}
		return { ...result, content: result.content.concat([{ type: "text" as const, text }]) };
	};

	return Object.defineProperties(tool, {
		[kRerootWrapped]: { value: true, enumerable: false, configurable: true },
		execute: { value: wrapped, enumerable: false, configurable: true, writable: true },
	});
}
