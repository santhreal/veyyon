#!/usr/bin/env bun

// Keep the repo-root `CHANGELOG.md` in sync with every package changelog.
//
// Each package keeps its own `CHANGELOG.md` (Keep a Changelog format), and none
// of those paths is visible on GitHub's repo page, so the project had no
// changelog where a visitor looks first. This script generates the root file:
// veyyon's own entries from EVERY package, merged by version and section, in
// Veyyon's voice, with pre-fork oh-my-pi history credited in one note rather
// than replayed.
//
// Reading only `packages/coding-agent/CHANGELOG.md`, as this used to, silently
// dropped every other package's entries on each regeneration. The root is the
// product's changelog, so it aggregates all of them.
//
// The generation itself is `renderRootChangelog` in the website changelog tool —
// the ONE place the omp→veyyon rebrand and the fork split are defined. This file
// is only the filesystem shell: read the source, render, and either write the
// root file (default) or, with `--check`, fail loudly if the on-disk file has
// drifted from what the sources would regenerate (the CI guard). Because
// `renderRootChangelog` is pure, the check is an exact byte comparison — no
// approximate diffing, no silent tolerance.
//
// The root is GENERATED, so an entry written directly into it is not a changelog
// entry — it is content the next render deletes. That is easy to do by accident
// (the root is the file a contributor opens first, and it looks hand-written), and
// the deletion used to be silent: `--check` failed in CI, the contributor ran the
// fix command, and the fix threw their paragraph away without a word. So the write
// path now REFUSES when the root holds an unreleased bullet that no package
// changelog claims, naming each orphan and the package to move it to. `--force`
// discards them deliberately.
//
//   bun scripts/sync-root-changelog.ts           # write CHANGELOG.md from the packages
//   bun scripts/sync-root-changelog.ts --check    # exit 1 if root is stale
//   bun scripts/sync-root-changelog.ts --force    # write even if it discards orphaned entries

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { renderRootChangelog } from "../website/tools/gen-changelog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..");
export const PACKAGES_DIR = join(REPO_ROOT, "packages");
export const ROOT_PATH = join(REPO_ROOT, "CHANGELOG.md");

/**
 * The package whose entries lead every section.
 *
 * It is the product itself, so its changes are what a reader came for; the rest
 * follow alphabetically so the order is stable rather than filesystem-dependent.
 */
const LEAD_PACKAGE = "coding-agent";

/** Every `packages/<name>/CHANGELOG.md`, lead package first, then alphabetical. */
export function changelogSources(): { name: string; md: string }[] {
	const names = readdirSync(PACKAGES_DIR, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.filter(name => existsSync(join(PACKAGES_DIR, name, "CHANGELOG.md")))
		.sort((a, b) => {
			if (a === LEAD_PACKAGE) return -1;
			if (b === LEAD_PACKAGE) return 1;
			return a.localeCompare(b);
		});
	return names.map(name => ({ name, md: readFileSync(join(PACKAGES_DIR, name, "CHANGELOG.md"), "utf8") }));
}

/** The exact bytes the root `CHANGELOG.md` should contain for the current sources. */
export function buildRootChangelog(): string {
	return renderRootChangelog(changelogSources());
}

/**
 * The `## [Unreleased]` bullets of a changelog, one string per bullet.
 *
 * A bullet may wrap over several lines, so a continuation line belongs to the
 * bullet above it. Comparing whole bullets rather than lines is what makes an
 * orphan detectable: a re-wrapped paragraph is the same entry, and half a
 * paragraph is not an entry at all.
 */
export function unreleasedBullets(md: string): string[] {
	const start = md.indexOf("## [Unreleased]");
	if (start === -1) return [];
	const rest = md.slice(start + "## [Unreleased]".length);
	const nextRelease = rest.search(/\n## /);
	const block = nextRelease === -1 ? rest : rest.slice(0, nextRelease);
	const bullets: string[] = [];
	let current: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("- ")) {
			if (current.length > 0) bullets.push(current.join(" "));
			current = [line.slice(2).trim()];
		} else if (current.length > 0 && line.trim().length > 0 && !line.startsWith("#")) {
			current.push(line.trim());
		} else if (line.startsWith("#")) {
			if (current.length > 0) bullets.push(current.join(" "));
			current = [];
		}
	}
	if (current.length > 0) bullets.push(current.join(" "));
	return bullets.map(bullet => bullet.replace(/\s+/g, " ").trim()).filter(bullet => bullet.length > 0);
}

/**
 * Unreleased entries the on-disk root has and a fresh render does not: exactly
 * what a regeneration would delete.
 *
 * Compared against the RENDER, not against the package files, deliberately. The
 * renderer rewrites entry text on the way through (the omp→veyyon rebrand, the
 * fork split), so a package-side comparison reports every rewritten entry as
 * unclaimed and the warning becomes noise nobody reads. Comparing what is on disk
 * to what would replace it is immune to any rewriting, and it is the precise
 * question being asked: which of these paragraphs is about to be lost?
 */
export function orphanedRootEntries(currentRoot: string, expectedRoot: string): string[] {
	const rendered = new Set(unreleasedBullets(expectedRoot));
	return unreleasedBullets(currentRoot).filter(bullet => !rendered.has(bullet));
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const force = process.argv.includes("--force");
	const expected = buildRootChangelog();
	const current = existsSync(ROOT_PATH) ? readFileSync(ROOT_PATH, "utf8") : null;

	if (check) {
		if (current === expected) {
			console.log("CHANGELOG.md (root) is in sync with the package changelogs.");
			return;
		}
		console.error("CHANGELOG.md (repo root) is out of sync with the canonical changelog.");
		console.error("  Source: every packages/*/CHANGELOG.md");
		console.error("  Fix:    bun scripts/sync-root-changelog.ts");
		console.error(
			current === null
				? "  Reason: the root CHANGELOG.md does not exist yet."
				: "  Reason: the root CHANGELOG.md no longer matches a fresh render of the source.",
		);
		process.exit(1);
	}

	if (current === expected) {
		console.log("CHANGELOG.md (root) already up to date.");
		return;
	}
	const orphans = current === null ? [] : orphanedRootEntries(current, expected);
	if (orphans.length > 0 && !force) {
		console.error(
			`Refusing to regenerate: the root CHANGELOG.md holds ${orphans.length} unreleased ${
				orphans.length === 1 ? "entry" : "entries"
			} that no package changelog claims.`,
		);
		console.error("Writing the root would delete them. The root is generated; entries belong to a package.");
		for (const orphan of orphans) {
			console.error(`  - ${orphan.length > 120 ? `${orphan.slice(0, 117)}...` : orphan}`);
		}
		console.error("");
		console.error("  Fix:   move each entry under `## [Unreleased]` in the owning packages/<name>/CHANGELOG.md,");
		console.error("         then re-run this command.");
		console.error("  Or:    bun scripts/sync-root-changelog.ts --force   # discard them deliberately");
		process.exit(1);
	}
	writeFileSync(ROOT_PATH, expected);
	console.log("Wrote CHANGELOG.md (root) from the package changelogs.");
}

if (import.meta.main) {
	await main();
}
