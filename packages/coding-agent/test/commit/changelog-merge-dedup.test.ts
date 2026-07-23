import { describe, expect, it } from "bun:test";
import { applyChangelogEntries } from "../../src/commit/changelog/index";
import { parseUnreleasedSection } from "../../src/commit/changelog/parse";

/**
 * mergeEntries dedups within one incoming batch (stale-set fix).
 *
 * The bug this suite locks out (HUNT2-coercion-mergeentries-staleset, found
 * 2026-07-22): mergeEntries built its case-insensitive membership Set once from
 * the EXISTING items, then appended each non-duplicate incoming item but never
 * added the just-appended item back into the Set. So two identical bullets in the
 * SAME incoming batch both passed the `!has()` guard and were both written — a
 * changelog with a duplicated line. Cross-batch dedup (against existing entries)
 * already worked; only intra-batch repeats leaked.
 *
 * These drive the real applyChangelogEntries -> mergeEntries path and assert the
 * rendered Unreleased body contains each bullet exactly once.
 */
describe("changelog merge dedups within a single batch", () => {
	const BASE = ["# Changelog", "", "## [Unreleased]", ""].join("\n");

	function apply(content: string, entries: Record<string, string[]>): string {
		return applyChangelogEntries(content, parseUnreleasedSection(content), entries);
	}

	function bulletCount(rendered: string, bullet: string): number {
		return rendered.split("\n").filter(line => line === `- ${bullet}`).length;
	}

	it("collapses exact duplicate bullets in the same incoming batch to one", () => {
		const out = apply(BASE, { Added: ["Fix crash", "Fix crash"] });
		expect(bulletCount(out, "Fix crash")).toBe(1);
	});

	it("collapses case-insensitive duplicates within a batch to the first spelling", () => {
		const out = apply(BASE, { Added: ["Fix Crash", "fix crash", "FIX CRASH"] });
		expect(bulletCount(out, "Fix Crash")).toBe(1);
		expect(bulletCount(out, "fix crash")).toBe(0);
		expect(bulletCount(out, "FIX CRASH")).toBe(0);
	});

	it("keeps genuinely distinct bullets while dropping the repeats", () => {
		const out = apply(BASE, { Added: ["Add flag", "Fix crash", "Add flag", "Improve speed"] });
		expect(bulletCount(out, "Add flag")).toBe(1);
		expect(bulletCount(out, "Fix crash")).toBe(1);
		expect(bulletCount(out, "Improve speed")).toBe(1);
	});

	it("still dedups an incoming bullet against one already present in the section", () => {
		const withExisting = ["# Changelog", "", "## [Unreleased]", "", "### Added", "- Existing item", ""].join("\n");
		const out = apply(withExisting, { Added: ["Existing item", "Existing item", "New item"] });
		expect(bulletCount(out, "Existing item")).toBe(1);
		expect(bulletCount(out, "New item")).toBe(1);
	});
});
