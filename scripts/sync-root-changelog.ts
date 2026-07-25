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
//   bun scripts/sync-root-changelog.ts           # write CHANGELOG.md from the packages
//   bun scripts/sync-root-changelog.ts --check    # exit 1 if root is stale

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

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
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
	writeFileSync(ROOT_PATH, expected);
	console.log("Wrote CHANGELOG.md (root) from the package changelogs.");
}

if (import.meta.main) {
	await main();
}
