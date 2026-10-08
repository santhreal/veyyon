/**
 * Resolution of a read path to a file on disk: the literal path, then a unique suffix match within
 * the working directory, and the archive and SQLite candidates a path with a member suffix names.
 */

import type { Stats } from "node:fs";
import * as path from "node:path";
import { glob } from "@veyyon/natives";
import { isAbortError, isTimeoutError, untilAborted } from "@veyyon/utils/abortable";
import { getRemoteDir } from "@veyyon/utils/dirs";
import { isMissingPath } from "@veyyon/utils/fs-error";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { parseArchivePathCandidates } from "../../utils/zip";
import { resolveReadPath } from "../core/path-utils";
import { isSqliteFile, parseSqlitePathCandidates } from "../core/sqlite-reader";
import { throwIfAborted } from "../core/tool-errors";

// Remote mount path prefix (sshfs mounts) - skip fuzzy matching to avoid
// hangs. Resolved per call, not frozen at module load: the dirs resolver is
// rebuilt after profile/agent `.env` files apply, AFTER this module imports.
function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(getRemoteDir() + path.sep);
}

const GLOB_TIMEOUT_MS = 5000;

/**
 * Escape glob metacharacters so a literal path (e.g. `foo[1].ts`) interpolated
 * into a suffix-glob pattern matches itself. Each metachar is wrapped in a
 * character class (the native glob engine rewrites `\` to `/`, so backslash
 * escaping is unavailable). `]`/`}` need no escaping once their openers are
 * neutralized — unmatched closers are literal.
 */
function escapeGlobMetachars(value: string): string {
	return value.replace(/[*?[{]/g, "[$&]");
}

/**
 * Attempt to resolve a non-existent path by finding a unique suffix match within the workspace.
 * Uses a glob suffix pattern so the native engine handles matching directly.
 * Returns null when 0 or >1 candidates match (ambiguous = no auto-resolution).
 */
async function findUniqueSuffixMatch(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const normalized = trimTrailingSlashes(rawPath.replace(/\\/g, "/").replace(/^\.\//, ""));
	if (!normalized) return null;
	const pattern = `**/${escapeGlobMetachars(normalized)}`;

	// scopedTimeoutSignal cancels the backing timer on settle, so the glob
	// timeout never outlives the walk (a bare AbortSignal.timeout would keep its
	// timer armed for the full window and accumulate under load).
	const { signal: combinedSignal, cancel } = scopedTimeoutSignal(GLOB_TIMEOUT_MS, signal);

	let matches: string[];
	try {
		const result = await untilAborted(combinedSignal, () =>
			glob({
				pattern,
				path: cwd,
				// No fileType filter: matches both files and directories
				hidden: true,
			}),
		);
		matches = result.matches.map(m => m.path);
	} catch (error) {
		// The suffix search is a convenience, so a deadline on it is not the
		// caller's problem: give up silently and let the path resolve as missing.
		// A real cancellation is the caller's problem and must propagate with its
		// reason, so the operator learns why the read stopped rather than reading
		// the generic sentinel.
		//
		// This used to ask `isAbortError` and then infer which of the two had
		// happened from `!signal?.aborted`, because `AbortError` stamped its own
		// name over the `TimeoutError` reason and the guard could not see a
		// timeout as one. The error now carries its own name, so the question is
		// asked directly.
		if (isTimeoutError(error)) return null;
		if (isAbortError(error)) throwIfAborted(signal, "read");
		return null;
	} finally {
		cancel();
	}

	if (matches.length !== 1) return null;

	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

export function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}

export interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

export interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
}

/** Per-execute memo of suffix-glob lookups; `null` records a confirmed miss. */
export type SuffixMatchCache = Map<string, { absolutePath: string; displayPath: string } | null>;

/** A path found on disk, with the suffix match that found it when the literal path was missing. */
export type ResolvedReadPath = {
	absolutePath: string;
	stat: Stats;
	suffixResolution?: { from: string; to: string };
};

/**
 * Memoized {@link findUniqueSuffixMatch} for a single read call. A missing
 * path with archive/sqlite extensions probes the workspace once per stage
 * (archive candidates, sqlite candidates, plain path) — each glob carries a
 * 5s timeout, so repeated lookups of the same string stack into a long
 * stall before erroring. The cache collapses repeats within one execute().
 */
async function findSuffixMatchCached(
	cwd: string,
	cache: SuffixMatchCache,
	rawPath: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const hit = cache.get(rawPath);
	if (hit !== undefined) return hit;
	const result = await findUniqueSuffixMatch(rawPath, cwd, signal);
	cache.set(rawPath, result);
	return result;
}

export async function statCandidateWithSuffix(
	cwd: string,
	rawPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
	options: { throwNonMissing?: boolean } = {},
): Promise<ResolvedReadPath | null> {
	const absolutePath = resolveReadPath(rawPath, cwd);
	try {
		const stat = await Bun.file(absolutePath).stat();
		return { absolutePath, stat };
	} catch (error) {
		if (!isMissingPath(error)) {
			if (options.throwNonMissing) throw error;
			return null;
		}
		if (isRemoteMountPath(absolutePath)) return null;
		const suffixMatch = await findSuffixMatchCached(cwd, suffixCache, rawPath, signal);
		if (!suffixMatch) return null;
		try {
			const stat = await Bun.file(suffixMatch.absolutePath).stat();
			return {
				absolutePath: suffixMatch.absolutePath,
				stat,
				suffixResolution: { from: rawPath, to: suffixMatch.displayPath },
			};
		} catch (retryError) {
			if (!isMissingPath(retryError)) throw retryError;
			return null;
		}
	}
}

export async function resolveArchiveReadPath(
	cwd: string,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedArchiveReadPath | null> {
	for (const candidate of parseArchivePathCandidates(readPath)) {
		const resolved = await statCandidateWithSuffix(cwd, candidate.archivePath, suffixCache, signal);
		if (resolved && !resolved.stat.isDirectory()) {
			return {
				absolutePath: resolved.absolutePath,
				archiveSubPath: candidate.archivePath === readPath ? "" : candidate.subPath,
				suffixResolution: resolved.suffixResolution,
			};
		}
	}
	return null;
}

export async function resolveSqliteReadPath(
	cwd: string,
	readPath: string,
	suffixCache: SuffixMatchCache,
	signal?: AbortSignal,
): Promise<ResolvedSqliteReadPath | null> {
	for (const candidate of parseSqlitePathCandidates(readPath)) {
		const resolved = await statCandidateWithSuffix(cwd, candidate.sqlitePath, suffixCache, signal);
		if (resolved && !resolved.stat.isDirectory() && (await isSqliteFile(resolved.absolutePath))) {
			return {
				absolutePath: resolved.absolutePath,
				sqliteSubPath: candidate.subPath,
				queryString: candidate.queryString,
				suffixResolution: resolved.suffixResolution,
			};
		}
	}
	return null;
}
