import { describe, expect, it } from "bun:test";
import { applyReleaseToChangelog } from "./release.ts";

/**
 * Pins the changelog-roll contract: turning `## [Unreleased]` into a dated
 * `## [version]` entry when a release cuts.
 *
 * Why this suite exists: the previous roll inserted a fresh `## [Unreleased]`
 * anchored to the `# Changelog\n\n` title. In `packages/hashline/CHANGELOG.md`
 * the `## [Unreleased]` section lives BELOW a fork-notice blockquote, so the
 * title-anchored insert put a second `[Unreleased]` ABOVE the fork notice and
 * renamed the real (below-notice) one to the version — stranding the actual
 * bullets in a version section, while the empty top `[Unreleased]` made
 * `has-releasable-changes` read false. The net effect: a "released" version that
 * carried the changes but never published, and no way to cut the next one. These
 * tests lock the fork-notice ordering, the no-empty-version rule, and the
 * newest-first section order so that regression can't return silently.
 */

const DATE = "2026-07-23";

describe("applyReleaseToChangelog", () => {
	it("keeps [Unreleased] below a fork-notice blockquote and inserts the version under it", () => {
		// The exact hashline shape that broke: blockquote, then [Unreleased] with a bullet.
		const before = [
			"# Changelog",
			"",
			"> **Fork notice.** Veyyon is a source fork of oh-my-pi.",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- Large-range edits are now linear, not quadratic.",
			"",
			"## [16.5.0] - 2026-07-13",
			"",
			"### Fixed",
			"",
			"- An earlier upstream fix.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.18", DATE);

		// The fork notice stays at the very top, right under the title.
		expect(after.indexOf("> **Fork notice.**")).toBeLessThan(after.indexOf("## [Unreleased]"));
		// A single [Unreleased], and it sits BELOW the fork notice, not above it.
		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
		// The new dated version lands directly under [Unreleased] and above the prior version.
		const unreleasedAt = after.indexOf("## [Unreleased]");
		const newVersionAt = after.indexOf("## [1.0.18] - 2026-07-23");
		const priorVersionAt = after.indexOf("## [16.5.0]");
		expect(unreleasedAt).toBeLessThan(newVersionAt);
		expect(newVersionAt).toBeLessThan(priorVersionAt);
		// The real bullet moved with the version section, not left in [Unreleased].
		expect(after.indexOf("- Large-range edits are now linear")).toBeGreaterThan(newVersionAt);
		expect(after.indexOf("- Large-range edits are now linear")).toBeLessThan(priorVersionAt);
	});

	it("preserves the [Unreleased] header for the next cycle above the new version (no fork notice)", () => {
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- A new flag.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"- First.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.1", DATE);

		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
		expect(after.indexOf("## [Unreleased]")).toBeLessThan(after.indexOf("## [1.0.1] - 2026-07-23"));
		expect(after.indexOf("## [1.0.1] - 2026-07-23")).toBeLessThan(after.indexOf("## [1.0.0] - 2026-01-01"));
		expect(after).toContain("- A new flag.");
	});

	it("creates no version entry when [Unreleased] has no bullets", () => {
		// An empty [Unreleased] must never mint a dated section — that is exactly the
		// phantom-version bug. has-releasable-changes gates the cut; the roll must not
		// fabricate content when there is none.
		const before = ["# Changelog", "", "## [Unreleased]", "", "## [1.0.0] - 2026-01-01", "", "- First.", ""].join(
			"\n",
		);

		const after = applyReleaseToChangelog(before, "1.0.1", DATE);

		expect(after).not.toContain("## [1.0.1]");
		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
	});

	it("drops a pre-existing empty dated version section", () => {
		// A prior failed roll can leave an empty `## [x] - date`; the next roll must
		// clean it so the file never accretes hollow version headers.
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"- Real change.",
			"",
			"## [1.0.5] - 2026-06-01",
			"",
			"## [1.0.4] - 2026-05-01",
			"",
			"- Older real change.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.6", DATE);

		expect(after).not.toContain("## [1.0.5] - 2026-06-01");
		expect(after).toContain("## [1.0.6] - 2026-07-23");
		expect(after).toContain("## [1.0.4] - 2026-05-01");
	});

	it("mints no version for a [Unreleased] with only a header and no bullets (gate parity)", () => {
		// The divergence this locks out: release.ts once used a looser "any
		// non-whitespace" check, so a stray `### Fixed` header (no bullets) would
		// create a hollow version section for THIS package when another package's
		// real bullets triggered the cut. The release gate counts bullets, so the
		// roll must too — a header alone is not releasable content.
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"- First.",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.0.1", DATE);

		expect(after).not.toContain("## [1.0.1]");
		expect(after.match(/## \[Unreleased\]/g)).toHaveLength(1);
	});

	it("is a no-op transform when there is no [Unreleased] section at all", () => {
		const before = ["# Changelog", "", "## [1.0.0] - 2026-01-01", "", "- First.", ""].join("\n");
		expect(applyReleaseToChangelog(before, "1.0.1", DATE)).toBe(before);
	});
});
