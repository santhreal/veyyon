#!/usr/bin/env bun

// Gate a pull request on changelog propagation.
//
// The release model is: contributors open PRs, but only a maintainer triggers a
// full release (the manual `Release` workflow). For that to stay fast and still
// be trustworthy, every source change must carry its own `## [Unreleased]`
// changelog entry as it merges, never as a later clean-up pass. Discipline in
// AGENTS.md is not enough once outside contributors are in the mix, so this
// script makes the rule mechanical: if a PR changes a publishable package's
// shipped source but adds nothing to that package's `## [Unreleased]` section,
// the check fails and names the exact file to edit.
//
// The escape hatch is explicit and auditable, never silent (Law 10): a change
// with genuinely no user-facing effect opts out with a `[skip changelog]`
// marker in a commit message (global) or `[skip changelog: <package>]` (scoped
// to one package directory). The decision then lives in git history where a
// reviewer can see it, instead of being quietly forgotten.
//
// The core (`evaluateChangelogRequirement`) is a pure function over already-read
// inputs so it is exhaustively unit-tested without a real repo. `main()` is the
// thin git/filesystem shell around it.

import * as path from "node:path";
import { $, Glob } from "bun";

const UNRELEASED_HEADING = "## [Unreleased]";

/** A publishable package that participates in the changelog/release system. */
export interface ChangelogPackage {
	/** Repo-relative directory, e.g. `packages/coding-agent`. */
	dir: string;
	/** Its `package.json` `name`, used in the failure message. */
	name: string;
}

export interface EvaluateInput {
	/** Repo-relative paths changed by the PR (three-dot diff vs the base). */
	changedFiles: string[];
	/** Publishable packages that own a CHANGELOG.md. */
	packages: ChangelogPackage[];
	/** Base-side `## [Unreleased]` bullets per package dir (empty if none). */
	baseUnreleased: Map<string, string[]>;
	/** Head-side `## [Unreleased]` bullets per package dir. */
	headUnreleased: Map<string, string[]>;
	/** True when a `[skip changelog]` marker waived the whole PR. */
	skipAll: boolean;
	/** Package directories waived by a scoped `[skip changelog: <dir>]` marker. */
	skipDirs: Set<string>;
}

export interface ChangelogViolation {
	/** Package directory whose changelog was not updated. */
	dir: string;
	/** Package name, for the human-facing message. */
	name: string;
	/** The shipped-source files that triggered the requirement. */
	sourceFiles: string[];
	/** The CHANGELOG.md the contributor must add an entry to. */
	changelogPath: string;
}

// A changed file inside a package that does NOT, on its own, require a changelog
// entry: tests, fixtures, docs, and package metadata do not change shipped
// behavior. Everything else under the package is treated as shipped source.
const NON_SHIPPED_SEGMENTS = new Set([
	"test",
	"tests",
	"__tests__",
	"__mocks__",
	"__snapshots__",
	"fixtures",
	"testdata",
	"e2e",
]);

function isTestOrSpecFile(rel: string): boolean {
	return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

function isNonShippedFile(rel: string): boolean {
	if (rel === "package.json") return true;
	if (/(^|\/)tsconfig[^/]*\.json$/.test(rel)) return true;
	if (rel.endsWith(".md")) return true;
	if (isTestOrSpecFile(rel)) return true;
	for (const segment of rel.split("/")) {
		if (NON_SHIPPED_SEGMENTS.has(segment)) return true;
	}
	return false;
}

/**
 * Return, for a package, the shipped-source files a PR changed under it. A
 * shipped-source change is what obliges a changelog entry; tests/docs/metadata
 * are filtered out. `dir` is matched as a path prefix so `packages/ai` never
 * swallows a change under `packages/ai-extras`.
 */
export function shippedSourceChanges(dir: string, changedFiles: string[]): string[] {
	const prefix = `${dir}/`;
	const hits: string[] = [];
	for (const file of changedFiles) {
		if (!file.startsWith(prefix)) continue;
		const rel = file.slice(prefix.length);
		if (isNonShippedFile(rel)) continue;
		hits.push(file);
	}
	return hits;
}

/**
 * True when the head `## [Unreleased]` section gained content relative to the
 * base: some bullet occurs more times in head than in base. This is satisfied
 * by a new bullet and by a reworded bullet (the new wording is a fresh string),
 * and is NOT satisfied by only deleting bullets, which must never pass the gate.
 */
export function unreleasedGainedEntry(baseBullets: string[], headBullets: string[]): boolean {
	const baseCounts = new Map<string, number>();
	for (const bullet of baseBullets) {
		baseCounts.set(bullet, (baseCounts.get(bullet) ?? 0) + 1);
	}
	const headCounts = new Map<string, number>();
	for (const bullet of headBullets) {
		headCounts.set(bullet, (headCounts.get(bullet) ?? 0) + 1);
	}
	for (const [bullet, headCount] of headCounts) {
		if (headCount > (baseCounts.get(bullet) ?? 0)) return true;
	}
	return false;
}

/**
 * Pure gate logic. A package violates the rule when it changed shipped source,
 * was not waived by a skip marker, and its `## [Unreleased]` section gained no
 * new bullet. Returns one violation per offending package (empty = pass).
 */
export function evaluateChangelogRequirement(input: EvaluateInput): ChangelogViolation[] {
	if (input.skipAll) return [];
	const violations: ChangelogViolation[] = [];
	for (const pkg of input.packages) {
		if (input.skipDirs.has(pkg.dir)) continue;
		const sourceFiles = shippedSourceChanges(pkg.dir, input.changedFiles);
		if (sourceFiles.length === 0) continue;
		const base = input.baseUnreleased.get(pkg.dir) ?? [];
		const head = input.headUnreleased.get(pkg.dir) ?? [];
		if (unreleasedGainedEntry(base, head)) continue;
		violations.push({
			dir: pkg.dir,
			name: pkg.name,
			sourceFiles,
			changelogPath: `${pkg.dir}/CHANGELOG.md`,
		});
	}
	return violations;
}

/**
 * Extract the bullet lines under `## [Unreleased]`, stopping at the next
 * top-level `## ` heading. Sub-section headings (`### Added`) and blanks are
 * skipped; a bullet is any line whose first non-space character is `-`. Returns
 * `[]` when the file has no Unreleased section (or is empty/missing).
 */
export function parseUnreleasedBullets(content: string): string[] {
	const lines = content.split("\n");
	const bullets: string[] = [];
	let inUnreleased = false;
	for (const line of lines) {
		if (line.startsWith("## ")) {
			inUnreleased = line.trim() === UNRELEASED_HEADING;
			continue;
		}
		if (!inUnreleased) continue;
		const trimmed = line.trim();
		if (trimmed.startsWith("- ") || trimmed === "-") {
			bullets.push(trimmed);
		}
	}
	return bullets;
}

/**
 * Parse `[skip changelog]` / `[skip changelog: <dir-or-name>]` markers out of
 * the concatenated commit messages. A bare marker waives the whole PR; a scoped
 * one waives a single package, matched later against both its directory and its
 * bare basename so `[skip changelog: coding-agent]` and
 * `[skip changelog: packages/coding-agent]` both work.
 */
export function parseSkipMarkers(commitMessages: string): { skipAll: boolean; skipTokens: Set<string> } {
	const skipTokens = new Set<string>();
	let skipAll = false;
	// `[skip changelog]` or `[skip-changelog]`, optionally `: token` (or `(token)`).
	const re = /\[skip[ -]changelog(?:\s*[:(]\s*([^\])]+?)\s*[)\]]?)?\]/gi;
	for (const match of commitMessages.matchAll(re)) {
		const scope = match[1]?.trim();
		if (scope) {
			skipTokens.add(scope);
		} else {
			skipAll = true;
		}
	}
	return { skipAll, skipTokens };
}

/**
 * Resolve scope tokens (from markers or the CHANGELOG_SKIP env var) to concrete
 * package directories. A token matches a package by exact directory, by bare
 * basename (`coding-agent`), or by package name (`@veyyon/coding-agent`).
 */
export function resolveSkipDirs(tokens: Iterable<string>, packages: ChangelogPackage[]): Set<string> {
	const byDir = new Map<string, string>();
	const byBase = new Map<string, string>();
	const byName = new Map<string, string>();
	for (const pkg of packages) {
		byDir.set(pkg.dir, pkg.dir);
		byBase.set(path.basename(pkg.dir), pkg.dir);
		byName.set(pkg.name, pkg.dir);
	}
	const dirs = new Set<string>();
	for (const token of tokens) {
		const dir = byDir.get(token) ?? byBase.get(token) ?? byName.get(token);
		if (dir) dirs.add(dir);
	}
	return dirs;
}

// ---- git / filesystem shell -------------------------------------------------

/** Fail loud with an operator-facing message and a nonzero exit. Never degrade. */
function fail(message: string): never {
	console.error(`\n\x1b[31mchangelog gate: ${message}\x1b[0m\n`);
	process.exit(1);
}

async function gitOutput(args: string[]): Promise<string> {
	return (await $`git ${args}`.quiet().nothrow().text()).trimEnd();
}

/** Resolve the base commit the PR forks from, or fail loud if it is unknowable. */
async function resolveBase(): Promise<string> {
	const explicit = Bun.env.CHANGELOG_BASE;
	const baseRef = explicit ?? (Bun.env.GITHUB_BASE_REF ? `origin/${Bun.env.GITHUB_BASE_REF}` : "origin/main");
	const resolved = await gitOutput(["rev-parse", "--verify", "--quiet", baseRef]);
	if (!resolved) {
		fail(
			`cannot resolve base ref "${baseRef}". In CI, fetch the base branch (fetch-depth: 0). ` +
				`Locally, set CHANGELOG_BASE to a ref you have, e.g. CHANGELOG_BASE=origin/main.`,
		);
	}
	const mergeBase = await gitOutput(["merge-base", baseRef, "HEAD"]);
	if (!mergeBase) fail(`no merge-base between "${baseRef}" and HEAD; is the base branch fetched?`);
	return mergeBase;
}

async function discoverPackages(repoRoot: string): Promise<ChangelogPackage[]> {
	const packages: ChangelogPackage[] = [];
	const glob = new Glob("packages/*/package.json");
	for await (const rel of glob.scan({ cwd: repoRoot })) {
		const dir = path.dirname(rel);
		const manifest = (await Bun.file(path.join(repoRoot, rel)).json()) as {
			name?: string;
			private?: boolean;
		};
		if (manifest.private) continue;
		if (!(await Bun.file(path.join(repoRoot, dir, "CHANGELOG.md")).exists())) continue;
		packages.push({ dir, name: manifest.name ?? dir });
	}
	packages.sort((a, b) => a.dir.localeCompare(b.dir));
	return packages;
}

async function readBaseChangelog(base: string, dir: string): Promise<string> {
	// `git show base:path` is empty when the file did not exist at base (a new
	// package): its Unreleased is then legitimately empty.
	return await gitOutput(["show", `${base}:${dir}/CHANGELOG.md`]);
}

async function main(): Promise<void> {
	const repoRoot = (await gitOutput(["rev-parse", "--show-toplevel"])) || process.cwd();
	const base = await resolveBase();

	const changedRaw = await gitOutput(["diff", "--name-only", `${base}...HEAD`]);
	const changedFiles = changedRaw ? changedRaw.split("\n").filter(Boolean) : [];

	const packages = await discoverPackages(repoRoot);

	const commitMessages = await gitOutput(["log", `${base}..HEAD`, "--format=%B"]);
	const markers = parseSkipMarkers(commitMessages);
	const envScopes = (Bun.env.CHANGELOG_SKIP ?? "")
		.split(",")
		.map(token => token.trim())
		.filter(Boolean);
	const skipAll = markers.skipAll || Bun.env.CHANGELOG_SKIP_ALL === "1";
	const skipDirs = resolveSkipDirs([...markers.skipTokens, ...envScopes], packages);

	const baseUnreleased = new Map<string, string[]>();
	const headUnreleased = new Map<string, string[]>();
	for (const pkg of packages) {
		baseUnreleased.set(pkg.dir, parseUnreleasedBullets(await readBaseChangelog(base, pkg.dir)));
		const headContent = await Bun.file(path.join(repoRoot, pkg.dir, "CHANGELOG.md")).text();
		headUnreleased.set(pkg.dir, parseUnreleasedBullets(headContent));
	}

	const violations = evaluateChangelogRequirement({
		changedFiles,
		packages,
		baseUnreleased,
		headUnreleased,
		skipAll,
		skipDirs,
	});

	if (violations.length === 0) {
		const scoped = skipDirs.size > 0 ? ` (${skipDirs.size} package(s) waived by [skip changelog])` : "";
		console.log(`changelog gate: ok${skipAll ? " (whole PR waived by [skip changelog])" : scoped}`);
		return;
	}

	const lines: string[] = ["changed shipped source without a matching `## [Unreleased]` changelog entry.", ""];
	for (const violation of violations) {
		lines.push(`  ${violation.name} (${violation.dir})`);
		lines.push(`    add an entry to: ${violation.changelogPath}`);
		const shown = violation.sourceFiles.slice(0, 5);
		for (const file of shown) lines.push(`      changed: ${file}`);
		if (violation.sourceFiles.length > shown.length) {
			lines.push(`      ...and ${violation.sourceFiles.length - shown.length} more`);
		}
		lines.push("");
	}
	lines.push("Fix by adding a bullet under `## [Unreleased]` in each file above,");
	lines.push("or, for a change with no user-facing effect, put `[skip changelog]`");
	lines.push("in a commit message (or `[skip changelog: <package>]` to waive one).");
	fail(lines.join("\n"));
}

if (import.meta.main) {
	await main();
}
