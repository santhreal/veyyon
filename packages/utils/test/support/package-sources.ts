import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * ONE owner for the monorepo "collect every package's TypeScript sources"
 * traversal that the repo-wide source-ownership lock suites share.
 *
 * Thirteen lock tests (escapeRegExp, isRecord/type-guards, estimateTokens,
 * atomic temp+rename, string-case, url, backoff, time, sleep, math,
 * collapse-whitespace, strip-ansi, alnum-regex) each hand-rolled this same walk
 * with an independently maintained skip-set, and the copies drifted: some
 * skipped `vendor` and some did not; some excluded the standalone `argot`
 * package and some did not. A divergent skip-set is a latent lock hole — a
 * second copy of a locked primitive can hide in a directory one lock skips and
 * another scans, so the ownership guarantee silently depends on which suite you
 * read. Centralizing the skip-set here makes every lock agree, byte for byte,
 * on what "a package source file" is.
 */

/**
 * Directory names never descended into, at any depth: dependency trees, build
 * output, and vendored third-party code (which legitimately carries its own
 * copies of these primitives and must not be judged against the utils owner).
 */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", "dist", "vendor"]);

/**
 * Package roots (and same-named nested dirs, e.g. a vendored `src/argot/`)
 * exempt from every `@veyyon/utils` single-owner lock. `argot` is a standalone
 * published package (its only dependency is smol-toml); it cannot import
 * `@veyyon/utils` and carries its own copies of these utilities by design, so
 * scanning it would false-positive the ownership locks.
 */
export const EXEMPT_PACKAGE_NAMES: ReadonlySet<string> = new Set(["argot"]);

/** Absolute path to the monorepo `packages/` directory. */
export const PACKAGES_DIR = path.resolve(import.meta.dir, "..", "..", "..");

async function walk(dir: string, includeTests: boolean, out: string[]): Promise<void> {
	// A missing subdir (an assets-only package has no src/, a src-only scan finds
	// no test/) is not an error — there is simply nothing to scan there.
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name) || EXEMPT_PACKAGE_NAMES.has(entry.name)) continue;
			await walk(full, includeTests, out);
		} else if (entry.name.endsWith(".ts") && (includeTests || !entry.name.endsWith(".test.ts"))) {
			out.push(full);
		}
	}
}

export interface CollectPackageSourcesOptions {
	/** Per-package subdirectories to scan. Defaults to `["src"]` (production). */
	dirs?: readonly string[];
	/**
	 * Include `*.test.ts` files. Defaults to `false`. Turn on to also lock test
	 * helpers, where a hand-rolled copy of a locked primitive drifts just as a
	 * production copy does and the src-only scan never sees it.
	 */
	includeTests?: boolean;
}

/** Absolute paths of every matching `.ts` file across non-exempt packages. */
export async function collectPackageSourceFiles(options: CollectPackageSourcesOptions = {}): Promise<string[]> {
	const dirs = options.dirs ?? ["src"];
	const includeTests = options.includeTests ?? false;
	const files: string[] = [];
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory() || EXEMPT_PACKAGE_NAMES.has(pkg.name)) continue;
		for (const sub of dirs) {
			await walk(path.join(PACKAGES_DIR, pkg.name, sub), includeTests, files);
		}
	}
	return files;
}

/** One collected file: its repo-relative, forward-slashed path and contents. */
export interface PackageSource {
	rel: string;
	text: string;
}

/**
 * Same coverage as {@link collectPackageSourceFiles}, but also reads each file
 * and returns `{ rel, text }` pairs. `rel` is relative to `packages/` with
 * forward slashes so allow-lists read the same on every platform.
 */
export async function collectPackageSources(options: CollectPackageSourcesOptions = {}): Promise<PackageSource[]> {
	const files = await collectPackageSourceFiles(options);
	const out: PackageSource[] = [];
	for (const file of files) {
		out.push({
			rel: path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/"),
			text: await readFile(file, "utf8"),
		});
	}
	return out;
}
