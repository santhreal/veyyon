import * as path from "node:path";
import { Glob } from "bun";
import { getProjectDir } from "./dirs";
import { scopedTimeoutSignal } from "./scoped-timeout";

export interface GlobPathsOptions {
	/** Base directory for glob patterns. Defaults to getProjectDir(). */
	cwd?: string;
	/** Glob exclusion patterns. */
	exclude?: string[];
	/** Abort signal to cancel the glob. */
	signal?: AbortSignal;
	/** Timeout in milliseconds for the glob operation. */
	timeoutMs?: number;
	/** Include dotfiles when true. */
	dot?: boolean;
	/** Only return files (skip directories). Default: true. */
	onlyFiles?: boolean;
	/** Respect .gitignore files when true. Walks up directory tree to find all applicable .gitignore files. */
	gitignore?: boolean;
}

/** Patterns always excluded (.git is never useful in glob results). */
const ALWAYS_IGNORED = ["**/.git", "**/.git/**"];

/** node_modules exclusion patterns (skipped if pattern explicitly references node_modules). */
const NODE_MODULES_IGNORED = ["**/node_modules", "**/node_modules/**"];

/**
 * Anchor a gitignore pattern to its .gitignore directory and re-express it as
 * exclude globs relative to the search base. Gitignore anchors any pattern that
 * carries a slash other than a trailing one (both `/foo` and `foo/bar`) to the
 * directory of the .gitignore itself; only a slash-free name (`foo`) is allowed
 * to match at any depth. `relativePattern` is the pattern with any leading `/`
 * already removed.
 *
 * Two globs are always returned: the name itself (which matches a file of that
 * name) and `<name>/**` (which matches the contents when the name is a
 * directory). A bare gitignore entry like `dist` ignores both a file `dist` and
 * a directory `dist/` with everything under it, and `**` does not match across
 * the final path segment, so the contents variant is required or a directory's
 * files leak through. Returns an empty array when the target resolves outside
 * `baseDir` (it can then match nothing under it).
 */
function anchorGitignorePattern(relativePattern: string, gitignoreDir: string, baseDir: string): string[] {
	const absolutePattern = path.join(gitignoreDir, relativePattern);
	const relativeToBase = path.relative(baseDir, absolutePattern);
	if (relativeToBase.startsWith("..")) return [];
	const anchored = relativeToBase.replace(/\\/g, "/");
	if (!anchored) return [];
	return [anchored, `${anchored}/**`];
}

/**
 * Parse a single .gitignore file and return glob-compatible exclude patterns.
 * @param content - Raw content of the .gitignore file
 * @param gitignoreDir - Absolute path to the directory containing the .gitignore
 * @param baseDir - Absolute path to the glob's cwd (for relativizing rooted patterns)
 */
export function parseGitignorePatterns(content: string, gitignoreDir: string, baseDir: string): string[] {
	const patterns: string[] = [];

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		// Skip empty lines and comments
		if (!line || line.startsWith("#")) {
			continue;
		}
		// Skip negation patterns (unsupported for simple exclude)
		if (line.startsWith("!")) {
			continue;
		}

		let pattern = line;

		// A trailing slash means "directory only" in gitignore. We strip it and
		// then emit the same globs as a bare name: under `onlyFiles` the directory
		// entry itself yields no result, so what matters either way is excluding
		// the directory's contents, which the `<name>/**` glob below always covers.
		if (pattern.endsWith("/")) {
			pattern = pattern.slice(0, -1);
		}

		// A slash anywhere but the end anchors the pattern to the .gitignore's
		// directory (gitignore semantics); a bare name matches at any depth.
		if (pattern.startsWith("/")) {
			// Rooted: strip the leading slash, then anchor to the .gitignore dir.
			patterns.push(...anchorGitignorePattern(pattern.slice(1), gitignoreDir, baseDir));
		} else if (pattern.includes("/")) {
			// Unrooted but carries a mid-path slash: still anchored, NOT "match
			// anywhere". `src/generated` must exclude only `<gitignore>/src/generated`,
			// never `packages/foo/src/generated`.
			patterns.push(...anchorGitignorePattern(pattern, gitignoreDir, baseDir));
		} else {
			// No slash: match the file/dir name at any depth in the tree. The
			// `/**` variant excludes the contents when the name is a directory.
			patterns.push(`**/${pattern}`, `**/${pattern}/**`);
		}
	}

	return patterns;
}

/**
 * Load .gitignore patterns from a directory and its parents.
 * Walks up the directory tree to find all applicable .gitignore files.
 * Returns glob-compatible exclude patterns.
 */
export async function loadGitignorePatterns(baseDir: string): Promise<string[]> {
	const patterns: string[] = [];
	const absoluteBase = path.resolve(baseDir);

	let current = absoluteBase;
	const maxDepth = 50; // Prevent infinite loops

	for (let i = 0; i < maxDepth; i++) {
		const gitignorePath = path.join(current, ".gitignore");

		try {
			const content = await Bun.file(gitignorePath).text();
			const filePatterns = parseGitignorePatterns(content, current, absoluteBase);
			patterns.push(...filePatterns);
		} catch {
			// .gitignore doesn't exist or can't be read, continue
		}

		const parent = path.dirname(current);
		if (parent === current) {
			// Reached filesystem root
			break;
		}
		current = parent;
	}

	return patterns;
}

/**
 * The compiled patterns a walk drops, in order: `.git` always, `node_modules` unless a pattern names it,
 * the caller's `exclude`, then the `.gitignore` rules the caller loaded.
 *
 * Each is compiled once for the whole walk, not once per matched entry: with gitignore rules the list is
 * large, and per-entry compilation dominated a walk of a big tree.
 */
function compileExcludes(patterns: string[], exclude?: string[] | null, gitignored?: string[]): Glob[] {
	const fixed = patterns.some(p => p.includes("node_modules"))
		? ALWAYS_IGNORED
		: ALWAYS_IGNORED.concat(NODE_MODULES_IGNORED);
	return [...fixed, ...(exclude ?? []), ...(gitignored ?? [])].map(pattern => new Glob(pattern));
}

/** Throws the reason `signal` was aborted with, or an `AbortError` when that reason is not an `Error`. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw new DOMException("Aborted", "AbortError");
}

function matchesAny(globs: Glob[], file: string): boolean {
	for (const glob of globs) {
		if (glob.match(file)) return true;
	}
	return false;
}

/**
 * Resolve filesystem paths matching glob patterns with optional exclude filters.
 * Returns paths relative to the provided cwd (or getProjectDir()).
 * Errors and abort/timeouts are surfaced to the caller.
 */
export async function globPaths(patterns: string | string[], options: GlobPathsOptions = {}): Promise<string[]> {
	const { cwd, exclude, signal, timeoutMs, dot, onlyFiles = true, gitignore } = options;
	const patternArray = [patterns].flat();
	const base = cwd ?? getProjectDir();
	const gitignored = gitignore ? await loadGitignorePatterns(base) : undefined;
	const excludeGlobs = compileExcludes(patternArray, exclude, gitignored);
	const scanOptions = { cwd: base, dot, onlyFiles, throwErrorOnBrokenSymlink: false };
	const allResults: string[] = [];
	// Dedup across patterns: two input patterns can match the same file (e.g.
	// `**/*.ts` and `src/**`), and a path list must not report a file twice.
	const seen = new Set<string>();

	// Combine timeout and abort signals; the scoped handle clears its backing
	// timer once the walk settles instead of leaving it armed like a bare
	// AbortSignal.timeout.
	const scopedTimeout = timeoutMs ? scopedTimeoutSignal(timeoutMs, signal) : undefined;
	const combinedSignal = scopedTimeout?.signal ?? signal;

	try {
		for (const pattern of patternArray) {
			for await (const entry of new Glob(pattern).scan(scanOptions)) {
				throwIfAborted(combinedSignal);
				const normalized = entry.includes("\\") ? entry.replace(/\\/g, "/") : entry;
				if (seen.has(normalized) || matchesAny(excludeGlobs, normalized)) continue;
				seen.add(normalized);
				allResults.push(normalized);
			}
		}
	} finally {
		scopedTimeout?.cancel();
	}

	return allResults;
}
