import { describe, expect, it } from "bun:test";
import { applyChangelogEntries } from "../../src/commit/changelog/index";
import { parseUnreleasedSection } from "../../src/commit/changelog/parse";

/**
 * applyChangelogEntries rewrites the "## [Unreleased]" body of a Keep-a-Changelog
 * file in place: it keeps everything up to and including the header, regenerates
 * the category lists from the merged entries, then re-attaches whatever followed
 * (the next `## [x.y.z]` release block, or nothing at EOF).
 *
 * Regression for FINDING-CHANGELOG-MISSING-BLANK-BEFORE-NEXT-RELEASE: the render
 * step drops its trailing blank line, and parse's endLine points AT the next
 * release heading (no leading blank), so the old code spliced the last Unreleased
 * entry directly against `## [1.0.0] ...` with no separating blank line. That
 * violates Keep-a-Changelog (a heading must be preceded by a blank line) and
 * strict Markdown renderers then fail to treat the release line as a heading.
 *
 * These pin the exact spliced bytes for the three shapes that matter:
 *   - entries followed by a release heading  -> exactly one blank line between them;
 *   - an empty Unreleased section followed by a release heading -> same one blank;
 *   - an Unreleased section at end-of-file    -> no spurious trailing blank added.
 * They run through the real parseUnreleasedSection so the startLine/endLine coupling
 * is exercised end to end, exactly as production does.
 */
describe("applyChangelogEntries", () => {
	function apply(content: string, entries: Record<string, string[]>): string {
		return applyChangelogEntries(content, parseUnreleasedSection(content), entries);
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
		// The source's blank line before `## [1.0.0]` lives inside the replaced Unreleased
		// body, so it is discarded and re-supplied by the separator. The result must have a
		// single blank line, not a doubled one.
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
