/** Noticing that the session is working somewhere other than its working directory, and saying so once. */

import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { errorMessage, logger, trimTrailingSlashes } from "@veyyon/utils";
import { repo } from "../utils/git";
import { hasFilesystemTargets } from "./cwd-boundary";
import { isPathWithinCwd, resolveToCwd, splitPathAndSel } from "./path-utils";

/** Distinct files under one directory before it is worth mentioning. Two is a coincidence: reading a config file and a type declaration from another */
export const REROOT_FILE_THRESHOLD = 3;

/** Distinct files under one directory before it is worth mentioning, when the session is rooted somewhere that is not a project at all. */
export const MISROOTED_FILE_THRESHOLD = 1;

/** The name of the re-root tool, owned here because this is the module that has to NAME it in prose and ACTIVATE it, and `set-cwd.ts` is far too heavy to import */
export const SET_CWD_TOOL_NAME = "set_cwd";

/** Ancestors credited for each touched file. A file at `<root>/packages/thing/src/a.ts` should be able to nominate `<root>`, */
const MAX_ANCESTOR_DEPTH = 6;

/** Hints one session will ever emit, after which it stays quiet for good. */
export const MAX_HINTS = 2;

/** Entries that mark a directory as the root of a project. `.git` is listed first and treated as decisive by {@link resolveProjectRoot}, because a */
export const REPOSITORY_MARKER = ".git";

/** Root markers other than the repository boundary. */
export const MANIFEST_MARKERS = [
	"Cargo.toml",
	"package.json",
	"go.mod",
	"pyproject.toml",
	"deno.json",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"composer.json",
	"CMakeLists.txt",
	"AGENTS.md",
] as const;

/** Every marker, repository boundary first, so callers have one list to iterate. */
export const PROJECT_ROOT_MARKERS = [REPOSITORY_MARKER, ...MANIFEST_MARKERS] as const;

/** How far below a repository root to look for nested repositories. Four, because that is where a container tree puts them. A directory organising work as */
const CONTAINER_SCAN_DEPTH = 4;

/** Nested repositories to collect before deciding. The decision needs only ONE nested repository the outer tree does not ignore, but the ignore */
const CONTAINER_SAMPLE_LIMIT = 64;

/** Directories that never count as evidence of a container. A dependency vendored WITH its `.git` intact, or a checkout sitting in `node_modules`, says */
const CONTAINER_SCAN_SKIP = new Set([
	"node_modules",
	"vendor",
	"third_party",
	"target",
	"build",
	"dist",
	"venv",
	"__pycache__",
]);

/** Whether a repository root is really a CONTAINER of projects rather than a project. repository boundary settles what counts as one project. It does not, because a tree can be under */
export async function isRepositoryContainer(directory: string): Promise<boolean> {
	const root = path.resolve(directory);
	const nested = await findNestedRepositories(root);
	if (nested.length === 0) return false;

	const ignored = await repo.ignored(root, nested);
	if (!ignored) {
		// The question could not be answered, so it must not be answered by guessing. Reporting "not
		// a container" would re-root the session into a tree that may well be one, which is the
		// defect this check exists to fix, and doing it silently is worse than doing it loudly.
		logger.warn(
			"Could not determine whether a repository holds other projects; not suggesting it as a re-root target",
			{
				directory: root,
				nested: nested.length,
			},
		);
		return true;
	}
	return nested.some(candidate => !ignored.has(candidate));
}

/** Nested repository directories below `root`, as paths relative to it. Relative because that is what `git check-ignore` wants, and because an absolute path outside the */
async function findNestedRepositories(root: string): Promise<string[]> {
	const found: string[] = [];
	let frontier = [root];

	for (let depth = 0; depth < CONTAINER_SCAN_DEPTH && frontier.length > 0; depth++) {
		// One depth is one round of I/O rather than one per directory. The walk is breadth-first and every directory at a depth is independent, so reading them
		const listings = await Promise.all(
			frontier.map(async current => ({ current, entries: await readDirectoryOrEmpty(current) })),
		);
		const next: string[] = [];
		for (const { current, entries } of listings) {
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === REPOSITORY_MARKER) {
					// The root's own marker says nothing: every repository has one.
					if (current !== root) found.push(path.relative(root, current));
					continue;
				}
				// Hidden directories hold caches and tooling state, and the skip list holds the places
				// a dependency lands. Neither is where a co-tenant project lives, and both are where
				// an ordinary project's incidental checkouts do.
				if (entry.name.startsWith(".") || CONTAINER_SCAN_SKIP.has(entry.name)) continue;
				next.push(path.join(current, entry.name));
			}
		}
		// The cap is applied once the depth is complete rather than mid-frontier, so the
		// sample is the same list whatever order the reads finished in.
		if (found.length >= CONTAINER_SAMPLE_LIMIT) return found.slice(0, CONTAINER_SAMPLE_LIMIT);
		frontier = next;
	}

	return found;
}

/** Directory entries, or none when this process cannot list it. */
async function readDirectoryOrEmpty(directory: string): Promise<Dirent[]> {
	try {
		return await fsPromises.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Levels {@link resolveProjectRoot} will climb looking for a marker. Generous, because the walk stops at the first marker and at the cwd boundary long before this */
const MAX_ROOT_WALK = 12;

/** Directories that are launch points rather than projects, spelled without a home prefix. These are where a shell puts you, not where work lives. `/media`, `/mnt` and `/Volumes` hold */
const LAUNCH_DIRECTORIES = ["/", "/home", "/Users", "/media", "/mnt", "/Volumes", "/tmp", "/var/tmp", "/opt", "/srv"];

/** Parents whose direct children are mount points or user homes rather than projects. */
const LAUNCH_PARENTS = ["/home", "/Users", "/media", "/mnt", "/Volumes"];

/** Whether a directory is a place a session gets STARTED rather than a project. accumulate: three files under one foreign directory before anything is said. That is the right */
export function isNonProjectDirectory(directory: string, options: { home?: string; tmp?: string } = {}): boolean {
	// The Windows spellings are matched on the RAW text, before any resolution. `path.resolve` on a
	// POSIX host reads `C:/` as a relative segment and answers `<cwd>/C:`, so resolving first would
	// make every Windows shape unrecognisable exactly where it needs recognising.
	const raw = directory.split("\\").join("/");
	// The shared stripper rather than a local regex: one owner for how many trailing slashes come
	// off, so `C:\\` and `C:/` cannot start answering differently here than they do anywhere else.
	// The `|| "/"` keeps a bare root a root instead of the empty string.
	const lower = trimTrailingSlashes(raw.toLowerCase()) || "/";
	if (/^[a-z]:$/.test(lower)) return true;
	if (/^[a-z]:\/users$/.test(lower)) return true;
	if (/^[a-z]:\/users\/[^/]+$/.test(lower)) return true;

	const resolved = path.resolve(directory);
	const home = options.home ?? os.homedir();
	const tmp = options.tmp ?? os.tmpdir();

	// The user's own home, and the temp directory, are launch points by definition.
	if (resolved === path.resolve(home)) return true;
	if (resolved === path.resolve(tmp)) return true;
	// A direct child of the temp directory is a scratch workspace, not a project.
	if (path.dirname(resolved) === path.resolve(tmp)) return true;

	// Any filesystem root: POSIX `/`, and a Windows drive root, which `path.dirname` reports as
	// itself exactly as it does for `/`.
	if (path.dirname(resolved) === resolved) return true;

	const posix = resolved.split(path.sep).join("/");
	if (LAUNCH_DIRECTORIES.includes(posix)) return true;
	// A mount point or a user's home under one of the parents above.
	const parent = posix.slice(0, posix.lastIndexOf("/")) || "/";
	return LAUNCH_PARENTS.includes(parent);
}

/** Whether the session's working directory is a bad place to be rooted, and why. Three independent reasons, cheapest first, each of which alone means the same thing: the paths */
export async function isNonProjectRoot(directory: string): Promise<NonProjectReason | null> {
	if (isNonProjectDirectory(directory)) return "launch-directory";

	// One round of stats rather than one per marker, and the repository marker's answer is reused by the container question below instead of being asked for twice. The markers
	const present = await Promise.all(PROJECT_ROOT_MARKERS.map(marker => hasEntry(directory, marker)));
	if (!present.some(Boolean)) return "no-project-marker";

	const repositoryIndex = PROJECT_ROOT_MARKERS.indexOf(REPOSITORY_MARKER);
	if (present[repositoryIndex] === true && (await isRepositoryContainer(directory))) {
		return "holds-other-projects";
	}
	return null;
}

/** Why a working directory is not a project root. */
export type NonProjectReason = "launch-directory" | "no-project-marker" | "holds-other-projects";

/** How each reason is said to the model, owned here beside the reason it explains. In the prompt rather than in the enum name because the model reads the sentence, and one place */
export const NON_PROJECT_REASON_TEXT: Record<NonProjectReason, string> = {
	"launch-directory": "it is a home, temp, mount, or root directory that a shell starts in",
	"no-project-marker": "it holds no `.git`, no build manifest, and no `AGENTS.md`",
	"holds-other-projects": "it is a repository holding other projects rather than being one itself",
};

/** The project root a qualifying directory belongs to. choosing WHICH activity to report: every ancestor of a busy directory is credited the same */
export async function resolveProjectRoot(directory: string, cwd: string): Promise<string> {
	let current = path.resolve(directory);
	let outermostManifest: string | undefined;

	for (let step = 0; step < MAX_ROOT_WALK; step++) {
		// The same boundary `#credit` enforces: an ancestor of cwd is not a re-root target.
		if (isPathWithinCwd(cwd, current)) break;

		if (await hasEntry(current, REPOSITORY_MARKER)) {
			// A repository that holds other repositories is a container, and a container is not a project. Answering it would re-root the session to a tree that merely happens to be
			if (!(await isRepositoryContainer(current))) return current;
			// Nothing ABOVE a container is a project either, so the climb ends here rather than
			// continuing to an even larger tree. The best remaining answer is the outermost manifest
			// seen on the way up, which is a directory inside the container.
			break;
		}

		for (const marker of MANIFEST_MARKERS) {
			if (!(await hasEntry(current, marker))) continue;
			// Remembered and overwritten by any found higher up, so the last one standing is the
			// outermost.
			outermostManifest = current;
			break;
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return outermostManifest ?? path.resolve(directory);
}

/** Whether `directory` holds `name`, treating an unreadable entry as absent. */
async function hasEntry(directory: string, name: string): Promise<boolean> {
	try {
		await fsPromises.stat(path.join(directory, name));
		return true;
	} catch {
		// Absence is the ordinary answer: most directories on the way up carry no marker. A marker
		// that cannot be stat'ed is one this session could not have used either.
		return false;
	}
}

/** Path segments in `directory`, used to pick the more specific of two candidates. */
function depthOf(directory: string): number {
	return directory.split(path.sep).filter(Boolean).length;
}

/** True when `candidate` is the better thing to suggest than `incumbent`. DEEPEST FIRST, because the deepest qualifying directory is the specific answer. */
function outranks(
	candidate: { directory: string; fileCount: number },
	incumbent: { directory: string; fileCount: number },
): boolean {
	const candidateDepth = depthOf(candidate.directory);
	const incumbentDepth = depthOf(incumbent.directory);
	if (candidateDepth !== incumbentDepth) return candidateDepth > incumbentDepth;
	if (candidate.fileCount !== incumbent.fileCount) return candidate.fileCount > incumbent.fileCount;
	return candidate.directory < incumbent.directory;
}

export interface RerootHint {
	/** The directory worth re-rooting into. */
	directory: string;
	/** Distinct files touched under it. */
	fileCount: number;
	/** The sentence to append to the tool result. */
	text: string;
}

/** Tracks out-of-cwd filesystem activity for one session and reports when a directory has become the session's real subject. */
export class RerootDetector {
	/** Candidate directory to the distinct evidence keys seen under it. */
	readonly #filesByDirectory = new Map<string, Set<string>>();
	/** Directories already mentioned, so each is suggested at most once. */
	readonly #announced = new Set<string>();
	/** Project roots already advised about, so a second busy directory in the SAME project cannot earn a second identical hint. */
	readonly #announcedRoots = new Set<string>();
	#hintsEmitted = 0;
	/** Calls that named an out-of-cwd working directory, used to key each one. */
	#workingDirectoryCalls = 0;

	/** Record the paths a tool call touched and return a hint if one is now due. `targets` are raw path strings as the tool declared them, resolved here */
	observe(targets: readonly string[], cwd: string, workingDirectory?: string): RerootHint | undefined {
		if (!cwd || this.#hintsEmitted >= MAX_HINTS) return undefined;

		// A tool told to RUN somewhere is the strongest evidence there is, and it is the only evidence `bash` produces. Bash declares no filesystem targets,
		if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
			const resolved = resolveToCwd(workingDirectory, cwd);
			// Inside cwd is evidence too when cwd is not a project, on the same reasoning as the
			// file loop below: a command RUN in a subdirectory names where the work is, and for a
			// misrooted session that subdirectory is the answer rather than something to ignore.
			const usable = isPathWithinCwd(resolved, cwd)
				? isNonProjectDirectory(cwd) && resolved !== path.resolve(cwd)
				: true;
			if (usable) {
				this.#workingDirectoryCalls++;
				this.#credit(`run#${this.#workingDirectoryCalls}`, resolved, cwd);
			}
		}

		// A session rooted somewhere that is not a project changes what counts as evidence. THE BLIND SPOT THIS CLOSES. Everything below credits only paths OUTSIDE cwd, which is
		const misrooted = isNonProjectDirectory(cwd);
		const root = path.resolve(cwd);

		for (const raw of targets) {
			if (typeof raw !== "string" || raw.trim().length === 0) continue;
			// Peel the read selector (`:1-40`, `:raw`) before anything else. The cwd boundary can leave it attached because a suffix cannot introduce `../`
			const resolved = resolveToCwd(splitPathAndSel(raw).path, cwd);
			const directory = path.dirname(resolved);
			if (isPathWithinCwd(resolved, cwd)) {
				if (!misrooted) continue;
				// A file sitting directly in cwd names no subdirectory to move to, and crediting cwd
				// itself would suggest re-rooting to where the session already is.
				if (directory === root) continue;
			}
			this.#credit(resolved, directory, cwd);
		}

		return this.#dueHint(cwd);
	}

	/** Count one piece of evidence against `startDirectory` and each ancestor within the cap. */
	#credit(key: string, startDirectory: string, cwd: string): void {
		let directory = startDirectory;
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
			files.add(key);
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
	}

	/** The deepest not-yet-announced directory at or over threshold. Deepest wins because it is the most specific answer. Every ancestor of a */
	#dueHint(cwd: string): RerootHint | undefined {
		// A session rooted somewhere that is not a project needs no evidence that the work is
		// elsewhere: there is nothing here for a read to be incidental to. Asked lexically so this
		// stays a synchronous, filesystem-free path that runs on every call.
		const threshold = isNonProjectDirectory(cwd) ? MISROOTED_FILE_THRESHOLD : REROOT_FILE_THRESHOLD;

		let best: { directory: string; fileCount: number } | undefined;
		for (const [directory, files] of this.#filesByDirectory) {
			if (files.size < threshold || this.#announced.has(directory)) continue;
			// Anything inside a project already advised about would repeat that advice.
			if (this.#isInsideAnnouncedRoot(directory)) continue;
			if (!best || outranks({ directory, fileCount: files.size }, best)) {
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

	/** True when `directory` sits inside a project root this session has already advised about. */
	#isInsideAnnouncedRoot(directory: string): boolean {
		for (const root of this.#announcedRoots) {
			if (isPathWithinCwd(directory, root)) return true;
		}
		return false;
	}

	/** Record the project root a hint actually pointed at. Called by the wrapper after {@link resolveProjectRoot}, because that resolution touches the */
	recordAnnouncedRoot(root: string): void {
		this.#announcedRoots.add(path.resolve(root));
	}
}

/** The hint sentence. It states the observation, the concrete call, and what the call buys, then */
export function formatRerootHint(
	directory: string,
	fileCount: number,
	cwd: string,
	options: { callable?: boolean } = {},
): string {
	// Singular when it is one, because the misrooted path below fires at a count of one and "1 files
	// or commands" is the first thing a reader sees.
	const evidence = fileCount === 1 ? "1 file or command so far" : `${fileCount} files or commands now`;
	// TWO OBSERVATIONS, because the same sentence is not true in both cases. The hint normally fires for a directory OUTSIDE cwd, and said so. A session rooted somewhere that is not a project
	const inside = isPathWithinCwd(directory, cwd);
	const observation = inside
		? `The session working directory (${cwd}) is not a project root, and the work is under ${directory} (${evidence}). `
		: `You keep working under ${directory} (${evidence}), which is outside the session working directory (${cwd}). `;
	const payoff = `paths in tool headers become relative instead of absolute, and that project's AGENTS.md rules load. `;
	// "Passing through" is the wrong escape hatch for a misrooted session: there is nothing here to
	// pass through FROM, so the only reason to decline is that the work is not really there.
	const optOut = inside
		? "If the work is not really there, ignore this."
		: "If you are only passing through, ignore this.";
	// The two spellings differ in exactly one thing: whether the tool is in the
	// toolset right now. Telling a model to call a tool it does not have produces a
	// failed call and, worse, teaches it that this advice is wrong.
	return options.callable === false
		? `${observation}If the rest of this task is there, re-root to it: ${payoff}` +
				`The ${SET_CWD_TOOL_NAME} tool is NOT in your active toolset and this session could not activate it, so find and activate it first (search_tool_bm25) instead of calling it blind. ` +
				optOut
		: `${observation}If the rest of this task is there, call ${SET_CWD_TOOL_NAME} with ${directory}: ${payoff}${optOut}`;
}

/** The session state the wrapper needs: the live cwd, and enough of the discovery surface to make the tool it recommends actually callable. */
export interface RerootHintSession {
	readonly cwd: string;
	/** True when `name` is in the toolset the model can currently call. */
	isToolActive?(name: string): boolean;
	/** Add discoverable tools to the active toolset; returns the ones newly activated. */
	activateDiscoveredTools?(toolNames: string[]): Promise<string[]>;
}

/** Put `set_cwd` in the model's toolset, and report whether it is now callable. `discoverable` tool, so under `tools.discoveryMode: all` it is deliberately */
export async function ensureSetCwdCallable(session: RerootHintSession): Promise<boolean> {
	// No activation tracking at all means the toolset is fixed: `set_cwd` is either
	// in it or was never going to be, and there is nothing to do or to report.
	if (!session.isToolActive) return true;
	if (session.isToolActive(SET_CWD_TOOL_NAME)) return true;
	if (!session.activateDiscoveredTools) return false;
	const activated = await session.activateDiscoveredTools([SET_CWD_TOOL_NAME]);
	// `activateDiscoveredTools` reports only what it NEWLY added, so a tool that
	// became active by another route in the meantime reads as "not activated". Ask
	// the session again rather than trusting the delta.
	return activated.includes(SET_CWD_TOOL_NAME) || session.isToolActive(SET_CWD_TOOL_NAME);
}

/** The directory a tool call was told to run in, when it names one. Read from the arguments by SHAPE rather than from a list of tool names. Any */
export function workingDirectoryArg(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const cwd = (args as { cwd?: unknown }).cwd;
	return typeof cwd === "string" && cwd.trim().length > 0 ? cwd : undefined;
}

const kRerootWrapped = Symbol.for("veyyon.rerootHintWrapped");

/** Wrap a tool so its result carries a re-root hint when one becomes due. Two signals feed it. Tools that declare `filesystemTargets` contribute the */
export function wrapToolWithRerootHint<T extends AgentTool<any, any, any>>(
	tool: T,
	detector: RerootDetector,
	session: RerootHintSession,
): T {
	if (kRerootWrapped in tool) return tool;

	const originalExecute = tool.execute.bind(tool);
	const wrapped = async (...args: Parameters<typeof originalExecute>): Promise<AgentToolResult<unknown>> => {
		const result = await originalExecute(...args);
		// `filesystemTargets` is pure argument parsing, but it is third-party-ish
		// surface (extensions implement it too) and a throw here would fail a tool
		// call that already succeeded. A hint is never worth that.
		let hint: RerootHint | undefined;
		try {
			const targets = hasFilesystemTargets(tool) ? tool.filesystemTargets(args[1], session.cwd) : [];
			hint = detector.observe(targets, session.cwd, workingDirectoryArg(args[1]));
		} catch {
			return result;
		}
		if (!hint || result.isError) return result;
		// Point at the PROJECT, not at the busiest directory inside it. The detector ranks deepest-first to decide which activity to report, which would otherwise advise re-rooting
		let target = hint.directory;
		try {
			target = await resolveProjectRoot(hint.directory, session.cwd);
		} catch {
			// The walk is `stat` calls on ancestors that may have become unreadable mid-session.
			// The observed directory is still a true statement about where the work is, so the hint
			// is still worth printing; it just cannot be improved into the project root.
			target = hint.directory;
		}
		detector.recordAnnouncedRoot(target);

		// Activation happens HERE, once, on the call that earned the hint, rather than
		// on every observation: a session that read one file next door must not acquire
		// a tool it was never advised to use.
		let text = formatRerootHint(target, hint.fileCount, session.cwd);
		try {
			if (!(await ensureSetCwdCallable(session))) {
				text = formatRerootHint(target, hint.fileCount, session.cwd, { callable: false });
			}
		} catch (error) {
			// Activation reaches into the live session and can fail for reasons that have
			// nothing to do with this call. Name the missing tool and the reason;
			// swallowing it and still saying "call set_cwd" is the original bug.
			text = `${formatRerootHint(target, hint.fileCount, session.cwd, { callable: false })} (Activating ${SET_CWD_TOOL_NAME} failed: ${errorMessage(error)}.)`;
		}
		return { ...result, content: result.content.concat([{ type: "text" as const, text }]) };
	};

	return Object.defineProperties(tool, {
		[kRerootWrapped]: { value: true, enumerable: false, configurable: true },
		execute: { value: wrapped, enumerable: false, configurable: true, writable: true },
	});
}
