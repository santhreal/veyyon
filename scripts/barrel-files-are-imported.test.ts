/**
 * A `<dir>/index.ts` exists only when something imports it. A barrel nobody imports is deleted, not kept.
 *
 * WHY THIS SUITE EXISTS. The tree has 80-odd directory barrels and the convention is that the barrel IS
 * the import point for its directory: `packages/coding-agent/src/async/index.ts` is how the async job
 * machinery is reached, and the directory's own modules are an implementation detail behind it. Eight
 * barrels were not that. Nothing imported them, because every consumer reached the sibling module
 * directly -- `sdk.ts` imports `../repair/agent-hook`, `memory-backend/resolve.ts` imports
 * `../mnemopi/backend` -- so each barrel was a SECOND declaration of its directory's public surface, with
 * no way for a reader to tell which of the two lists was authoritative. Adding an export to
 * `schema-repair.ts` left the barrel silently incomplete and nothing noticed, which is exactly the
 * `one re-export point` violation Law 8 names.
 *
 * A grep cannot find this. Every symbol those barrels re-exported was genuinely in use, just never
 * through the barrel, so each one reads as live from every angle except the import graph. That is why the
 * rule is enforced here by resolving specifiers rather than by searching for names: the question is not
 * "is this symbol used" but "does any file import THIS FILE".
 *
 * The rule is stated once for the repo instead of decided per directory. A new `<dir>/index.ts` that
 * nothing imports fails this test, so the author resolves it at the time -- either consumers get pointed
 * at the barrel, or the barrel does not get written.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { existingOnly, readIfPresent } from "./check-doc-links";

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesRoot = path.join(repoRoot, "packages");

/**
 * Tracked TypeScript under `prefix`, listed from git rather than walked.
 *
 * Walking is wrong here for two reasons that both bite. `packages/deepswe-bench/repo-cache` holds several
 * gigabytes of cloned upstream repositories, each with its own `src/**\/index.ts` files that have nothing
 * to do with this convention, and those clones contain dangling symlinks that make a plain `statSync`
 * walk throw outright. Git's list is the source tree by definition, so vendored, cached and generated
 * trees are excluded because they are untracked, not because a skip list happened to name them.
 *
 * The listing is filtered to what is on disk, because git reports the index and an uncommitted deletion
 * is an ordinary state in this tree.
 */
function trackedSources(prefix: string): string[] {
	const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", `${prefix}/*.ts`, `${prefix}/*.tsx`], {
		cwd: repoRoot,
	});
	if (!listed.success)
		throw new Error(`git ls-files failed for ${prefix}: ${new TextDecoder().decode(listed.stderr)}`);
	const listedPaths = new TextDecoder()
		.decode(listed.stdout)
		.split("\0")
		.filter(entry => entry !== "");
	// The index also lists a file the working tree no longer has, which is what an uncommitted deletion
	// looks like. Without this the eight barrels this suite exists to remove came back as orphans after
	// they were deleted, so the gate demanded a fix for files that were already gone. `existingOnly` is
	// the repo's one owner for that question; see `tracked-but-deleted-paths.test.ts`.
	return existingOnly(repoRoot, listedPaths).map(entry => path.join(repoRoot, entry));
}

/** `@veyyon/<name>` to its package directory, read from the workspace rather than assumed from the path. */
function workspacePackages(): Map<string, string> {
	const byName = new Map<string, string>();
	for (const entry of readdirSync(packagesRoot)) {
		const manifest = path.join(packagesRoot, entry, "package.json");
		let raw: string;
		try {
			raw = readFileSync(manifest, "utf8");
		} catch {
			continue;
		}
		const name = (JSON.parse(raw) as { name?: string }).name;
		if (name) byName.set(name, path.join(packagesRoot, entry));
	}
	return byName;
}

const PACKAGES = workspacePackages();

/**
 * Import and export specifiers, including the `import(...)` form.
 *
 * Dynamic imports matter as much as static ones here: the plugin marketplace and several TUI panels are
 * loaded lazily precisely so their module graph stays out of startup, and a barrel reached only that way
 * is still imported.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/**
 * The file a specifier resolves to, or `undefined` for anything outside the workspace.
 *
 * Extension resolution follows what the runtime accepts for these packages: an exact path, `.ts`, and
 * `<dir>/index.ts`. `.js` specifiers are mapped to `.ts` because the manifests do that too
 * (`"./*.js": "./src/*.ts"`), so a compiled-style import still counts as reaching the barrel.
 */
function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
	let base: string;
	if (specifier.startsWith(".")) {
		base = path.resolve(path.dirname(fromFile), specifier);
	} else {
		const match = [...PACKAGES.entries()].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
		if (!match) return undefined;
		const [name, dir] = match;
		const subpath = specifier === name ? "" : specifier.slice(name.length + 1);
		base = path.join(dir, "src", subpath);
	}
	const withoutJs = base.endsWith(".js") ? base.slice(0, -3) : base;
	for (const candidate of [base, withoutJs, `${withoutJs}.ts`, `${withoutJs}.tsx`, path.join(withoutJs, "index.ts")]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Not this candidate; the next form may exist. A specifier that resolves to nothing is a
			// broken import, which is `tsc`'s job to report, not this test's.
		}
	}
	return undefined;
}

/** Every workspace file that any workspace file imports. */
function importedFiles(): Set<string> {
	const imported = new Set<string>();
	for (const file of trackedSources("packages").concat(trackedSources("scripts"))) {
		// Listed from the index, read from the working tree: a file deleted since the listing is not an
		// importer, and must not take the whole gate down.
		const text = readIfPresent(file);
		if (text === undefined) continue;
		for (const [, specifier] of text.matchAll(SPECIFIER)) {
			const resolved = resolveSpecifier(specifier as string, file);
			// A barrel that only imports itself proves nothing, so self-imports do not count.
			if (resolved && resolved !== file) imported.add(resolved);
		}
	}
	return imported;
}

/** Every `<dir>/index.ts` under a package `src/`, which is where the convention applies. */
function barrels(): string[] {
	return trackedSources("packages").filter(file => {
		if (path.basename(file) !== "index.ts") return false;
		const relative = path.relative(packagesRoot, file);
		const parts = relative.split(path.sep);
		// `<pkg>/src/index.ts` is the package entry point, named by the manifest rather than imported by a
		// sibling, so it is not a directory barrel.
		return parts[1] === "src" && parts.length > 3;
	});
}

describe("directory barrels", () => {
	/**
	 * The contract. Every barrel is reached by at least one import, which is what makes it the directory's
	 * import point rather than a duplicate list of its exports.
	 */
	it("are all imported by something in the workspace", () => {
		const imported = importedFiles();
		const orphans = barrels()
			.filter(barrel => !imported.has(barrel))
			.map(barrel => path.relative(repoRoot, barrel))
			.sort();

		expect(orphans).toEqual([]);
	});

	/**
	 * The resolver has to actually work, or the test above passes by finding nothing. Pin a barrel that is
	 * definitely imported and a specifier form that definitely resolves, so a resolver broken by a path
	 * change fails here instead of silently reporting a clean import graph.
	 */
	it("resolve through a resolver that finds known imports", () => {
		const asyncBarrel = path.join(packagesRoot, "coding-agent", "src", "async", "index.ts");
		const sdk = path.join(packagesRoot, "coding-agent", "src", "sdk.ts");

		expect(resolveSpecifier("./async", sdk)).toBe(asyncBarrel);
		expect(resolveSpecifier("./async/index", sdk)).toBe(asyncBarrel);
		expect(resolveSpecifier("@veyyon/coding-agent/async", sdk)).toBe(asyncBarrel);
		expect(resolveSpecifier("@veyyon/coding-agent/sdk", sdk)).toBe(sdk);
		expect(resolveSpecifier("node:path", sdk)).toBeUndefined();
		expect(resolveSpecifier("react", sdk)).toBeUndefined();
	});

	/**
	 * And the scan has to see the whole tree. A barrel list that collapsed to a handful -- a `readdirSync`
	 * that threw, a skip list that grew too far -- would also report zero orphans.
	 */
	it("are found across the workspace, not just in one package", () => {
		const found = barrels();
		const packagesWithBarrels = new Set(found.map(file => path.relative(packagesRoot, file).split(path.sep)[0]));

		expect(found.length).toBeGreaterThanOrEqual(50);
		expect(packagesWithBarrels.size).toBeGreaterThanOrEqual(4);
	});

	/**
	 * The listing is the working tree, not the index.
	 *
	 * Deleting an orphan barrel is the fix this suite asks for, and `git ls-files` keeps reporting the
	 * file until the deletion is committed. Before this was filtered, performing the fix left the gate
	 * red and named the deleted files as the problem, which reads as "restore them". Asserting that every
	 * listed path is on disk pins the filter rather than the symptom.
	 */
	it("list only files that exist in the working tree", () => {
		const listed = barrels();
		const missing = listed.filter(file => !existsSync(file)).map(file => path.relative(repoRoot, file));

		expect(missing).toEqual([]);
		expect(listed.length).toBeGreaterThanOrEqual(50);
	});

	/**
	 * And the filter has to be the shared one. `existingOnly` drops what is not on disk and preserves the
	 * order of the rest; a reimplementation that sorted or deduplicated would change which file a
	 * per-file report blames.
	 */
	it("keep the listed order while dropping a path that is gone", () => {
		expect(existingOnly(repoRoot, ["package.json", "does-not-exist.ts", "tsconfig.json"])).toEqual([
			"package.json",
			"tsconfig.json",
		]);
	});

	/**
	 * Dynamic imports count. Several barrels are reached only through `await import(...)` so their module
	 * graph stays out of TUI startup, and a specifier regex that missed that form would report every one of
	 * them as an orphan and invite deleting a live barrel.
	 */
	it("count a dynamic import as an import", () => {
		const sdk = path.join(packagesRoot, "coding-agent", "src", "sdk.ts");
		const specifiers = [...`await import("./async");`.matchAll(SPECIFIER)].map(match => match[1]);

		expect(specifiers).toEqual(["./async"]);
		expect(resolveSpecifier(specifiers[0] as string, sdk)).toBe(
			path.join(packagesRoot, "coding-agent", "src", "async", "index.ts"),
		);
	});
});
