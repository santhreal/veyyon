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
import { unreleasedEntries } from "./changelog-unreleased.ts";

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
 * Characters of an entry's opening that identify it across an edit.
 *
 * Long enough that two different entries do not collide: 40 characters is most
 * of a sentence, and no two changelog entries in this repo open the same way.
 * Short enough that rewording the body of an entry, which is what an author
 * actually does, does not turn it into a stranger.
 */
const ENTRY_IDENTITY_CHARS = 40;

/** The opening of a bullet, or null when it is too short to identify by one. */
function entryIdentity(bullet: string): string | null {
	return bullet.length >= ENTRY_IDENTITY_CHARS ? bullet.slice(0, ENTRY_IDENTITY_CHARS) : null;
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
 *
 * An EDITED entry is the same entry. Matching on exact text alone meant that
 * rewording a package entry after a root sync left the root holding the old
 * wording, which this function then called an orphan, and the only way forward
 * was `--force`, whose whole purpose is to discard entries deliberately. A
 * routine reword pushed the author onto the one flag that can lose work, three
 * times in one session. So an on-disk entry is claimed when its opening matches
 * a rendered entry's opening, not only when the whole paragraph does.
 *
 * What that cannot catch: an entry rewritten from its first word, which is
 * indistinguishable from a paragraph somebody typed into the root by hand. The
 * guard reports it, and the author moves it to its package or forces the write.
 * That is the right way round: reporting a reword costs a sentence of reading,
 * and missing a hand-written paragraph loses it.
 */
export function orphanedRootEntries(currentRoot: string, expectedRoot: string): string[] {
	const rendered = unreleasedEntries(expectedRoot);
	const exact = new Set(rendered);
	const openings = new Set(rendered.map(entryIdentity).filter((id): id is string => id !== null));
	return unreleasedEntries(currentRoot).filter(bullet => {
		if (exact.has(bullet)) return false;
		const identity = entryIdentity(bullet);
		return identity === null || !openings.has(identity);
	});
}

/**
 * Write the root changelog, refusing to delete unreleased entries no package
 * claims. Returns what it did.
 *
 * The guard every writer of the root file has to go through, and it owns the
 * write so that going around it is a visible thing to do rather than the
 * default. It used to live inside this script's `main()`, where it protected the
 * CLI and nothing else: `release.ts` wrote the same file with a bare
 * `Bun.write(buildRootChangelog())` one line after the changelog roll. That is
 * the worst place to lose the check, because an entry the release deletes is
 * gone by the time the tag, the npm packages and the GitHub release have already
 * shipped under a changelog that never mentioned it.
 *
 * `rootPath` exists so a test can drive the refusal against a real file and
 * assert the bytes survived, rather than trusting the return value alone.
 */
export function writeRootChangelog(options: { force?: boolean; rootPath?: string } = {}): {
	wrote: boolean;
	orphans: string[];
	expected: string;
	current: string | null;
} {
	const rootPath = options.rootPath ?? ROOT_PATH;
	const expected = buildRootChangelog();
	const current = existsSync(rootPath) ? readFileSync(rootPath, "utf8") : null;
	const orphans = current === null ? [] : orphanedRootEntries(current, expected);
	if (orphans.length > 0 && !options.force) return { wrote: false, orphans, expected, current };
	writeFileSync(rootPath, expected);
	return { wrote: true, orphans, expected, current };
}

/** Why regenerating the root would lose work, one line per orphaned entry. */
export function orphanRefusalLines(orphans: readonly string[]): string[] {
	return [
		`the root CHANGELOG.md holds ${orphans.length} unreleased ${orphans.length === 1 ? "entry" : "entries"} ` +
			`that no package changelog claims.`,
		"Writing the root would delete them. The root is generated; entries belong to a package.",
		...orphans.map(orphan => `  - ${orphan.length > 120 ? `${orphan.slice(0, 117)}...` : orphan}`),
		"",
		"  Fix:   move each entry under `## [Unreleased]` in the owning packages/<name>/CHANGELOG.md.",
	];
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
	const result = writeRootChangelog({ force });
	if (!result.wrote) {
		console.error("Refusing to regenerate:");
		for (const line of orphanRefusalLines(result.orphans)) console.error(line);
		console.error("         then re-run this command.");
		console.error("  Or:    bun scripts/sync-root-changelog.ts --force   # discard them deliberately");
		process.exit(1);
	}
	console.log("Wrote CHANGELOG.md (root) from the package changelogs.");
}

if (import.meta.main) {
	await main();
}
