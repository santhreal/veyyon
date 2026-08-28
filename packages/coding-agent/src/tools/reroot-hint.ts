import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import { errorMessage, logger, trimTrailingSlashes } from "@veyyon/utils";
import { repo } from "../utils/git";
import { hasFilesystemTargets } from "./cwd-boundary";
import { isPathWithinCwd, resolveToCwd, splitPathAndSel } from "./path-utils";

export const REROOT_FILE_THRESHOLD = 3;

export const MISROOTED_FILE_THRESHOLD = 1;

export const SET_CWD_TOOL_NAME = "set_cwd";

const MAX_ANCESTOR_DEPTH = 6;

export const MAX_HINTS = 2;

export const REPOSITORY_MARKER = ".git";

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

export const PROJECT_ROOT_MARKERS = [REPOSITORY_MARKER, ...MANIFEST_MARKERS] as const;

const CONTAINER_SCAN_DEPTH = 4;

const CONTAINER_SAMPLE_LIMIT = 64;

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

export async function isRepositoryContainer(directory: string): Promise<boolean> {
	const root = path.resolve(directory);
	const nested = await findNestedRepositories(root);
	if (nested.length === 0) return false;

	const ignored = await repo.ignored(root, nested);
	if (!ignored) {
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

async function findNestedRepositories(root: string): Promise<string[]> {
	const found: string[] = [];
	let frontier = [root];

	for (let depth = 0; depth < CONTAINER_SCAN_DEPTH && frontier.length > 0; depth++) {
		const listings = await Promise.all(
			frontier.map(async current => ({ current, entries: await readDirectoryOrEmpty(current) })),
		);
		const next: string[] = [];
		for (const { current, entries } of listings) {
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === REPOSITORY_MARKER) {
					if (current !== root) found.push(path.relative(root, current));
					continue;
				}
				if (entry.name.startsWith(".") || CONTAINER_SCAN_SKIP.has(entry.name)) continue;
				next.push(path.join(current, entry.name));
			}
		}
		if (found.length >= CONTAINER_SAMPLE_LIMIT) return found.slice(0, CONTAINER_SAMPLE_LIMIT);
		frontier = next;
	}

	return found;
}

async function readDirectoryOrEmpty(directory: string): Promise<Dirent[]> {
	try {
		return await fsPromises.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

const MAX_ROOT_WALK = 12;

const LAUNCH_DIRECTORIES = ["/", "/home", "/Users", "/media", "/mnt", "/Volumes", "/tmp", "/var/tmp", "/opt", "/srv"];

const LAUNCH_PARENTS = ["/home", "/Users", "/media", "/mnt", "/Volumes"];

export function isNonProjectDirectory(directory: string, options: { home?: string; tmp?: string } = {}): boolean {
	const raw = directory.split("\\").join("/");
	const lower = trimTrailingSlashes(raw.toLowerCase()) || "/";
	if (/^[a-z]:$/.test(lower)) return true;
	if (/^[a-z]:\/users$/.test(lower)) return true;
	if (/^[a-z]:\/users\/[^/]+$/.test(lower)) return true;

	const resolved = path.resolve(directory);
	const home = options.home ?? os.homedir();
	const tmp = options.tmp ?? os.tmpdir();

	if (resolved === path.resolve(home)) return true;
	if (resolved === path.resolve(tmp)) return true;
	if (path.dirname(resolved) === path.resolve(tmp)) return true;

	if (path.dirname(resolved) === resolved) return true;

	const posix = resolved.split(path.sep).join("/");
	if (LAUNCH_DIRECTORIES.includes(posix)) return true;
	const parent = posix.slice(0, posix.lastIndexOf("/")) || "/";
	return LAUNCH_PARENTS.includes(parent);
}

export async function isNonProjectRoot(directory: string): Promise<NonProjectReason | null> {
	if (isNonProjectDirectory(directory)) return "launch-directory";

	const present = await Promise.all(PROJECT_ROOT_MARKERS.map(marker => hasEntry(directory, marker)));
	if (!present.some(Boolean)) return "no-project-marker";

	const repositoryIndex = PROJECT_ROOT_MARKERS.indexOf(REPOSITORY_MARKER);
	if (present[repositoryIndex] === true && (await isRepositoryContainer(directory))) {
		return "holds-other-projects";
	}
	return null;
}

export type NonProjectReason = "launch-directory" | "no-project-marker" | "holds-other-projects";

export const NON_PROJECT_REASON_TEXT: Record<NonProjectReason, string> = {
	"launch-directory": "it is a home, temp, mount, or root directory that a shell starts in",
	"no-project-marker": "it holds no `.git`, no build manifest, and no `AGENTS.md`",
	"holds-other-projects": "it is a repository holding other projects rather than being one itself",
};

export async function resolveProjectRoot(directory: string, cwd: string): Promise<string> {
	let current = path.resolve(directory);
	let outermostManifest: string | undefined;

	for (let step = 0; step < MAX_ROOT_WALK; step++) {
		if (isPathWithinCwd(cwd, current)) break;

		if (await hasEntry(current, REPOSITORY_MARKER)) {
			if (!(await isRepositoryContainer(current))) return current;
			break;
		}

		for (const marker of MANIFEST_MARKERS) {
			if (!(await hasEntry(current, marker))) continue;
			outermostManifest = current;
			break;
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return outermostManifest ?? path.resolve(directory);
}

async function hasEntry(directory: string, name: string): Promise<boolean> {
	try {
		await fsPromises.stat(path.join(directory, name));
		return true;
	} catch {
		return false;
	}
}

function depthOf(directory: string): number {
	return directory.split(path.sep).filter(Boolean).length;
}

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
	directory: string;
	fileCount: number;
	text: string;
}

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

export function workingDirectoryArg(args: unknown): string | undefined {
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
