import { describe, expect, it } from "bun:test";
import { hasReleasableChanges } from "./has-releasable-changes.ts";

/**
 * Guards the auto-release trigger. If this logic regresses, main either stops
 * releasing when it should (users fall behind, the exact complaint that added
 * auto-release) or releases on every push including the version-bump commit
 * (an infinite release loop). Both are release-pipeline outages, so the gate is
 * pinned with real changelog bodies, not shape checks.
 */
describe("hasReleasableChanges", () => {
	const withBullet = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"- Fix a real user-facing bug",
		"",
		"## [1.0.0]",
		"- old",
	].join("\n");
	const emptyUnreleased = ["# Changelog", "", "## [Unreleased]", "", "## [1.0.0]", "", "- shipped already"].join("\n");
	const noUnreleasedSection = ["# Changelog", "", "## [1.0.0]", "", "- shipped already"].join("\n");

	it("is true when a package has an Unreleased bullet (a user-facing change is waiting)", () => {
		expect(hasReleasableChanges([withBullet])).toBe(true);
	});

	it("is true when any one of several packages has an Unreleased bullet", () => {
		expect(hasReleasableChanges([emptyUnreleased, noUnreleasedSection, withBullet])).toBe(true);
	});

	it("is false when every Unreleased section is empty (the state right after a release / bump commit → no loop)", () => {
		expect(hasReleasableChanges([emptyUnreleased, emptyUnreleased])).toBe(false);
	});

	it("is false when no package even has an Unreleased section (docs/chore-only main)", () => {
		expect(hasReleasableChanges([noUnreleasedSection])).toBe(false);
	});

	it("is false for an empty set of changelogs", () => {
		expect(hasReleasableChanges([])).toBe(false);
	});
});
