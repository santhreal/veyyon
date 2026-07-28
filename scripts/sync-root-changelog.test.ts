// The repo-root CHANGELOG sync shell.
//
// Three contracts matter here and are worth a dedicated suite:
//
//  1. the shell renders through the ONE shared core, so the root file can never
//     diverge from the website's changelog logic,
//  2. the root aggregates EVERY package's changelog, because the file a visitor
//     reads on the GitHub repo page is the product's changelog and a generator
//     that reads one package silently deletes the rest on every regeneration,
//  3. the file actually committed at the repo root is in sync with those
//     sources — the same thing `changelog:root:check` enforces in CI, encoded as
//     a test so a local `bun test` catches drift before a push.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { renderRootChangelog } from "../website/tools/gen-changelog.mjs";
import {
	buildRootChangelog,
	changelogSources,
	orphanedRootEntries,
	PACKAGES_DIR,
	REPO_ROOT,
	ROOT_PATH,
	unreleasedBullets,
} from "./sync-root-changelog";

describe("buildRootChangelog", () => {
	it("renders through the shared renderRootChangelog core, not a private copy", () => {
		// If the shell ever grew its own rebrand/merge logic, this would diverge and
		// the website and repo-root changelogs could drift apart.
		expect(buildRootChangelog()).toBe(renderRootChangelog(changelogSources()));
	});

	it("produces a non-trivial changelog: title, at least one release, and the upstream credit", () => {
		const md = buildRootChangelog();
		expect(md.startsWith("# Changelog\n")).toBe(true);
		expect(md).toMatch(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/); // a real cut release
		expect(md).toContain("## Upstream history");
		expect(md.trimEnd().endsWith("for it.")).toBe(true);
	});

	it("speaks in Veyyon's voice: no leaked upstream omp CLI or scheme tokens", () => {
		const md = buildRootChangelog();
		expect(md).not.toContain("omp://");
		expect(md).not.toMatch(/\bomp /);
	});

	/**
	 * The link rule, stated as a test because it was previously only implicit and
	 * the committed file disagreed with the generator about it. An issue link into
	 * `can1357/oh-my-pi` from veyyon's own changelog sends the reader to a
	 * different project's tracker, which cannot answer their question, so the root
	 * strips them exactly as the website does. The per-package changelogs keep
	 * them as the engineering record.
	 */
	it("strips upstream issue links while keeping the upstream credit", () => {
		const md = buildRootChangelog();
		expect(md).not.toContain("can1357/oh-my-pi/issues");
		// The credit note still links the project itself, which is the attribution
		// and must survive.
		expect(md).toContain("https://github.com/can1357/oh-my-pi");
	});
});

describe("the root changelog covers every package", () => {
	/**
	 * The defect this work fixed. The old generator read `coding-agent` alone, so
	 * a fix recorded in any other package vanished from the root the moment anyone
	 * regenerated it. `hashline` is the exemplar because it is a non-lead package
	 * that has its own cut veyyon release, so its entries have to travel through
	 * both the multi-source read and the fork-point cut to arrive.
	 */
	it("carries an entry that lives only in a non-lead package", () => {
		const hashline = readFileSync(join(PACKAGES_DIR, "hashline", "CHANGELOG.md"), "utf8");
		expect(hashline).toContain("`MV DEST` no longer silently overwrites");

		expect(buildRootChangelog()).toContain("`MV DEST` no longer silently overwrites");
	});

	/**
	 * Every package with a changelog must be read. A source list built by hand
	 * would go stale the first time a package is added, and the failure would be
	 * silent: the new package's entries simply never appear.
	 */
	it("reads every packages/*/CHANGELOG.md", () => {
		const names = changelogSources().map(source => source.name);
		expect(names).toContain("coding-agent");
		expect(names).toContain("collab-web");
		expect(names).toContain("ai");
		expect(names).toContain("utils");
		// The product's own entries lead, so they are what a reader sees first.
		expect(names[0]).toBe("coding-agent");
	});

	/**
	 * Merging must not replay the same fix twice. Packages that share a change
	 * sometimes record identical wording, and a root that listed it once per
	 * package would read as noise and make the reader distrust the rest.
	 */
	it("lists each distinct entry once", () => {
		const md = buildRootChangelog();
		const bullets = md.split("\n").filter(line => line.startsWith("- "));
		expect(bullets.length).toBeGreaterThan(0);
		expect(new Set(bullets).size).toBe(bullets.length);
	});

	/**
	 * Only veyyon's own releases appear. Every package carries inherited oh-my-pi
	 * history at or below the fork point, and replaying thirteen packages' worth
	 * of it would bury veyyon's actual releases under someone else's.
	 */
	it("collapses pre-fork upstream releases into the credit note", () => {
		const md = buildRootChangelog();
		expect(md).not.toMatch(/^## \[16\./m);
		expect(md).toContain("## Upstream history");
	});

	/**
	 * The cut is positional, and this is the case that proves a per-entry version
	 * test cannot work. Upstream's history descends below the fork major: this
	 * package records a `15.9.0` underneath its 16.x entries. A rule of "keep
	 * anything whose major is below 16" reads that as a veyyon release, and it
	 * along with every other pre-16 upstream entry came back into the root and
	 * inflated it to over fifteen thousand lines of another project's releases.
	 * Cutting at the FIRST entry at or above the fork major discards everything
	 * below it, which is correct because each file is newest-first.
	 */
	it("drops upstream history that dips below the fork major", () => {
		const swarm = readFileSync(join(PACKAGES_DIR, "swarm-extension", "CHANGELOG.md"), "utf8");
		// The precondition: a pre-16 upstream entry sitting below a 16.x one.
		expect(swarm.indexOf("## [16.3.7]")).toBeLessThan(swarm.indexOf("## [15.9.0]"));

		expect(buildRootChangelog()).not.toMatch(/^## \[15\./m);
	});

	/**
	 * The same rule stated directly on the renderer, so a regression is diagnosed
	 * here rather than through the whole repo's changelogs. Only the leading run
	 * survives: `0.9.0` is upstream history that happens to sort below the fork
	 * major, and it must not be mistaken for a veyyon release.
	 */
	it("keeps only the contiguous leading run of post-fork releases", () => {
		const md = renderRootChangelog(
			[
				{
					name: "a",
					md:
						"# Changelog\n\n## [1.0.1] - 2026-03-01\n\n### Fixed\n\n- ours\n\n" +
						"## [16.5.2] - 2026-01-01\n\n### Fixed\n\n- fork point\n\n" +
						"## [0.9.0] - 2025-01-01\n\n### Fixed\n\n- ancient upstream\n",
				},
			],
			{ forkPointVersion: "16.5.2" },
		) as string;

		expect(md).toContain("- ours");
		expect(md).not.toContain("- fork point");
		expect(md).not.toContain("- ancient upstream");
	});

	/**
	 * A package that has never been cut since the fork contributes its pending
	 * work and nothing else. Without the `Unreleased` exemption the cut would fire
	 * on the very first versioned entry and silently drop pending entries from
	 * every package but the two that have released.
	 */
	it("keeps Unreleased from a package with no release of its own", () => {
		const md = renderRootChangelog(
			[
				{
					name: "a",
					md: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- pending\n\n## [16.5.1] - 2026-01-01\n\n### Fixed\n\n- upstream\n",
				},
			],
			{ forkPointVersion: "16.5.2" },
		) as string;

		expect(md).toContain("- pending");
		expect(md).not.toContain("- upstream");
	});

	/**
	 * Sections keep Keep a Changelog order within a release, so the merged result
	 * reads like a changelog rather than like whatever order the packages happened
	 * to be read in.
	 */
	it("orders sections Added before Fixed within a release", () => {
		const md = renderRootChangelog([
			{ name: "a", md: "# Changelog\n\n## [1.0.1] - 2026-01-01\n\n### Fixed\n\n- fixed thing\n" },
			{ name: "b", md: "# Changelog\n\n## [1.0.1] - 2026-01-01\n\n### Added\n\n- added thing\n" },
		]) as string;

		expect(md.indexOf("### Added")).toBeLessThan(md.indexOf("### Fixed"));
		expect(md).toContain("- added thing");
		expect(md).toContain("- fixed thing");
	});

	/**
	 * Releases are newest-first, with `Unreleased` at the top, whatever order the
	 * packages list them in. Version comparison has to be numeric: sorted as
	 * strings, 1.0.37 would fall below 1.0.4.
	 */
	it("orders releases newest first, Unreleased on top", () => {
		const md = renderRootChangelog([
			{ name: "a", md: "# Changelog\n\n## [1.0.4] - 2026-01-01\n\n### Fixed\n\n- older\n" },
			{
				name: "b",
				md: "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- pending\n\n## [1.0.37] - 2026-02-01\n\n### Fixed\n\n- newer\n",
			},
		]) as string;

		expect(md.indexOf("## [Unreleased]")).toBeLessThan(md.indexOf("## [1.0.37]"));
		expect(md.indexOf("## [1.0.37]")).toBeLessThan(md.indexOf("## [1.0.4]"));
	});

	/**
	 * A release date belongs to the release, not to whichever package happened to
	 * be read first, and a package that omitted it must not blank it.
	 */
	it("keeps a release date even when one package omits it", () => {
		const md = renderRootChangelog([
			{ name: "a", md: "# Changelog\n\n## [1.0.1]\n\n### Fixed\n\n- undated\n" },
			{ name: "b", md: "# Changelog\n\n## [1.0.1] - 2026-01-01\n\n### Fixed\n\n- dated\n" },
		]) as string;

		expect(md).toContain("## [1.0.1] - 2026-01-01");
	});
});

/**
 * The root is generated, so a paragraph written directly into it is not a
 * changelog entry — it is content the next render deletes. That is easy to do by
 * accident, because the root is the file a contributor opens first and it reads
 * as hand-written, and the deletion was SILENT: `--check` failed in CI, the
 * contributor ran the fix command it names, and the fix threw their paragraph
 * away without a word. It happened during this session, to 23 entries across
 * several packages.
 *
 * So the write path refuses when the root holds an unreleased entry the render
 * does not produce. These tests pin the detection, and above all pin that it does
 * not cry wolf: a guard with false positives gets bypassed and then protects
 * nothing.
 */
describe("orphaned root entries", () => {
	const ROOT = (bullets: string) =>
		`# Changelog\n\n## [Unreleased]\n\n### Changed\n\n${bullets}\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- old\n`;

	it("reports an entry the render does not produce", () => {
		const orphans = orphanedRootEntries(ROOT("- hand written\n- rendered"), ROOT("- rendered"));

		expect(orphans).toEqual(["hand written"]);
	});

	it("reports nothing when every entry is accounted for", () => {
		expect(orphanedRootEntries(ROOT("- rendered"), ROOT("- rendered"))).toEqual([]);
	});

	/** The renderer rewrites entry text on the way through (the omp→veyyon rebrand),
	 * which is why the comparison is against the RENDER and not against the package
	 * files: comparing to the sources reported every rewritten entry as unclaimed. */
	it("does not report an entry the renderer rewrote, because it compares to the render", () => {
		expect(orphanedRootEntries(buildRootChangelog(), buildRootChangelog())).toEqual([]);
	});

	/** A bullet may wrap over several lines. Comparing lines instead of whole
	 * bullets would report every wrapped entry as half-missing. */
	it("treats a re-wrapped entry as the same entry", () => {
		const wrapped = ROOT("- one entry that happens to\n  wrap over two lines");
		const flat = ROOT("- one entry that happens to wrap over two lines");

		expect(orphanedRootEntries(wrapped, flat)).toEqual([]);
	});

	/**
	 * The regression that made this guard hostile. Editing a package entry after a
	 * root sync left the root holding the old wording, which was reported as an
	 * orphan, and the ONLY way forward was `--force`, whose purpose is to discard
	 * entries deliberately. A routine reword pushed the author onto the one flag
	 * that can lose work. It was hit three times in one session.
	 */
	it("does not report an entry whose wording was edited after the last sync", () => {
		const before = ROOT("- The selected roster row is highlighted across the whole row, which it was not before.");
		const after = ROOT("- The selected roster row is highlighted across the whole row and stops at the gutter.");

		expect(orphanedRootEntries(before, after)).toEqual([]);
	});

	/** An entry that gained a whole trailing paragraph is still the same entry. */
	it("does not report an entry that grew after the last sync", () => {
		const before = ROOT("- Page up and page down move the Agent Control Center.");
		const after = ROOT(
			"- Page up and page down move the Agent Control Center. They come from the shared bindings, so it is the same key and the same distance as every other selector.",
		);

		expect(orphanedRootEntries(before, after)).toEqual([]);
	});

	/**
	 * And the guard still fires on what it exists for. A paragraph typed into the
	 * root by hand shares no opening with anything the render produces, so it is
	 * reported rather than silently deleted by the next write.
	 */
	it("still reports a hand-written entry that shares no opening with any rendered one", () => {
		const rendered = ROOT("- The selected roster row is highlighted across the whole row.");
		const withHandWritten = ROOT(
			"- The selected roster row is highlighted across the whole row.\n- Somebody typed this straight into the generated root file.",
		);

		expect(orphanedRootEntries(withHandWritten, rendered)).toEqual([
			"Somebody typed this straight into the generated root file.",
		]);
	});

	/**
	 * An entry rewritten from its FIRST word is indistinguishable from a new
	 * hand-written paragraph, and is reported. That is the right way round:
	 * reporting a reword costs a sentence of reading, and missing a hand-written
	 * paragraph loses it. Pinned so the limitation is a decision, not a surprise.
	 */
	it("reports an entry rewritten from its opening, which cannot be told from a new one", () => {
		const before = ROOT("- Wheel scrolling now moves the card rather than being swallowed by it.");
		const after = ROOT("- The scroll wheel moves the card instead of being swallowed by it.");

		expect(orphanedRootEntries(before, after)).toEqual([
			"Wheel scrolling now moves the card rather than being swallowed by it.",
		]);
	});

	/**
	 * A short entry has no distinctive opening, so it is matched on its whole
	 * text. Two one-word bullets sharing a prefix are not the same entry, and
	 * treating them as one would silently drop the second.
	 */
	it("matches a short entry on its whole text rather than an opening", () => {
		expect(orphanedRootEntries(ROOT("- fixed a thing"), ROOT("- fixed a thing too"))).toEqual(["fixed a thing"]);
	});

	it("ignores released sections, which are not at risk", () => {
		const withRelease = `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- kept\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- only here\n`;
		const rendered = `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- kept\n`;

		expect(orphanedRootEntries(withRelease, rendered)).toEqual([]);
	});
});

describe("unreleasedBullets", () => {
	it("reads bullets from the unreleased section only", () => {
		const md = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n\n### Changed\n\n- changed thing\n\n## [1.0.0]\n\n### Fixed\n\n- released thing\n`;

		expect(unreleasedBullets(md)).toEqual(["new thing", "changed thing"]);
	});

	it("returns nothing for a changelog with no unreleased section", () => {
		expect(unreleasedBullets("# Changelog\n\n## [1.0.0]\n\n### Fixed\n\n- released\n")).toEqual([]);
	});

	it("joins a wrapped bullet into one entry and collapses its whitespace", () => {
		const md = "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- first line\n  second   line\n";

		expect(unreleasedBullets(md)).toEqual(["first line second line"]);
	});

	/**
	 * THE REGRESSION, and it is the guard eating itself.
	 *
	 * The heading was located with an unanchored `indexOf("## [Unreleased]")`, so any PROSE that
	 * mentions the heading matched before the heading did. The first text to do that was the root
	 * file's own new "generated file" banner, which names the section a contributor should write
	 * in: the search landed inside the banner, the block ended one line later at the real heading,
	 * and this function answered "no entries" for a file full of them. That answer silently
	 * disables the orphan check -- every entry on disk reads as unclaimed -- so the writer refuses
	 * to regenerate at all. A heading is a line, so the pattern is anchored to a line.
	 */
	it("ignores prose that merely mentions the heading", () => {
		const md = [
			"# Changelog",
			"",
			"> Add your entry under `## [Unreleased]` in the package changelog, not here.",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- the real entry",
			"",
		].join("\n");

		expect(unreleasedBullets(md)).toEqual(["the real entry"]);
	});

	/** A dated or annotated Unreleased heading is still the Unreleased heading. */
	it("matches an unreleased heading that carries a suffix", () => {
		const md = "# Changelog\n\n## [Unreleased] - unreleased\n\n### Fixed\n\n- entry\n";

		expect(unreleasedBullets(md)).toEqual(["entry"]);
	});

	/**
	 * And the banner the renderer actually emits is parsed correctly, not just a hand-written
	 * lookalike. Asserting against the real render is what makes this a check on the pair rather
	 * than on a fixture that can drift away from the banner it stands in for.
	 */
	it("reads the unreleased entries out of the real generated root", () => {
		const bullets = unreleasedBullets(buildRootChangelog());

		expect(bullets.length).toBeGreaterThan(20);
		expect(bullets.every(bullet => !bullet.includes("Generated file."))).toBe(true);
	});
});

describe("committed root CHANGELOG.md", () => {
	it("is byte-identical to a fresh render of the sources (the CI drift guard, locally)", () => {
		// This is exactly what `bun run changelog:root:check` asserts. Having it as
		// a unit test means editing any package changelog without running
		// `bun run changelog:root` turns the local suite red, not just CI.
		expect(readFileSync(ROOT_PATH, "utf8")).toBe(buildRootChangelog());
	});

	it("lives at the repo root where a GitHub visitor looks first", () => {
		expect(ROOT_PATH).toBe(join(REPO_ROOT, "CHANGELOG.md"));
	});
});
