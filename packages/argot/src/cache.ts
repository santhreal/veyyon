/**
 * The local per-project dictionary cache.
 *
 * A harness keeps a generated `AGENTS.dict` outside the repository, under a state
 * directory it owns, one per project (see {@link projectCacheId}). This module is
 * the disk contract for that cache: where an entry lives, how to read it back
 * into a vocabulary, how to write it without a torn read, and how to resolve the
 * entry for a given state of the repository.
 *
 * The cache is **content-keyed and immutable**. Each entry is named by a content
 * signature (the git HEAD, or {@link listingSignature} for a project with no
 * git), and once written for a signature it is never mutated. A repository that
 * moves produces a new signature and a new entry; the old one stays put. This is
 * what makes the cache safe under many sessions and subagents at once: two agents
 * on the same state read the same entry, two agents on different states read
 * different entries, and nothing writes over a file another reader holds. There
 * is no shared mutable file to contend on.
 *
 * Handles are content-addressed by default, so if two agents do generate the same
 * entry concurrently they produce byte-identical text and the atomic rename makes
 * the race harmless.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNotFound } from "./fs-util.js";
import { type GenerateOptions, generateDictFromRepo, type RepoFile } from "./generate.js";
import { parseDict } from "./parse.js";
import type { Vocabulary } from "./types.js";

/**
 * The path to one immutable cache entry: `<baseDir>/<cacheId>/<contentSig>.dict`.
 * `baseDir` is the harness's own state directory (Argot does not choose it),
 * `cacheId` is a stable {@link projectCacheId}, and `contentSig` names the state
 * of the repository the entry was generated from. The per-id subdirectory groups
 * a project's entries; the signature in the filename keeps distinct states from
 * overwriting one another.
 */
export function cacheDictPath(baseDir: string, cacheId: string, contentSig: string): string {
	return join(baseDir, cacheId, `${contentSig}.dict`);
}

/**
 * A content signature for a repository with no git HEAD to key on.
 *
 * It is a hash of the sorted file listing: each entry contributes its path and,
 * when contents are supplied, a hash of those contents, so the signature changes
 * exactly when a file is added, removed, renamed, or edited. A git project should
 * key on its HEAD instead; this is the fallback for a project opted in with a
 * bare `.argot` marker, so that project also skips regeneration when nothing has
 * changed. The result is a lowercase hex string safe to use as a filename.
 */
export function listingSignature(files: RepoFile[]): string {
	const lines = files.map(file => {
		const contentHash = file.content === undefined ? "" : sha256(file.content);
		return `${file.path}\0${contentHash}`;
	});
	lines.sort();
	return sha256(lines.join("\n")).slice(0, 32);
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Read a cached dictionary into a vocabulary.
 *
 * - No file: returns `undefined`. A state with no entry yet is not an error; the
 *   caller generates one.
 * - A present, valid file: returns the parsed vocabulary.
 * - A present but malformed file: throws `ArgotParseError`. The cache is never
 *   silently discarded and regenerated from scratch: a corrupt entry is an
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
 * Write dictionary text so no reader ever sees a half-written file, and so a
 * failed write leaves nothing behind.
 *
 * The content goes to a unique temp file in the same directory, is flushed to
 * the device, and is then swapped into place with a single `rename`: on a POSIX
 * filesystem that rename is atomic, so a reader sees either no file or the whole
 * new one. The parent directory is created if missing.
 *
 * The temp name carries the process id and a per-process counter, so two agents
 * writing the same entry at once use different temp files and only the renames
 * race, which the atomic swap makes safe.
 *
 * TWO THINGS THIS DOES THAT A BARE write-then-rename DOES NOT, both of which
 * matter most on exactly the day you can least afford them, when the disk is
 * full.
 *
 * It FSYNCS BEFORE RENAMING. Without that, the ordering guarantee is only
 * against a concurrent reader, not against a crash: a filesystem is free to make
 * the rename durable before the data, and the entry then comes back after a
 * power loss as a zero-length file. A dictionary that parses as empty is worse
 * than one that is missing, because a missing entry regenerates and an empty one
 * silently encodes nothing.
 *
 * It REMOVES THE TEMP ON FAILURE and rethrows. Every caller here is writing an
 * immutable, content-keyed entry, so a failure must leave the cache exactly as
 * it was. A leaked temp would otherwise accumulate one file per failed attempt
 * in the same directory that just ran out of room, and the temp names are unique
 * by construction, so nothing would ever reclaim them.
 *
 * The error is never swallowed. A cache write that quietly does nothing turns
 * into a silent cache miss on every later run, which reads as "argot is slow"
 * rather than "the disk is full".
 */
export async function writeDictFileAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${tempCounter++}.tmp`;
	try {
		const handle = await open(temp, "w", 0o600);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (err) {
		// Both cleanups drop their own failure on purpose. The write error and the rename error are what the
		// caller acts on, and they are rethrown untouched; reporting a failed `rm` instead would replace the
		// real reason with a less useful one. The cost of dropping it is one leftover `*.tmp` beside the file.
		await rm(temp, { force: true }).catch(() => {});
		throw err;
	}
	try {
		await rename(temp, path);
	} catch (err) {
		await rm(temp, { force: true }).catch(() => {});
		throw err;
	}
}

/** Options for {@link resolveProjectCache}. */
export interface ResolveCacheOptions {
	/** The harness's state directory that holds every project's cache. */
	baseDir: string;
	/** A stable {@link projectCacheId} for the project. */
	cacheId: string;
	/**
	 * The signature of the repository state to key on: the git HEAD for a git
	 * project, or {@link listingSignature} of the same `files` for one without git.
	 */
	contentSig: string;
	/** The repository listing to generate from on a miss, e.g. one {@link RepoFile} per tracked file. */
	files: RepoFile[];
	/**
	 * Generator options for a miss. The cache defaults `naming` to `"mnemonic"`,
	 * whose deterministic-short scheme (bare stem when unique, shortest hash prefix
	 * only on a stem collision) mints names that are a pure function of the
	 * expansion SET — so concurrent generations of the same entry still agree
	 * byte-for-byte, while handles stay short enough to actually save tokens.
	 * Override any field here.
	 */
	options?: GenerateOptions;
}

/** The outcome of {@link resolveProjectCache}. */
export interface ResolvedCache {
	/** The vocabulary for this state, ready to arm a session with. Empty when nothing was worth a handle. */
	vocab: Vocabulary;
	/** The entry path resolved to. */
	path: string;
	/** `true` when read from an existing entry, `false` when freshly generated. */
	hit: boolean;
	/**
	 * Set when the freshly generated entry could not be persisted (a read-only or
	 * full state directory, a permission change, a vanished parent). The
	 * vocabulary in {@link vocab} is complete and correct regardless: only the
	 * saving of it failed, so the session is armed identically and just pays the
	 * generation cost again next time.
	 *
	 * This is never `undefined` for a silent reason. Argot has no logger of its
	 * own (it publishes standalone, so it cannot depend on a harness), so the
	 * failure travels back on the value and the caller is responsible for
	 * surfacing it. `resolveProjectVocab` does that through its notice sink.
	 */
	writeError?: string;
}

/**
 * Resolve a project's cache entry for one repository state, generating it only on
 * a miss.
 *
 * If the entry for `contentSig` already exists, it is read and returned verbatim
 * (`hit: true`); the cache is immutable, so an existing entry is never
 * regenerated or overwritten. On a miss, a fresh dictionary is generated from
 * `files` with short deterministic mnemonic names and written atomically (`hit: false`).
 * When nothing in `files` is worth a handle the result is an empty vocabulary and
 * no file is written, because an empty dictionary is not a valid file.
 *
 * A malformed existing entry throws `ArgotParseError` (via {@link readDictFile})
 * rather than being silently rebuilt, so a corrupt cache surfaces to the operator
 * instead of stripping handles already written into live transcripts.
 *
 * The two disk failures are deliberately handled differently, because they mean
 * different things. A failed READ is a fault: the entry exists and cannot be
 * trusted, so it throws. A failed WRITE is only a lost optimisation: the
 * dictionary was generated in memory and is already correct, and a cache that
 * cannot save is supposed to be slower, not wrong. So the write failure is
 * caught, the correct vocabulary is returned, and the failure is reported on
 * {@link ResolvedCache.writeError} for the caller to surface. It is never
 * swallowed.
 */
export async function resolveProjectCache(params: ResolveCacheOptions): Promise<ResolvedCache> {
	const path = cacheDictPath(params.baseDir, params.cacheId, params.contentSig);

	const existing = await readDictFile(path);
	if (existing !== undefined) {
		return { vocab: existing, path, hit: true };
	}

	const result = generateDictFromRepo(params.files, { naming: "mnemonic", ...params.options });
	if (result.toml === "") {
		return { vocab: result.vocab, path, hit: false };
	}

	try {
		await writeDictFileAtomic(path, result.toml);
	} catch (err) {
		return { vocab: result.vocab, path, hit: false, writeError: describeWriteFailure(path, err) };
	}
	return { vocab: result.vocab, path, hit: false };
}

/**
 * The write-failure message: what could not be saved, where, why, and what it
 * costs. The consequence is stated because it is the part an operator cannot
 * infer, and because it is the part that makes the line safe to ignore under
 * time pressure without fearing a wrong dictionary.
 */
function describeWriteFailure(path: string, err: unknown): string {
	const reason = err instanceof Error ? err.message : String(err);
	return `argot: could not save the generated dictionary to ${path} (${reason}); the dictionary itself is correct and in use, but it will be regenerated on every session until this directory is writable`;
}
