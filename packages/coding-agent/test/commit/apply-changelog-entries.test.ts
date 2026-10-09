import { describe, expect, it } from "bun:test";
import { applyChangelogEntries } from "../../src/commit/changelog/index";
import { parseUnreleasedLayout } from "../../src/commit/changelog/parse";

/**
 * applyChangelogEntries edits the "## [Unreleased]" body of a Keep-a-Changelog
 * file in place: a new bullet goes after the last entry of its category, a new
 * category goes after the last category that sorts before it, and every other
 * line is kept, including whatever follows (the next `## [x.y.z]` release block,
 * or nothing at EOF).
 *
 * Regression for FINDING-CHANGELOG-MISSING-BLANK-BEFORE-NEXT-RELEASE: an earlier
 * renderer dropped its trailing blank line, and parse's endLine points AT the next
 * release heading (no leading blank), so the last Unreleased entry was spliced
 * directly against `## [1.0.0] ...` with no separating blank line. That violates
 * Keep-a-Changelog (a heading must be preceded by a blank line) and strict
 * Markdown renderers then fail to treat the release line as a heading.
 *
 * These pin the exact edited bytes for three shapes:
 *   - entries followed by a release heading  -> exactly one blank line between them;
 *   - an empty Unreleased section followed by a release heading -> same one blank;
 *   - an Unreleased section at end-of-file    -> no spurious trailing blank added.
 * They run through the real parseUnreleasedLayout so the line-span coupling is
 * exercised end to end, exactly as production does.
 */
describe("applyChangelogEntries", () => {
	function apply(content: string, entries: Record<string, string[]>): string {
		return applyChangelogEntries(parseUnreleasedLayout(content), entries);
	}

	it("separates the last Unreleased entry from the next release heading with one blank line", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"- old thing",
			"",
			"## [1.0.0] - 2024-01-01",
			"",
			"### Added",
			"- shipped",
		].join("\n");

		expect(apply(content, { Added: ["new thing"] })).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Added",
				"- old thing",
				"- new thing",
				"", // the separator that was missing before the fix
				"## [1.0.0] - 2024-01-01",
				"",
				"### Added",
				"- shipped",
			].join("\n"),
		);
	});

	it("adds the separator blank even when the Unreleased section started empty", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [1.0.0] - 2024-01-01",
			"",
			"### Fixed",
			"- a bug",
		].join("\n");

		expect(apply(content, { Added: ["first"] })).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Added",
				"- first",
				"",
				"## [1.0.0] - 2024-01-01",
				"",
				"### Fixed",
				"- a bug",
			].join("\n"),
		);
	});

	it("inserts exactly one blank line, never two, when the source already had a blank before the release", () => {
		// The source's blank line before `## [1.0.0]` stays where it is and the new bullet
		// goes above it. The result must have a single blank line, not a doubled one.
		const content = ["## [Unreleased]", "", "### Added", "- x", "", "## [1.0.0]", "- released"].join("\n");
		const result = apply(content, { Added: ["y"] });

		expect(result).toBe(
			["## [Unreleased]", "", "### Added", "- x", "- y", "", "## [1.0.0]", "- released"].join("\n"),
		);
		expect(result).not.toContain("\n\n\n");
	});

	it("adds no trailing blank line when the Unreleased section is at end of file", () => {
		const content = ["# Changelog", "", "## [Unreleased]", "", "### Added", "- old"].join("\n");
		const result = apply(content, { Fixed: ["bugfix"] });

		expect(result).toBe(
			["# Changelog", "", "## [Unreleased]", "", "### Added", "- old", "", "### Fixed", "- bugfix"].join("\n"),
		);
		// The end-of-file case must not gain a trailing blank line on every write.
		expect(result.endsWith("- bugfix")).toBe(true);
		expect(result.endsWith("\n")).toBe(false);
	});
});
