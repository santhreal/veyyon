#!/usr/bin/env bun

// Gate a change on changelog propagation.
//
// The release model auto-cuts a release whenever a `## [Unreleased]` bullet is
// waiting, so every source change must carry its own entry as it lands, never as
// a later clean-up pass. Changes land directly on `main` here (and outside
// contributors open PRs), so the CI gate runs on BOTH: the direct-to-main push,
// with the branch tip before the push (`github.event.before`) as the base, and
// the pull request, with the PR base. A PR-only gate would never fire on the
// direct-push path and shipped source would reach releases undocumented.
// Discipline in AGENTS.md is not enough, so this script makes the rule
// mechanical: if the diff from base to HEAD changes a publishable package's
// shipped source but adds nothing to that package's `## [Unreleased]` section,
// the check fails and names the exact file to edit.
//
// There is no escape hatch, and there was one until it ate the gate. A bare
// `[skip changelog]` in any commit message waived the WHOLE range, so one
// throwaway marker in a housekeeping commit switched the check off for every
// package and every other commit pushed with it. The scoped spelling was no
// better in practice: it is easier to type than a sentence, so it became the
// default answer to "this is only a refactor" and thousands of commits reached
// releases with a changelog that does not describe them. If a change touches
// shipped source, it gets a line saying what changed. A change that genuinely
// has no user-facing effect can say so in one sentence, which is cheaper than
// arguing about it and leaves the reader something to read.
//
// The core (`evaluateChangelogRequirement`) is a pure function over already-read
// inputs so it is exhaustively unit-tested without a real repo. `main()` is the
// thin git/filesystem shell around it.

import * as path from "node:path";
import { $, Glob } from "bun";

import { UNRELEASED_HEADING, unreleasedEntries } from "./changelog-unreleased.ts";

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
 * Pure gate logic. A package violates the rule when it changed shipped source
 * and its `## [Unreleased]` section gained no new bullet. Returns one violation
 * per offending package (empty = pass).
 */
export function evaluateChangelogRequirement(input: EvaluateInput): ChangelogViolation[] {
	const violations: ChangelogViolation[] = [];
	for (const pkg of input.packages) {
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

/**
 * Every publishable package under `packages/`, in path order.
 *
 * A package with no `CHANGELOG.md` is an ERROR here, not a package to skip. Skipping was the old
 * behaviour and it made the gate quietly incomplete: `argot` and `@veyyon/tool-render` both shipped
 * for releases with their source ungated, and nothing said so, because the check that would have
 * complained was the same one being skipped. The rule is that a publishable package documents what
 * it ships, so a missing changelog fails the gate and names the file to create.
 */
export async function discoverPackages(repoRoot: string): Promise<ChangelogPackage[]> {
	const packages: ChangelogPackage[] = [];
	const missing: string[] = [];
	const glob = new Glob("packages/*/package.json");
	for await (const rel of glob.scan({ cwd: repoRoot })) {
		const dir = path.dirname(rel);
		const manifest = (await Bun.file(path.join(repoRoot, rel)).json()) as {
			name?: string;
			private?: boolean;
		};
		if (manifest.private) continue;
		if (!(await Bun.file(path.join(repoRoot, dir, "CHANGELOG.md")).exists())) {
			missing.push(`${dir}/CHANGELOG.md (${manifest.name ?? dir})`);
			continue;
		}
		packages.push({ dir, name: manifest.name ?? dir });
	}
	if (missing.length > 0) {
		// Thrown rather than exited so the rule is reachable from a test with a fixture repo;
		// `main` turns it into the same red operator message every other gate failure uses.
		throw new Error(
			`publishable package with no changelog, so its source ships ungated:\n  ${missing.join("\n  ")}\n` +
				`Create the file with a "# Changelog" heading and a "${UNRELEASED_HEADING}" section, ` +
				`or mark the package "private": true in its package.json if it is not published.`,
		);
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

	// This gate printed nothing until its verdict, and a job once sat inside it for over an
	// hour with no output at all: the log could not say whether it was resolving the base,
	// diffing, or reading one package's history. These two lines cost nothing and place a
	// future stall between two known points.
	console.log(`changelog gate: base ${base.slice(0, 12)}, ${changedFiles.length} changed file(s)`);

	let packages: ChangelogPackage[];
	try {
		packages = await discoverPackages(repoRoot);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	console.log(`changelog gate: reading ${packages.length} package changelog(s) at ${base.slice(0, 12)}`);

	const baseUnreleased = new Map<string, string[]>();
	const headUnreleased = new Map<string, string[]>();
	for (const pkg of packages) {
		baseUnreleased.set(pkg.dir, unreleasedEntries(await readBaseChangelog(base, pkg.dir)));
		const headContent = await Bun.file(path.join(repoRoot, pkg.dir, "CHANGELOG.md")).text();
		headUnreleased.set(pkg.dir, unreleasedEntries(headContent));
	}

	const violations = evaluateChangelogRequirement({
		changedFiles,
		packages,
		baseUnreleased,
		headUnreleased,
	});

	if (violations.length === 0) {
		console.log("changelog gate: ok");
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
	lines.push("Fix by adding a bullet under `## [Unreleased]` in each file above.");
	lines.push("There is no skip marker. A change with no user-facing effect still gets");
	lines.push("one line saying so, which is what makes the rest of the file trustworthy.");
	fail(lines.join("\n"));
}

if (import.meta.main) {
	await main();
}
