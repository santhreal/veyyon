#!/usr/bin/env bun

// Keep the repo-root `CHANGELOG.md` in sync with the canonical source.
//
// The changelog lives at `packages/coding-agent/CHANGELOG.md` (Keep a Changelog
// format). That path is invisible on GitHub's repo page, so the project had no
// changelog where a visitor looks first. This script generates the root file the
// website already renders from the same source: veyyon's own entries in Veyyon's
// voice, with pre-fork oh-my-pi history credited in one note rather than replayed.
//
// The generation itself is `renderRootChangelog` in the website changelog tool —
// the ONE place the omp→veyyon rebrand and the fork split are defined. This file
// is only the filesystem shell: read the source, render, and either write the
// root file (default) or, with `--check`, fail loudly if the on-disk file has
// drifted from what the source would regenerate (the CI guard). Because
// `renderRootChangelog` is pure, the check is an exact byte comparison — no
// approximate diffing, no silent tolerance.
//
//   bun scripts/sync-root-changelog.ts           # write CHANGELOG.md from source
//   bun scripts/sync-root-changelog.ts --check    # exit 1 if root is stale

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { renderRootChangelog } from "../website/tools/gen-changelog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..");
export const SOURCE_PATH = join(REPO_ROOT, "packages", "coding-agent", "CHANGELOG.md");
export const ROOT_PATH = join(REPO_ROOT, "CHANGELOG.md");

/** The exact bytes the root `CHANGELOG.md` should contain for the current source. */
export function buildRootChangelog(): string {
	return renderRootChangelog(readFileSync(SOURCE_PATH, "utf8"));
}

async function main(): Promise<void> {
	const check = process.argv.includes("--check");
	const expected = buildRootChangelog();
	const current = existsSync(ROOT_PATH) ? readFileSync(ROOT_PATH, "utf8") : null;

	if (check) {
		if (current === expected) {
			console.log("CHANGELOG.md (root) is in sync with packages/coding-agent/CHANGELOG.md.");
			return;
		}
		console.error("CHANGELOG.md (repo root) is out of sync with the canonical changelog.");
		console.error("  Source: packages/coding-agent/CHANGELOG.md");
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
	console.log("Wrote CHANGELOG.md (root) from packages/coding-agent/CHANGELOG.md.");
}

if (import.meta.main) {
	await main();
}
