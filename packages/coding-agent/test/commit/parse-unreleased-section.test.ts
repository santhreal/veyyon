import { describe, expect, it } from "bun:test";
import { parseUnreleasedSection } from "../../src/commit/changelog/parse";

/**
 * parseUnreleasedSection locates the "## [Unreleased]" block of a Keep-a-Changelog
 * file, groups its "### <Category>" bullet lists, and reports the line range so the
 * changelog agent can splice a new entry in. It had no test. The parser has several
 * load-bearing rules pinned here:
 *   - the header match is case-insensitive and the brackets are optional
 *     ("## unreleased" and "## [Unreleased]" both match);
 *   - the section ends at the NEXT "## " heading (a later release block is
 *     excluded), or end-of-file if there is none;
 *   - endLine is that boundary index (exclusive), startLine is the header index;
 *   - a bullet before any "### Category" is ignored;
 *   - an empty "### Category" still produces an empty array for that category;
 *   - a bare "-" (empty entry) is not pushed, and leading whitespace after the
 *     bullet marker is stripped;
 *   - both "-" and "*" bullets are captured through ONE shared bullet regex
 *     (BULLET_ENTRY_PATTERN, /^[-*]\s*(.*)$/): recognition and marker-stripping use
 *     the same character class, so a "*" entry can never be seen by one and dropped
 *     by the other. This locks the fix for the earlier guard/regex inconsistency
 *     where startsWith("-") silently dropped a real "* ..." changelog line;
 *   - a missing Unreleased section throws.
 */

describe("parseUnreleasedSection", () => {
	it("parses categories and bullets, ending at the next release heading", () => {
		const changelog = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"- new thing",
			"- second thing",
			"",
			"### Fixed",
			"- a bug",
			"",
			"## [1.0.0] - 2024-01-01",
			"",
			"### Added",
			"- old",
		].join("\n");

		expect(parseUnreleasedSection(changelog)).toEqual({
			startLine: 2,
			endLine: 11,
			entries: { Added: ["new thing", "second thing"], Fixed: ["a bug"] },
		});
	});

	it("matches the header case-insensitively and without brackets, running to EOF", () => {
		const changelog = ["## unreleased", "### Changed", "-  spaced entry"].join("\n");
		expect(parseUnreleasedSection(changelog)).toEqual({
			startLine: 0,
			endLine: 3,
			entries: { Changed: ["spaced entry"] },
		});
	});

	it("captures both '-' and '*' bullets, dropping only a bare marker and non-bullet text", () => {
		// Regression for the guard/regex inconsistency: a "* ..." entry must be kept (Markdown allows
		// "*" and the shared bullet regex accepts it), while a bare "- " (no text) and a plain
		// non-bullet line are still dropped.
		const changelog = ["## [Unreleased]", "### Changed", "- kept", "* star kept", "- ", "plain text"].join("\n");
		expect(parseUnreleasedSection(changelog).entries).toEqual({ Changed: ["kept", "star kept"] });
	});

	it("strips extra whitespace after a '*' marker the same way as after '-'", () => {
		const changelog = ["## [Unreleased]", "### Changed", "*   star spaced", "-\ttab kept"].join("\n");
		expect(parseUnreleasedSection(changelog).entries).toEqual({ Changed: ["star spaced", "tab kept"] });
	});

	it("ignores a bullet that appears before any category heading", () => {
		const changelog = ["## [Unreleased]", "- orphan bullet", "### Added", "- real"].join("\n");
		expect(parseUnreleasedSection(changelog).entries).toEqual({ Added: ["real"] });
	});

	it("produces an empty array for a category with no bullets", () => {
		const changelog = ["## [Unreleased]", "### Added", "### Fixed", "- x"].join("\n");
		expect(parseUnreleasedSection(changelog).entries).toEqual({ Added: [], Fixed: ["x"] });
	});

	it("throws when there is no Unreleased section", () => {
		expect(() => parseUnreleasedSection("# Changelog\n## [1.0.0]\n- x")).toThrow(
			"No [Unreleased] section found in changelog",
		);
	});
});
