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
 *
 * `repo-cache` is the deepswe benchmark's tree of cloned upstream projects: 113
 * of them, about 1.9G, each with its own sources and test suite. Judging another
 * project's code against this repository's ownership locks is meaningless, and
 * walking it turns a lock that reads a few thousand files into one that reads
 * hundreds of thousands.
 */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", "dist", "vendor", "repo-cache"]);

/**
 * Packages exempt from every `@veyyon/utils` single-owner lock, named by their
 * PUBLISHED name (`package.json` `name`), not their directory. `argot` is a
 * standalone published package (its only dependency is smol-toml); it cannot
 * import `@veyyon/utils` and carries its own copies of these utilities by
 * design, so scanning it would false-positive the ownership locks.
 *
 * Matching on the published name rather than the directory name is the point:
 * the exemption was originally keyed on the directory, the package's directory
 * was renamed to `packages/lexpack`, and the exemption silently stopped
 * matching (it is `packages/argot` again as of 2026-07-25, which changes nothing
 * about why the name is the key). Six ownership locks then failed against a package that is exempt by
 * design. A published name is the package's stable identity; a directory name
 * is not. `packageNameFor` resolves it, and `resolveExemptPackageDirs` fails
 * loudly when an entry names no package at all, so an exemption can never again
 * go quietly dead.
 */
export const EXEMPT_PACKAGE_NAMES: ReadonlySet<string> = new Set(["argot"]);

/** The `name` declared by `packages/<dir>/package.json`, or undefined. */
async function packageNameFor(dirName: string): Promise<string | undefined> {
	const manifest = path.join(PACKAGES_DIR, dirName, "package.json");
	const text = await readFile(manifest, "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	const parsed: unknown = JSON.parse(text);
	const name = (parsed as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/**
 * Directory names under `packages/` whose package is exempt.
 *
 * Throws when an {@link EXEMPT_PACKAGE_NAMES} entry matches no package, because
 * the only two ways that happens are both defects: the package was deleted (the
 * entry is stale and must go) or it was renamed (the exemption is dead and the
 * locks are now scanning a package they must not judge). Either way the fix is a
 * source edit, never a silent skip.
 */
export async function resolveExemptPackageDirs(): Promise<ReadonlySet<string>> {
	const dirs = new Set<string>();
	const matched = new Set<string>();
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const name = (await packageNameFor(pkg.name)) ?? pkg.name;
		if (!EXEMPT_PACKAGE_NAMES.has(name)) continue;
		dirs.add(pkg.name);
		matched.add(name);
	}
	const missing = [...EXEMPT_PACKAGE_NAMES].filter(name => !matched.has(name));
	if (missing.length > 0) {
		throw new Error(
			`package-sources: EXEMPT_PACKAGE_NAMES names no package under ${PACKAGES_DIR}: ${missing.join(", ")}. ` +
				`Either the package was removed (delete the entry) or it was renamed (update the entry to its new ` +
				`package.json "name"). Leaving it would make every @veyyon/utils ownership lock scan a package that ` +
				`is exempt by design.`,
		);
	}
	return dirs;
}

/** Absolute path to the monorepo `packages/` directory. */
export const PACKAGES_DIR = path.resolve(import.meta.dir, "..", "..", "..");

async function walk(dir: string, includeTests: boolean, out: string[], includeExempt = false): Promise<void> {
	// A missing subdir (an assets-only package has no src/, a src-only scan finds
	// no test/) is not an error — there is simply nothing to scan there.
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			if (!includeExempt && EXEMPT_PACKAGE_NAMES.has(entry.name)) continue;
			await walk(full, includeTests, out, includeExempt);
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
	/**
	 * Also scan packages in {@link EXEMPT_PACKAGE_NAMES}. Defaults to `false`.
	 *
	 * That exemption is specific to the `@veyyon/utils` single-owner locks: a
	 * standalone published package carries its own copies of those primitives by
	 * design. A caller asking a different question of the tree usually must NOT
	 * inherit it. The tripwire-preload lock is the case that exists: `argot` has
	 * tests like every other package and therefore needs the same guard, so
	 * exempting it there would be a hole rather than a courtesy.
	 */
	includeExemptPackages?: boolean;
}

/** Absolute paths of every matching `.ts` file across non-exempt packages. */
export async function collectPackageSourceFiles(options: CollectPackageSourcesOptions = {}): Promise<string[]> {
	const dirs = options.dirs ?? ["src"];
	const includeTests = options.includeTests ?? false;
	const files: string[] = [];
	const exemptDirs = options.includeExemptPackages ? new Set<string>() : await resolveExemptPackageDirs();
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory() || exemptDirs.has(pkg.name)) continue;
		for (const sub of dirs) {
			await walk(path.join(PACKAGES_DIR, pkg.name, sub), includeTests, files, options.includeExemptPackages);
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
