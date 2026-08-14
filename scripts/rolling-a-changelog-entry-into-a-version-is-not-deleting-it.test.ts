// WHY: the root-changelog guard classified a MOVE as a DELETE, and so refused
// every release.
//
// `prepareReleaseTree` does two things in this order: roll each package's
// `## [Unreleased]` into a dated `## [X.Y.Z]` section, then regenerate the root
// from those packages. After the roll the fresh render's Unreleased section is
// empty BY CONSTRUCTION, so a guard that compared the on-disk root's unreleased
// entries against the render's unreleased entries saw every entry disappear.
// `bun run release patch` aborted with "the root CHANGELOG.md holds 542
// unreleased entries that no package changelog claims", rolled the tree back,
// and there is deliberately no `--force` on the release path — so the guard did
// not protect one paragraph, it stopped the product from shipping at all.
//
// The class this closes: the guard must ask whether a paragraph SURVIVES the
// write, never which heading it survives under. Every entry that lands anywhere
// in the fresh render is claimed. The sweep below derives its inputs from the
// repository at run time — every `packages/*/CHANGELOG.md` `changelogSources()`
// finds, rolled by the release path's own `applyReleaseToChangelog` — so a
// package added later is covered without anyone remembering to add it here, and
// a renderer that starts dropping a section fails this suite rather than
// deleting entries on the next release.
//
// What it does not catch: an entry rewritten from its first 40 characters is
// still indistinguishable from a paragraph typed into the root by hand, and is
// still reported. That limitation is pinned in `sync-root-changelog.test.ts`
// and is unchanged by the widening. Nor does this suite run `prepareReleaseTree`
// itself: version bumps, lockfiles and the Rust sentinel are another contract,
// and reproducing them would mean writing to the real tree.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { renderRootChangelog } from "../website/tools/gen-changelog.mjs";
import { unreleasedEntries, versionHeadings } from "./changelog-unreleased.ts";
import { applyReleaseToChangelog, bumpVersion } from "./release.ts";
import {
	buildRootChangelog,
	changelogSources,
	orphanedRootEntries,
	writeRootChangelog,
} from "./sync-root-changelog.ts";

/**
 * The version the next release would cut, derived from the lead changelog rather
 * than invented. The renderer's fork split is POSITIONAL and stops at the first
 * entry whose major is at or above the fork's (16), so a made-up `99.0.0` heading
 * truncates the render to nothing and this suite would fail for a reason that has
 * nothing to do with the guard.
 */
function nextVersion(): string {
	const [newest] = versionHeadings(changelogSources()[0]?.md ?? "");
	expect(newest).toBeDefined();
	return bumpVersion((newest as { version: string }).version, "patch");
}

/**
 * A bullet this suite owns, used only when the working tree has just been rolled
 * and every `## [Unreleased]` section is legitimately empty. Without it the two
 * repository-derived tests below would pass vacuously right after a release cut
 * — which is exactly when a release is being prepared and the guard matters.
 */
const SEEDED_ENTRY = "A seeded paragraph, so the roll below has something to move.";

/** `md` with {@link SEEDED_ENTRY} under its `## [Unreleased]` heading. */
function seedUnreleased(md: string): string {
	return md.replace("## [Unreleased]\n", `## [Unreleased]\n\n### Added\n\n- ${SEEDED_ENTRY}\n`);
}

/**
 * Every package `CHANGELOG.md` the release path would roll, carrying at least one
 * unreleased entry between them.
 */
function sources(): { name: string; md: string }[] {
	const found = changelogSources();
	expect(found.length).toBeGreaterThan(0);
	if (found.some(({ md }) => unreleasedEntries(md).length > 0)) return found;
	return found.map((source, index) => (index === 0 ? { ...source, md: seedUnreleased(source.md) } : source));
}

/** `md` with every entry under `## [Unreleased]` removed, as a release cut leaves it. */
function emptyUnreleased(md: string): string {
	return md.replace(/(## \[Unreleased\]\n)[\s\S]*?(?=\n## \[)/, "$1");
}

/**
 * The state a release cut actually leaves behind, which is when the next release
 * is prepared: the LEAD package has nothing unreleased, and another package does.
 * `sources()` cannot express it — it seeds the lead whenever the tree is empty,
 * and returns the tree untouched whenever any package carries an entry — so which
 * of the two rules in `renderRootChangelog` gets exercised depends on what happens
 * to be uncommitted. This pins it.
 */
function postCutSources(): { name: string; md: string }[] {
	const found = changelogSources();
	expect(found.length).toBeGreaterThan(1);
	return found.map((source, index) =>
		index === 0
			? { ...source, md: emptyUnreleased(source.md) }
			: index === 1
				? { ...source, md: seedUnreleased(emptyUnreleased(source.md)) }
				: source,
	);
}

/** The root as the guard reads it before a release: the render of those sources. */
function currentRender(): string {
	return renderRootChangelog(sources());
}

/** The release path's own roll, applied to every package changelog it would touch. */
function rolledRender(version: string): string {
	return renderRootChangelog(
		sources().map(({ name, md }) => ({ name, md: applyReleaseToChangelog(md, version, "2026-08-11") })),
	);
}

describe("a release rolls entries into a version section", () => {
	/**
	 * The precondition that makes the sweep below mean something. If the roll left
	 * entries under `## [Unreleased]`, the guard would pass for the wrong reason
	 * and this suite would be green against the defect it exists to catch.
	 */
	it("empties the rendered Unreleased section while the pre-release root still holds those entries", () => {
		expect(unreleasedEntries(currentRender()).length).toBeGreaterThan(0);

		expect(unreleasedEntries(rolledRender(nextVersion()))).toEqual([]);
	});

	/**
	 * The release failure itself, against the real repository: the root the guard
	 * reads, versus what the release would write one step later.
	 */
	it("leaves no orphan when the whole repository is rolled, so a release can be cut", () => {
		expect(orphanedRootEntries(currentRender(), rolledRender(nextVersion()))).toEqual([]);
	});

	/**
	 * The defect the widening above fixes, in the state that actually produces it.
	 * `renderRootChangelog` filters the lead package by the positional fork scan and
	 * every OTHER package by the lead's version list, and only the second rule has
	 * ever deleted an entry: with the lead's Unreleased empty, a roll gives the lead
	 * no new heading, so another package's rolled entry matched no lead version and
	 * was dropped from the render entirely. The release guard then read that as a
	 * deleted paragraph and refused to write, which is a release that cannot be cut.
	 *
	 * The two tests above cannot see it: whether the lead or a non-lead package
	 * carries the entry depends on what is uncommitted when they run.
	 */
	it("carries another package's entry when the lead has nothing of its own to release", () => {
		const version = nextVersion();
		const before = renderRootChangelog(postCutSources());
		const after = renderRootChangelog(
			postCutSources().map(({ name, md }) => ({ name, md: applyReleaseToChangelog(md, version, "2026-08-11") })),
		);

		expect(unreleasedEntries(before)).toContain(SEEDED_ENTRY);
		expect(after).toContain(SEEDED_ENTRY);
		expect(orphanedRootEntries(before, after)).toEqual([]);
	});

	/** The same thing in one paragraph, so a failure above can be read without the repo. */
	it("claims an entry that moved from Unreleased into the new version section", () => {
		const before = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A new thing that is worth a whole sentence.\n";
		const after =
			"# Changelog\n\n## [Unreleased]\n\n## [1.0.47] - 2026-08-11\n\n### Added\n\n- A new thing that is worth a whole sentence.\n";

		expect(orphanedRootEntries(before, after)).toEqual([]);
	});

	/**
	 * And the guard still does its job across the roll. A paragraph typed into the
	 * generated root reaches no package, so the release render cannot carry it
	 * under any heading, and it is reported rather than deleted.
	 */
	it("still reports a hand-written root paragraph after the roll", () => {
		const before =
			"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A new thing that is worth a whole sentence.\n- Somebody typed this straight into the generated root file.\n";
		const after =
			"# Changelog\n\n## [Unreleased]\n\n## [1.0.47] - 2026-08-11\n\n### Added\n\n- A new thing that is worth a whole sentence.\n";

		expect(orphanedRootEntries(before, after)).toEqual([
			"Somebody typed this straight into the generated root file.",
		]);
	});

	/**
	 * The cost of asking "does it survive" rather than "does it stay unreleased":
	 * an entry whose opening matches one in an ALREADY-released section is claimed.
	 * That is the honest answer to the question — the paragraph is still in the
	 * file after the write — and the alternative is refusing every release. Pinned
	 * so it is a decision rather than a surprise.
	 */
	it("claims an entry that matches one in an older released section", () => {
		const before = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- The card no longer swallows the scroll wheel.\n";
		const after =
			"# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-01-01\n\n### Fixed\n\n- The card no longer swallows the scroll wheel.\n";

		expect(orphanedRootEntries(before, after)).toEqual([]);
	});
});

describe("writeRootChangelog against a real file", () => {
	const withTempRoot = (contents: string, body: (rootPath: string) => void): void => {
		const dir = mkdtempSync(join(tmpdir(), "veyyon-root-changelog-"));
		const rootPath = join(dir, "CHANGELOG.md");
		writeFileSync(rootPath, contents);
		try {
			body(rootPath);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("writes when every on-disk entry is claimed by the render", () => {
		withTempRoot("# Changelog\n\nstale bytes\n", rootPath => {
			const result = writeRootChangelog({ rootPath });

			expect(result.orphans).toEqual([]);
			expect(result.wrote).toBe(true);
			expect(readFileSync(rootPath, "utf8")).toBe(buildRootChangelog());
		});
	});

	it("refuses and leaves the bytes untouched when a paragraph would be lost", () => {
		const handWritten = "- Somebody typed this straight into the generated root file.";
		const current = buildRootChangelog().replace("## [Unreleased]", `## [Unreleased]\n\n${handWritten}`);

		withTempRoot(current, rootPath => {
			const result = writeRootChangelog({ rootPath });

			expect(result.wrote).toBe(false);
			expect(result.orphans).toEqual([handWritten.slice(2)]);
			expect(readFileSync(rootPath, "utf8")).toBe(current);
		});
	});
});
