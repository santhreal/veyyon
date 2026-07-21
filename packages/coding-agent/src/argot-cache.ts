// veyyon-side lifecycle for the argot shorthand cache. The vendored SDK
// (src/argot) owns the codec and the generator; this module owns WHERE the
// generated dictionary lives on this machine and WHEN it is regenerated.
//
// The dictionary is a local decode cache, never a repository file. It lives
// under the config root (getArgotCacheDir) in a per-project subdirectory keyed
// by the project's absolute path, so several agents working the same project
// share one cache and separate projects never collide. It regenerates when the
// git HEAD moves; content-addressed handle names keep concurrent regenerations
// from fighting over names, and the previous cache is pinned so a handle already
// taught to the model keeps its meaning as the cache grows.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getArgotCacheDir, hashPath, logger } from "@veyyon/utils";
import {
	type ArgotSession,
	cacheDictPath,
	type RepoFile,
	readDictFile,
	regenerateProjectCache,
	resolveProjectRoot,
} from "./argot";
import { isNotFound } from "./argot/fs-util";
import { head, ls } from "./utils/git";

/** Files to skip when walking a project that has no git to list its tree. */
const WALK_IGNORE = new Set([".git", "node_modules", ".veyyon", "dist", "target", ".next", "vendor"]);
/** Upper bound on files gathered from a non-git walk, so a huge tree cannot stall startup. */
const WALK_FILE_CAP = 5000;

/**
 * Arm an {@link ArgotSession} from the project's local cache, regenerating it
 * when the repository has moved. Best-effort: any failure is logged loudly and
 * leaves the session inert (shorthand simply stays off this session), never
 * silently degraded and never fatal to startup.
 *
 * The arming path is the sole way the session learns handles. There is no
 * load-on-read of a committed `AGENTS.dict`: the dictionary is generated and
 * kept outside the repository, and the handles are taught to the model through
 * {@link ArgotSession.promptFragment} at session start.
 */
export async function armArgotFromCache(argot: ArgotSession, cwd: string, signal?: AbortSignal): Promise<void> {
	try {
		const root = resolveProjectRoot(cwd);
		if (root === undefined) {
			// No project marker (.git or .argot): the cache is scoped to a project,
			// so with no project there is nothing to arm. Not an error.
			return;
		}

		const cachePath = cacheDictPath(getArgotCacheDir(), hashPath(root));
		const revPath = join(dirname(cachePath), "rev");
		const currentSha = await head.sha(root, signal);

		// Fast path: git HEAD unchanged since the cache was last written, and the
		// cache is present. Load it as-is, skip regeneration.
		if (currentSha !== null && (await readRev(revPath)) === currentSha) {
			const vocab = await readDictFile(cachePath);
			if (vocab !== undefined) {
				argot.loadVocab(vocab);
				return;
			}
		}

		const files = await gatherFiles(root, currentSha !== null, signal);
		const result = await regenerateProjectCache({ cachePath, files });
		if (result.handles.length > 0) {
			argot.loadVocab(result.vocab);
		}
		// Record the revision the cache now reflects, so the next session can take
		// the fast path. Only meaningful for a git project (a stable HEAD).
		if (currentSha !== null) {
			await writeFile(revPath, currentSha, "utf8");
		}
	} catch (error) {
		logger.warn("argot: cache generation failed; project shorthand is off this session", {
			error: String(error),
		});
	}
}

/** Read the recorded revision marker, or `undefined` when it is absent. */
async function readRev(revPath: string): Promise<string | undefined> {
	try {
		return (await readFile(revPath, "utf8")).trim();
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
}

/**
 * The repository file listing to learn from. For a git project this is
 * `git ls-files`, the exact set of paths the agent will type. For a project
 * opted in with a bare `.argot` marker there is no index, so walk the tree
 * (bounded and ignoring build output) instead.
 */
async function gatherFiles(root: string, isGit: boolean, signal?: AbortSignal): Promise<RepoFile[]> {
	if (isGit) {
		const tracked = await ls.files(root, { signal });
		return tracked.map(path => ({ path }));
	}
	return walkProject(root);
}

/** A bounded, ignore-aware recursive listing of a non-git project, repo-relative. */
async function walkProject(root: string): Promise<RepoFile[]> {
	const { readdir } = await import("node:fs/promises");
	const out: RepoFile[] = [];
	const stack: string[] = [""];
	while (stack.length > 0 && out.length < WALK_FILE_CAP) {
		const rel = stack.pop() as string;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (out.length >= WALK_FILE_CAP) break;
			if (entry.name.startsWith(".") && entry.name !== ".argot") continue;
			if (WALK_IGNORE.has(entry.name)) continue;
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				stack.push(childRel);
			} else if (entry.isFile()) {
				out.push({ path: childRel });
			}
		}
	}
	return out;
}
