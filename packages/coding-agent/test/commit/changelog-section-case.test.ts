import { describe, expect, it } from "bun:test";
import { applyChangelogEntries } from "../../src/commit/changelog/index";
import { parseUnreleasedSection } from "../../src/commit/changelog/parse";

/**
 * Changelog section-name matching is case-insensitive (canonicalized casing).
 *
 * The bug this suite locks out (HUNT2-coercion-changelog-section-case, found
 * 2026-07-22): item bullets were matched case-INSENSITIVELY (the `.toLowerCase()`
 * compares in applyDeletions/mergeEntries) but the section-name KEYS were matched
 * case-SENSITIVELY. So a model-proposed section whose case differed from the
 * parsed file header (proposal "fixed" vs file "### Fixed") broke two ways:
 *   - a deletion silently no-oped: deletions["fixed"] never matched base["Fixed"],
 *     so the entry the model asked to remove stayed.
 *   - a merge duplicated the section: merged["fixed"] was created alongside the
 *     existing "Fixed", and since renderUnreleasedSections only emits the canonical
 *     CHANGELOG_SECTIONS keys, the lowercase section's items VANISHED from output.
 *
 * The fix canonicalizes every section key (parsed base, incoming entries, and
 * deletions) to Keep-a-Changelog casing inside applyChangelogEntries — the single
 * funnel both callers pass through — folding same-canonical keys together. These
 * drive the real applyChangelogEntries path and assert the rendered body.
 */
describe("changelog section names match case-insensitively", () => {
	const BASE_EMPTY = ["# Changelog", "", "## [Unreleased]", ""].join("\n");
	const BASE_WITH_FIXED = ["# Changelog", "", "## [Unreleased]", "", "### Fixed", "- fix a", ""].join("\n");

	/** Count rendered `### <Section>` heading lines with EXACTLY this casing. */
	function sectionHeadingCount(rendered: string, heading: string): number {
		return rendered.split("\n").filter(line => line === `### ${heading}`).length;
	}

	it("deletes an entry whose proposal section case differs from the file header", () => {
		// File has "### Fixed / - fix a"; the model proposes deleting under "fixed".
		const out = applyChangelogEntries(
			BASE_WITH_FIXED,
			parseUnreleasedSection(BASE_WITH_FIXED),
			{},
			{ fixed: ["fix a"] },
		);
		// The entry is gone, and with the section now empty its heading is gone too.
		expect(out).not.toContain("- fix a");
		expect(sectionHeadingCount(out, "Fixed")).toBe(0);
	});

	it("merges a case-differing proposal into the SAME section, never a duplicate", () => {
		// File "### Fixed / - fix a"; proposal adds "fix b" under lowercase "fixed".
		const out = applyChangelogEntries(BASE_WITH_FIXED, parseUnreleasedSection(BASE_WITH_FIXED), {
			fixed: ["fix b"],
		});
		// Exactly one Fixed heading, no stray lowercase heading, both bullets present.
		expect(sectionHeadingCount(out, "Fixed")).toBe(1);
		expect(sectionHeadingCount(out, "fixed")).toBe(0);
		expect(out).toContain("- fix a");
		expect(out).toContain("- fix b");
	});

	it("renders a lowercase-proposed section under its canonical heading (not dropped)", () => {
		// Pre-fix, a lowercase-only section vanished because the renderer emits only
		// canonical keys. It must now surface under "### Fixed".
		const out = applyChangelogEntries(BASE_EMPTY, parseUnreleasedSection(BASE_EMPTY), { fixed: ["fix a"] });
		expect(sectionHeadingCount(out, "Fixed")).toBe(1);
		expect(out).toContain("- fix a");
	});

	it("folds two case-variant keys in one incoming batch into a single section", () => {
		const out = applyChangelogEntries(BASE_EMPTY, parseUnreleasedSection(BASE_EMPTY), {
			Fixed: ["fix a"],
			fixed: ["fix b"],
		});
		expect(sectionHeadingCount(out, "Fixed")).toBe(1);
		expect(out).toContain("- fix a");
		expect(out).toContain("- fix b");
	});

	it("still renders a correctly-cased section unchanged (canonicalization is a no-op on canonical input)", () => {
		const out = applyChangelogEntries(BASE_EMPTY, parseUnreleasedSection(BASE_EMPTY), { Fixed: ["fix a"] });
		expect(sectionHeadingCount(out, "Fixed")).toBe(1);
		expect(out).toContain("- fix a");
	});
});
