import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, trimTrailingSlashes } from "@veyyon/utils";
import { repo } from "../utils/git";
import { isPathWithinCwd } from "./path-utils";

export const REROOT_FILE_THRESHOLD = 3;

export const MISROOTED_FILE_THRESHOLD = 1;

export const SET_CWD_TOOL_NAME = "set_cwd";

export const MAX_ANCESTOR_DEPTH = 6;

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

export const CONTAINER_SCAN_DEPTH = 4;

export const CONTAINER_SAMPLE_LIMIT = 64;

export const CONTAINER_SCAN_SKIP = new Set([
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

export const MAX_ROOT_WALK = 12;

export const LAUNCH_DIRECTORIES = [
	"/",
	"/home",
	"/Users",
	"/media",
	"/mnt",
	"/Volumes",
	"/tmp",
	"/var/tmp",
	"/opt",
	"/srv",
];

export const LAUNCH_PARENTS = ["/home", "/Users", "/media", "/mnt", "/Volumes"];

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

export async function hasEntry(directory: string, name: string): Promise<boolean> {
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

export function outranks(
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
