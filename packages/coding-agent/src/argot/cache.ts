// Vendored from the standalone `argot` SDK. See ./constants.ts for the sync note.
/**
 * The local per-project dictionary cache.
 *
 * A harness keeps a generated `AGENTS.dict` outside the repository, under a
 * state directory it owns, one per project (see {@link projectCacheId}). This
 * module is the disk contract for that cache: where the file lives, how to read
 * it back into a vocabulary, how to write it without a torn read, and how to
 * regenerate it monotonically as the repository moves.
 *
 * Regeneration is monotonic because the existing cache is passed back in as the
 * frozen base: a handle already taught to the model keeps its exact meaning for
 * as long as the cache lives, so text that used a handle always expands. New
 * handles are content-addressed by default, so several agents regenerating one
 * shared cache pick the same name for the same string and never collide.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DICT_FILENAME } from "./constants";
import { isNotFound } from "./fs-util";
import { type GeneratedDict, type GenerateOptions, generateDictFromRepo, type RepoFile } from "./generate";
import { parseDict } from "./parse";
import type { Vocabulary } from "./types";

/**
 * The path to a project's cached dictionary: `<baseDir>/<cacheId>/AGENTS.dict`.
 * `baseDir` is the harness's own state directory (Argot does not choose it), and
 * `cacheId` is a stable {@link projectCacheId}. The per-id subdirectory gives
 * each project its own folder, so a harness can keep siblings (a HEAD marker, a
 * lock) next to the dictionary without collision.
 */
export function cacheDictPath(baseDir: string, cacheId: string): string {
	return join(baseDir, cacheId, DICT_FILENAME);
}

/**
 * Read a cached dictionary into a vocabulary.
 *
 * - No file: returns `undefined`. A project with no cache yet is not an error;
 *   the caller generates one.
 * - A present, valid file: returns the parsed vocabulary.
 * - A present but malformed file: throws `ArgotParseError`. The cache is never
 *   silently discarded and regenerated from scratch: a corrupt cache is an
 *   operator-visible fault, because regenerating from empty would strip every
 *   handle already written into live transcripts.
 *
 * Any read error other than "file not found" is rethrown for the same reason.
 */
export async function readDictFile(path: string): Promise<Vocabulary | undefined> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (err) {
		if (isNotFound(err)) {
			return undefined;
		}
		throw err;
	}
	return parseDict(content, path);
}

/** Monotonic counter making each temp filename unique within a process. */
let tempCounter = 0;

/**
 * Write dictionary text so a concurrent reader never sees a half-written file.
 * The content goes to a unique temp file in the same directory, then a single
 * `rename` swaps it into place: on a POSIX filesystem the rename is atomic, so a
 * reader sees either the old file or the whole new one. The parent directory is
 * created if missing.
 *
 * The temp name carries the process id and a per-process counter, so two agents
 * writing the same cache at once use different temp files and only the renames
 * race, which the atomic swap makes safe.
 */
export async function writeDictFileAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${tempCounter++}.tmp`;
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
}

/** Options for {@link regenerateProjectCache}. */
export interface RegenerateOptions {
	/** Absolute path to the cache file, from {@link cacheDictPath}. */
	cachePath: string;
	/** The repository listing to learn from, e.g. one {@link RepoFile} per tracked file. */
	files: RepoFile[];
	/**
	 * Generator options. The cache defaults `naming` to `"content"` so concurrent
	 * regenerations agree on handle names without coordination; override any field
	 * here. `pinned` is set automatically from the existing cache and cannot be
	 * overridden (that is what makes regeneration monotonic).
	 */
	options?: Omit<GenerateOptions, "pinned">;
}

/**
 * Regenerate a project's cache in place, monotonically.
 *
 * Reads the existing cache (if any), freezes it as the pinned base, generates a
 * fresh dictionary from `files` on top of it, and writes the result atomically.
 * Every handle already in the cache survives with its exact name and expansion;
 * new recurring strings are added under content-addressed names. When there is
 * no existing cache and nothing in `files` is worth a handle, the result is
 * empty and no file is written (an empty dictionary is not a valid file).
 *
 * Returns the full {@link GeneratedDict} so the caller can arm a session from
 * `result.vocab` directly, without re-reading the file it just wrote.
 */
export async function regenerateProjectCache(params: RegenerateOptions): Promise<GeneratedDict> {
	const existing = await readDictFile(params.cachePath);
	const result = generateDictFromRepo(params.files, {
		naming: "content",
		...params.options,
		pinned: existing,
	});
	if (result.toml !== "") {
		await writeDictFileAtomic(params.cachePath, result.toml);
	}
	return result;
}
