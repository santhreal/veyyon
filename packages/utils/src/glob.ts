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
 * Resolve filesystem paths matching glob patterns with optional exclude filters.
 * Returns paths relative to the provided cwd (or getProjectDir()).
 * Errors and abort/timeouts are surfaced to the caller.
 */
export async function globPaths(patterns: string | string[], options: GlobPathsOptions = {}): Promise<string[]> {
	const { cwd, exclude, signal, timeoutMs, dot, onlyFiles = true, gitignore } = options;

	// Build exclude list: always exclude .git, exclude node_modules unless pattern references it
	const patternArray = Array.isArray(patterns) ? patterns : [patterns];
	const mentionsNodeModules = patternArray.some(p => p.includes("node_modules"));

	const baseExclude = mentionsNodeModules ? [...ALWAYS_IGNORED] : [...ALWAYS_IGNORED, ...NODE_MODULES_IGNORED];
	let effectiveExclude = exclude ? [...baseExclude, ...exclude] : baseExclude;

	if (gitignore) {
		const gitignorePatterns = await loadGitignorePatterns(cwd ?? getProjectDir());
		effectiveExclude = [...effectiveExclude, ...gitignorePatterns];
	}

	const base = cwd ?? getProjectDir();
	const allResults: string[] = [];
	// Dedup across patterns: two input patterns can match the same file (e.g.
	// `**/*.ts` and `src/**`), and a path list must not report a file twice.
	const seen = new Set<string>();

	// Compile each exclude glob once, not once per matched entry. The exclude set
	// is fixed for the whole walk, so rebuilding a `Glob` inside the per-entry loop
	// did O(entries * excludes) compilations — with gitignore enabled the exclude
	// list is large, so this was the dominant cost on big trees.
	const excludeGlobs = effectiveExclude.map(pattern => new Glob(pattern));

	// Combine timeout and abort signals; the scoped handle clears its backing
	// timer once the walk settles instead of leaving it armed like a bare
	// AbortSignal.timeout.
	const scopedTimeout = timeoutMs ? scopedTimeoutSignal(timeoutMs, signal) : undefined;
	const combinedSignal = scopedTimeout?.signal ?? signal;

	try {
		for (const pattern of patternArray) {
			const glob = new Glob(pattern);
			const scanOptions = {
				cwd: base,
				dot,
				onlyFiles,
				throwErrorOnBrokenSymlink: false,
			};

			for await (const entry of glob.scan(scanOptions)) {
				if (combinedSignal?.aborted) {
					const reason = combinedSignal.reason;
					if (reason instanceof Error) throw reason;
					throw new DOMException("Aborted", "AbortError");
				}

				const normalized = entry.replace(/\\/g, "/");
				if (seen.has(normalized)) continue;
				let excluded = false;
				for (const excludeGlob of excludeGlobs) {
					if (excludeGlob.match(normalized)) {
						excluded = true;
						break;
					}
				}
				if (!excluded) {
					seen.add(normalized);
					allResults.push(normalized);
				}
			}
		}
	} finally {
		scopedTimeout?.cancel();
	}

	return allResults;
}
