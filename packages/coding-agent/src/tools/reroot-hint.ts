/**
 * Noticing that the session is working somewhere other than its working
 * directory, and saying so once.
 *
 * WHY THIS EXISTS. `set_cwd` re-roots the session, which makes read/edit headers
 * relative instead of absolute and loads the destination project's `AGENTS.md`.
 * Both matter, and neither happens unless something calls the tool. Nothing did,
 * reliably: the only text describing when to re-root lived in the tool's own
 * description, and `set_cwd` is a `discoverable` tool, so it is not in the initial
 * toolset. A model that has not gone looking for the tool has never read the
 * advice, and a model that has not read the advice does not go looking. Asking it
 * to notice on its own is asking it to infer a policy from an absence.
 *
 * So the harness notices instead. Every filesystem tool call already declares its
 * targets for the cwd boundary; this watches those targets and, once a directory
 * outside cwd has been touched enough times to be the real subject of the session,
 * appends one short line to that tool's result. Deterministic input, deterministic
 * trigger, delivered where the model is already reading.
 *
 * IT MUST NOT NAG. A hint that repeats is worse than no hint: it burns context on
 * every call and trains the model to skim past it. Each directory is mentioned at
 * most once, the session emits at most {@link MAX_HINTS} in total, and a directory
 * the model has already re-rooted into can never be suggested because it stops
 * being outside cwd.
 */

import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { hasFilesystemTargets } from "./cwd-boundary";
import { isPathWithinCwd, resolveToCwd, splitPathAndSel } from "./path-utils";

/**
 * Distinct files under one directory before it is worth mentioning.
 *
 * Two is a coincidence: reading a config file and a type declaration from another
 * project while working here is ordinary and re-rooting for it would be wrong.
 * Three files in one place is a pattern, and by then the absolute paths in every
 * header have already cost more than the hint will.
 */
export const REROOT_FILE_THRESHOLD = 3;

/**
 * Ancestors credited for each touched file.
 *
 * A file at `<root>/packages/thing/src/a.ts` should be able to nominate `<root>`,
 * not only its immediate directory, because the project root is what a user means
 * by "work over there". The cap keeps a deeply nested path from nominating `/`,
 * which is never a useful suggestion and would let files from unrelated trees
 * accumulate against the same bucket.
 */
const MAX_ANCESTOR_DEPTH = 6;

/** Hints one session will ever emit, after which it stays quiet for good. */
export const MAX_HINTS = 2;

export interface RerootHint {
	/** The directory worth re-rooting into. */
	directory: string;
	/** Distinct files touched under it. */
	fileCount: number;
	/** The sentence to append to the tool result. */
	text: string;
}

/**
 * Tracks out-of-cwd filesystem activity for one session and reports when a
 * directory has become the session's real subject.
 *
 * Session-scoped by construction: one instance per `createTools` call, so counts
 * never leak between sessions and a subagent starts clean.
 */
export class RerootDetector {
	/** Candidate directory to the distinct files seen under it. */
	readonly #filesByDirectory = new Map<string, Set<string>>();
	/** Directories already mentioned, so each is suggested at most once. */
	readonly #announced = new Set<string>();
	#hintsEmitted = 0;

	/**
	 * Record the paths a tool call touched and return a hint if one is now due.
	 *
	 * `targets` are raw path strings as the tool declared them, resolved here
	 * against `cwd` exactly as the boundary resolves them. Resolution is lexical
	 * on purpose: this is a suggestion, not a permission decision, so it must not
	 * pay for a `realpath` on every call to reach a conclusion a symlink could
	 * only make marginally more accurate.
	 */
	observe(targets: readonly string[], cwd: string): RerootHint | undefined {
		if (!cwd || this.#hintsEmitted >= MAX_HINTS) return undefined;

		for (const raw of targets) {
			if (typeof raw !== "string" || raw.trim().length === 0) continue;
			// Peel the read selector (`:1-40`, `:raw`) before anything else. The cwd
			// boundary can leave it attached because a suffix cannot introduce `../`
			// traversal, so it never changes whether a path is inside cwd. Here it
			// changes the ANSWER: this counts DISTINCT FILES, and `a.ts:1-40` and
			// `a.ts:41-80` are one file read twice. Left attached, three paged reads of
			// a single file fired the hint, which is precisely the incidental
			// cross-project access the threshold exists to stay silent about.
			// `splitPathAndSel` is the strict filesystem-path splitter, so a file
			// genuinely named `a:1-50` is left alone.
			const resolved = resolveToCwd(splitPathAndSel(raw).path, cwd);
			if (isPathWithinCwd(resolved, cwd)) continue;
			this.#credit(resolved, cwd);
		}

		return this.#dueHint(cwd);
	}

	/** Count `file` against its own directory and each ancestor within the cap. */
	#credit(file: string, cwd: string): void {
		let directory = path.dirname(file);
		for (let step = 0; step < MAX_ANCESTOR_DEPTH; step++) {
			// An ancestor that contains cwd is not a re-root target: suggesting it
			// would WIDEN the session's reach rather than move it, and every path
			// currently relative would become absolute.
			if (isPathWithinCwd(cwd, directory)) break;
			let files = this.#filesByDirectory.get(directory);
			if (!files) {
				files = new Set();
				this.#filesByDirectory.set(directory, files);
			}
			files.add(file);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}

	/**
	 * The deepest not-yet-announced directory at or over threshold.
	 *
	 * Deepest wins because it is the most specific answer. Every ancestor of a
	 * qualifying directory also qualifies (it was credited the same files), and
	 * suggesting `/home/user` when the work is in `/home/user/code/thing` would be
	 * technically true and useless.
	 */
	#dueHint(cwd: string): RerootHint | undefined {
		let best: { directory: string; fileCount: number } | undefined;
		for (const [directory, files] of this.#filesByDirectory) {
			if (files.size < REROOT_FILE_THRESHOLD || this.#announced.has(directory)) continue;
			if (!best || directory.length > best.directory.length) {
				best = { directory, fileCount: files.size };
			}
		}
		if (!best) return undefined;

		// Every ancestor of the chosen directory is suppressed too. They describe the
		// same activity, so announcing them later would be the same hint again with a
		// vaguer answer.
		for (const directory of this.#filesByDirectory.keys()) {
			if (best.directory === directory || isPathWithinCwd(best.directory, directory)) {
				this.#announced.add(directory);
			}
		}
		this.#hintsEmitted++;
		return { ...best, text: formatRerootHint(best.directory, best.fileCount, cwd) };
	}
}

/**
 * The hint sentence.
 *
 * It states the observation, the concrete call, and what the call buys, then
 * gives explicit permission to ignore it. The last part is load-bearing: a
 * directive the model cannot decline turns every incidental cross-project read
 * into a re-root, and re-rooting away from the user's project is worse than the
 * absolute paths it saves.
 */
export function formatRerootHint(directory: string, fileCount: number, cwd: string): string {
	return (
		`You have worked on ${fileCount} files under ${directory}, which is outside the session working directory (${cwd}). ` +
		`If the rest of this task is there, call set_cwd with ${directory}: paths in tool headers become relative instead of absolute, and that project's AGENTS.md rules load. ` +
		`If you are only passing through, ignore this.`
	);
}

/** The session state the wrapper needs: just the live cwd. */
export interface RerootHintSession {
	readonly cwd: string;
}

const kRerootWrapped = Symbol.for("veyyon.rerootHintWrapped");

/**
 * Wrap a tool so its result carries a re-root hint when one becomes due.
 *
 * Only tools that declare `filesystemTargets` are watched, which is the same set
 * the cwd boundary governs, so the detector sees exactly the calls that read or
 * write real paths and nothing else. Unlike the boundary, this runs in EVERY
 * approval mode: `cwdEscapingTargets` is skipped under yolo, and yolo is where a
 * session is most likely to wander out of cwd without ever being asked about it.
 *
 * The hint is appended to the result rather than replacing anything, and only on
 * a successful call. A failed call is the model's problem to solve first;
 * stacking advice onto an error is how a result becomes unreadable.
 */
export function wrapToolWithRerootHint<T extends AgentTool<any, any, any>>(
	tool: T,
	detector: RerootDetector,
	session: RerootHintSession,
): T {
	if (!hasFilesystemTargets(tool) || kRerootWrapped in tool) return tool;

	const originalExecute = tool.execute.bind(tool);
	const wrapped = async (...args: Parameters<typeof originalExecute>): Promise<AgentToolResult<unknown>> => {
		const result = await originalExecute(...args);
		// `filesystemTargets` is pure argument parsing, but it is third-party-ish
		// surface (extensions implement it too) and a throw here would fail a tool
		// call that already succeeded. A hint is never worth that.
		let hint: RerootHint | undefined;
		try {
			hint = detector.observe(tool.filesystemTargets(args[1]), session.cwd);
		} catch {
			return result;
		}
		if (!hint || result.isError) return result;
		return { ...result, content: [...result.content, { type: "text" as const, text: hint.text }] };
	};

	return Object.defineProperties(tool, {
		[kRerootWrapped]: { value: true, enumerable: false, configurable: true },
		execute: { value: wrapped, enumerable: false, configurable: true, writable: true },
	});
}
