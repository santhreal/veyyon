import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { existingOnly } from "./workspace-layout";

/**
 * WHY THIS SUITE EXISTS:
 *
 * A branch head once carried `packages/tool-render/src/registry.ts` importing
 * `./descriptors/fs` and `natives/search/grep-kernel/src/lib.rs` declaring
 * `pub mod matcher`, while both targets existed only in a working tree and were
 * never committed. Every local gate passed, because every local gate reads the
 * working tree. A clean checkout compiled neither package.
 *
 * THE CLASS:
 * A tracked source file that references a source file git does not track. The
 * reference resolves for whoever authored it and for nobody else. This closes
 * the class for both reference vocabularies that can name an untracked file by
 * path: TypeScript relative specifiers and Rust `mod` declarations.
 *
 * The variant space is derived at run time from `git ls-files`, so a new
 * package, crate, or directory is swept the moment it is tracked; nothing here
 * names a member.
 *
 * WHAT IT DOES NOT CATCH: a bare package specifier (`@veyyon/kernel`) that
 * resolves through `node_modules` or the workspace, an asset referenced by a
 * runtime-computed string, and a file that is tracked but empty. It also cannot
 * see a file that is absent from both git and disk in a way that no reference
 * names literally.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Vendored and generated trees carry their own provenance and are not first-party sources. */
const EXCLUDED_PREFIXES = ["natives/vendor/", "node_modules/"];

function trackedIndex(): string[] {
	const out = execFileSync("git", ["ls-files", "-z"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 1 << 30,
	});
	return out.split("\0").filter(Boolean);
}

/** Extension-less specifiers resolve through the same candidate list the bundler and tsc use. */
const TS_SUFFIXES = [
	"",
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".md",
	"/index.ts",
	"/index.tsx",
	"/index.js",
	"/index.jsx",
];

/**
 * Relative specifiers only. A bare or aliased specifier resolves through the
 * package graph, not through a path, so it cannot name an untracked file.
 *
 * All four spellings that can carry one: `from "./x"` (import, re-export and
 * `import type`), the bare side-effect `import "./x"`, dynamic `import("./x")`
 * and `require("./x")`. Dropping the side-effect form is the exact hole the
 * suite's own mutation gate caught, so it is covered explicitly.
 */
const TS_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.[^"']*)["']/g;

/** `mod foo;` — the terminating semicolon excludes an inline `mod foo { ... }`, which declares no file. */
const RUST_MOD = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;

interface DanglingReference {
	source: string;
	reference: string;
	/** The resolved path that exists on disk but is not tracked, when there is one. */
	untrackedTarget?: string;
}

function isExcluded(file: string): boolean {
	return EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix));
}

/**
 * A file git deliberately ignores is a build product whose producer is wired
 * elsewhere; a file git neither tracks nor ignores was forgotten. That is the
 * whole distinction this suite rests on, so it asks git rather than guessing
 * from a name or an extension.
 */
function isIgnored(candidate: string): boolean {
	if (IGNORE_CACHE.has(candidate)) return IGNORE_CACHE.get(candidate) === true;
	// `check-ignore` exits 1 when the path is not ignored, which execFileSync throws on.
	let ignored: boolean;
	try {
		execFileSync("git", ["check-ignore", "-q", "--", candidate], { cwd: REPO_ROOT, stdio: "ignore" });
		ignored = true;
	} catch {
		ignored = false;
	}
	IGNORE_CACHE.set(candidate, ignored);
	return ignored;
}

function firstResolvable(candidates: string[]): { tracked?: string; forgotten?: string } {
	const tracked = candidates.find(candidate => TRACKED.has(candidate));
	if (tracked) return { tracked };
	const forgotten = candidates.find(candidate => {
		const absolute = path.join(REPO_ROOT, candidate);
		if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
		return !isIgnored(candidate);
	});
	return { forgotten };
}

const IGNORE_CACHE = new Map<string, boolean>();
const INDEX = trackedIndex();
/**
 * Index membership answers "did this target reach a commit?". It reads the raw
 * index on purpose: a file deleted in the working tree is still tracked, and
 * calling it forgotten would invert this suite's verdict.
 */
const TRACKED = new Set(INDEX);
/**
 * The files this suite OPENS. `existingOnly` because the index still lists a
 * path deleted in the working tree, and reading one kills the sweep with an
 * ENOENT naming that path; see its doc in check-doc-links.ts.
 */
const SCANNABLE = existingOnly(REPO_ROOT, INDEX);

function collectTypeScriptReferences(): DanglingReference[] {
	const dangling: DanglingReference[] = [];
	for (const file of SCANNABLE) {
		if (isExcluded(file)) continue;
		if (!/\.(?:m|c)?[jt]sx?$/.test(file)) continue;
		const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		const dir = path.posix.dirname(file);
		for (const match of text.matchAll(TS_SPECIFIER)) {
			const specifier = match[1];
			const base = path.posix.normalize(path.posix.join(dir, specifier));
			if (base.startsWith("..")) continue;
			const { tracked, forgotten } = firstResolvable(TS_SUFFIXES.map(suffix => `${base}${suffix}`));
			if (tracked) continue;
			// No candidate anywhere means a broken import the type checker owns and
			// reports with better context; only a present-but-forgotten file is this
			// suite's defect.
			if (forgotten) dangling.push({ source: file, reference: specifier, untrackedTarget: forgotten });
		}
	}
	return dangling;
}

function collectRustModuleReferences(): DanglingReference[] {
	const dangling: DanglingReference[] = [];
	for (const file of SCANNABLE) {
		if (isExcluded(file) || !file.endsWith(".rs")) continue;
		const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		const dir = path.posix.dirname(file);
		const stem = path.posix.basename(file, ".rs");
		// `lib.rs`, `main.rs` and `mod.rs` own their directory; any other module
		// file owns a subdirectory named after itself.
		const moduleRoot = ["lib", "main", "mod"].includes(stem) ? dir : path.posix.join(dir, stem);
		for (const match of text.matchAll(RUST_MOD)) {
			const name = match[1];
			const { tracked, forgotten } = firstResolvable([
				path.posix.join(moduleRoot, `${name}.rs`),
				path.posix.join(moduleRoot, name, "mod.rs"),
			]);
			if (tracked) continue;
			if (forgotten) dangling.push({ source: file, reference: `mod ${name};`, untrackedTarget: forgotten });
		}
	}
	return dangling;
}

function describeDangling(entries: DanglingReference[]): string[] {
	return entries.map(entry => `${entry.source} -> ${entry.reference} (untracked: ${entry.untrackedTarget})`);
}

describe("every referenced source file is tracked", () => {
	it("sweeps a non-trivial number of tracked source files", () => {
		// A resolution or exclusion mistake that empties the corpus would make
		// every assertion below vacuously true.
		const scanned = SCANNABLE.filter(file => !isExcluded(file) && /\.(?:(?:m|c)?[jt]sx?|rs)$/.test(file));
		expect(scanned.length).toBeGreaterThan(1000);
	});

	it("resolves every relative TypeScript specifier to a tracked file", () => {
		expect(describeDangling(collectTypeScriptReferences())).toEqual([]);
	});

	it("resolves every Rust module declaration to a tracked file", () => {
		expect(describeDangling(collectRustModuleReferences())).toEqual([]);
	});
});
