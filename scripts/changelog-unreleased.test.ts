/**
 * The one `## [Unreleased]` parser, and the drift that made it one.
 *
 * `require-changelog.ts` and `sync-root-changelog.ts` each carried their own
 * parser, both on the release path, and they had drifted apart on four axes. The
 * fixtures below that carry a REGRESSION doc comment are the disagreements: each
 * one passed in one parser and failed in the other, so neither suite could see
 * it. They are the reason the two were merged rather than left alone.
 */
import { describe, expect, it } from "bun:test";
import { unreleasedEntries } from "./changelog-unreleased.ts";

describe("unreleasedEntries", () => {
	it("collects only entries under Unreleased, stopping at the next release heading", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Unreleased one.",
			"- Unreleased two.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"### Added",
			"",
			"- Released, must be ignored.",
			"",
		].join("\n");

		expect(unreleasedEntries(content)).toEqual(["Unreleased one.", "Unreleased two."]);
	});

	it("returns nothing for an Unreleased section holding only sub-headings", () => {
		const content = ["# Changelog", "", "## [Unreleased]", "", "### Added", "", "## [1.0.0] - 2026-01-01", ""].join(
			"\n",
		);

		expect(unreleasedEntries(content)).toEqual([]);
	});

	it("returns nothing for a changelog with no Unreleased section at all", () => {
		expect(unreleasedEntries("# Changelog\n\n## [1.0.0]\n\n### Fixed\n\n- released\n")).toEqual([]);
	});

	it("returns nothing for an empty changelog, which is how a new package reads at base", () => {
		expect(unreleasedEntries("")).toEqual([]);
	});

	it("returns nothing for an Unreleased section holding only whitespace", () => {
		const content = ["# Changelog", "", "## [Unreleased]", "   ", "\t", "", "## [1.0.0] - 2026-01-01", ""].join("\n");

		expect(unreleasedEntries(content)).toEqual([]);
	});

	it("collects an entry in a trailing Unreleased section with no following version heading", () => {
		const content = ["# Changelog", "", "## [Unreleased]", "", "- A change with nothing below it."].join("\n");

		expect(unreleasedEntries(content)).toEqual(["A change with nothing below it."]);
	});

	it("joins a wrapped entry into one string and collapses its whitespace", () => {
		const md = "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- first line\n  second   line\n";

		expect(unreleasedEntries(md)).toEqual(["first line second line"]);
	});

	/**
	 * REGRESSION, and the one that destroyed data.
	 *
	 * `sync-root-changelog` detected a bullet with `line.startsWith("- ")` against
	 * the UNTRIMMED line, so an entry indented under its category sub-heading was
	 * invisible to it and it answered "no entries". `orphanedRootEntries` is the
	 * check that refuses to overwrite entries no source package claims, and an
	 * entry it cannot see looks like nothing to protect, so the root changelog
	 * writer overwrote it. `require-changelog` trimmed first and saw the entry
	 * fine, which is why no suite caught the difference.
	 *
	 * If this goes red, indented entries are being silently dropped again.
	 */
	it("sees an entry indented under its sub-heading, which an untrimmed match misses", () => {
		const md = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"  - adds a nested thing",
			"",
			"## [1.0.0]",
		].join("\n");

		expect(unreleasedEntries(md)).toEqual(["adds a nested thing"]);
	});

	/**
	 * REGRESSION. `require-changelog` matched the heading with an exact string
	 * compare, so `## [Unreleased] - TBD` was not the heading and a package that
	 * annotated its heading read as having no entries. That fails the changelog
	 * gate on a package that did write one.
	 */
	it("matches an Unreleased heading that carries a suffix", () => {
		const md = "# Changelog\n\n## [Unreleased] - unreleased\n\n### Fixed\n\n- entry\n";

		expect(unreleasedEntries(md)).toEqual(["entry"]);
	});

	/**
	 * REGRESSION. `require-changelog` counted a bare `-` as an entry, so an empty
	 * placeholder bullet satisfied the changelog gate and bought a release that
	 * documented nothing.
	 */
	it("does not count a bullet with no text as an entry", () => {
		expect(unreleasedEntries("# Changelog\n\n## [Unreleased]\n\n-\n\n## [1.0.0]\n")).toEqual([]);
	});

	/**
	 * REGRESSION, and the guard eating itself.
	 *
	 * The heading was once located with an unanchored `indexOf("## [Unreleased]")`,
	 * so PROSE that mentions the heading matched before the heading did. The first
	 * text to do that was the root file's own banner telling contributors where to
	 * write: the search landed inside the banner, the block ended one line later at
	 * the real heading, and the parser answered "no entries" for a file full of
	 * them. That silently disables the orphan check, because every entry on disk
	 * then reads as unclaimed. A heading is a line, so the pattern is a line.
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

		expect(unreleasedEntries(md)).toEqual(["the real entry"]);
	});
});
