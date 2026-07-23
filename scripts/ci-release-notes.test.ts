import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareVersions, enumerateChangelogVersions, mergePackageSection } from "./ci-release-notes";

const FIXTURE = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Added",
	"",
	"- Unreleased entry not in any tag yet.",
	"",
	"## [15.13.0] - 2026-06-14",
	"",
	"### Fixed",
	"",
	"- Fixed unknown `--`-prefixed flags being silently consumed as prompt text.",
	"- Fixed something only in 15.13.0.",
	"",
	"### Removed",
	"",
	"- Removed a deprecated thing in 15.13.0.",
	"",
	"## [15.12.6] - 2026-06-14",
	"",
	"### Breaking Changes",
	"",
	"- Removed `writeLine`/`writeLineSync` from the public SessionStorageWriter contract.",
	"",
	"### Added",
	"",
	"- Added package-level exports for session context.",
	"",
	"## [15.12.5] - 2026-06-13",
	"",
	"### Changed",
	"",
	"- Changed terminal resize handling to paint only the visible viewport.",
	"",
	"### Fixed",
	"",
	"- Fixed unknown `--`-prefixed flags being silently consumed as prompt text.",
	"",
	"## [15.12.4] - 2026-06-13",
	"",
	"### Added",
	"",
	"- Predates the silent-tag window; must not appear when floor=15.12.4.",
	"",
].join("\n");

describe("compareVersions", () => {
	it("orders semver tags numerically across all components", () => {
		expect(compareVersions("15.12.5", "15.13.0") < 0).toBe(true);
		expect(compareVersions("v15.13.0", "15.12.6") > 0).toBe(true);
		expect(compareVersions("15.12.6", "15.12.6") === 0).toBe(true);
		// Numeric (not lexicographic) — 15.2.0 < 15.13.0.
		expect(compareVersions("15.2.0", "15.13.0") < 0).toBe(true);
	});

	it("orders a prerelease against released versions instead of calling everything equal", () => {
		// REGRESSION: this comparator used to match `X.Y.Z` only and return 0 for
		// anything else, meaning "same version". A prerelease target compared equal
		// to every released version, so mergePackageSection selected the whole
		// changelog and the release notes for an rc contained the entire history.
		expect(compareVersions("1.2.1-rc.1", "1.2.0") > 0).toBe(true);
		expect(compareVersions("1.2.1-rc.1", "1.2.1") < 0).toBe(true);
		expect(compareVersions("1.0.0", "1.2.1-rc.1") < 0).toBe(true);
		expect(compareVersions("1.2.1-rc.1", "1.2.1-rc.1") === 0).toBe(true);
	});
});

describe("mergePackageSection with a prerelease target", () => {
	it("selects no released section for a prerelease that has none of its own", () => {
		// The concrete failure the comparator bug produced: every released section
		// compared equal to the rc target and was merged into its notes.
		const changelog = ["## [1.2.0]", "### Added", "- older feature", "", "## [1.1.0]", "### Added", "- oldest"].join(
			"\n",
		);

		expect(mergePackageSection(changelog, null, "1.2.1-rc.1")).toBe("");
	});

	it("still selects the range below a prerelease when a floor is given", () => {
		const changelog = ["## [1.2.0]", "### Added", "- newer", "", "## [1.1.0]", "### Added", "- older"].join("\n");

		const merged = mergePackageSection(changelog, "1.1.0", "1.2.1-rc.1");

		expect(merged).toContain("- newer");
		expect(merged).not.toContain("- older");
	});
});

describe("enumerateChangelogVersions", () => {
	it("returns every semver heading in document order, skipping Unreleased", () => {
		const spans = enumerateChangelogVersions(FIXTURE);
		expect(spans.map(s => s.version)).toEqual(["15.13.0", "15.12.6", "15.12.5", "15.12.4"]);
	});

	it("bounds each span by the next `## [` heading (Unreleased included as boundary)", () => {
		const spans = enumerateChangelogVersions(FIXTURE);
		const lines = FIXTURE.split("\n");
		for (const span of spans) {
			expect(lines[span.start]).toMatch(/^## \[\d+\.\d+\.\d+\]/);
			// Body never bleeds into the next heading.
			for (let i = span.start + 1; i < span.end; i++) {
				expect(lines[i].startsWith("## [")).toBe(false);
			}
		}
	});
});

describe("mergePackageSection", () => {
	it("includes every silent-tag section above floor up to target inclusive", () => {
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		// 15.12.6 and 15.12.5 unique fingerprints must land.
		expect(merged).toContain("Removed `writeLine`/`writeLineSync` from the public SessionStorageWriter contract.");
		expect(merged).toContain("Added package-level exports for session context.");
		expect(merged).toContain("Changed terminal resize handling to paint only the visible viewport.");
		// 15.12.4 entry stays excluded — it is the floor.
		expect(merged).not.toContain("Predates the silent-tag window");
		// Unreleased never leaks.
		expect(merged).not.toContain("Unreleased entry");
	});

	it("dedupes bullets flattened forward into multiple versions", () => {
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		const dupRegex = /Fixed unknown `--`-prefixed flags being silently consumed as prompt text\./g;
		expect(merged.match(dupRegex)?.length).toBe(1);
	});

	it("groups bullets under the canonical category order regardless of source-version order", () => {
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		// Expected canonical order: Breaking Changes → Added → Changed → Fixed → Removed.
		const headings = [...merged.matchAll(/^### (.+)$/gm)].map(m => m[1]);
		expect(headings).toEqual(["Breaking Changes", "Added", "Changed", "Fixed", "Removed"]);
	});

	it("floor=null reproduces single-version (legacy) extraction for the target", () => {
		const merged = mergePackageSection(FIXTURE, null, "15.13.0");
		expect(merged).toContain("Fixed something only in 15.13.0");
		expect(merged).toContain("Removed a deprecated thing in 15.13.0");
		// Anything below the target stays out when no floor is set.
		expect(merged).not.toContain("writeLine");
		expect(merged).not.toContain("Added package-level exports");
	});

	it("returns empty string when no version in the requested range carries body content", () => {
		const empty = ["# Changelog", "", "## [15.13.0] - 2026-06-14", "", "## [15.12.6] - 2026-06-14"].join("\n");
		expect(mergePackageSection(empty, "15.12.5", "15.13.0")).toBe("");
	});

	it("never emits a category with only blank/whitespace bullets after dedup", () => {
		// If 15.13.0 already pulled the only Fixed bullet, an older section
		// contributing the identical bullet must not produce an empty
		// `### Fixed` heading by itself.
		const merged = mergePackageSection(FIXTURE, "15.12.4", "15.13.0");
		expect(merged).not.toMatch(/### Fixed\s*\n\s*(### |$)/);
	});
});

describe("ci-release-notes.ts must run without a workspace install", () => {
	it("imports no @veyyon/* workspace package (release_github does not `bun install`)", () => {
		// The release_github job ("Publish GitHub release") checks out the repo and
		// sets up bun but does NOT run `bun install`, so the workspace symlinks
		// node_modules/@veyyon/* do not exist. A bare workspace import in this
		// script crashes the job with "Cannot find module '@veyyon/...'" and blocks
		// the publish — it did on the FIRST release_github run to complete (v1.0.20:
		// `import { compareSemver } from "@veyyon/utils/semver"`), so nothing shipped.
		// Cross-package helpers must be imported by relative path (semver.ts is
		// self-contained, so a direct file import resolves with no install).
		const src = fs.readFileSync(path.join(import.meta.dir, "ci-release-notes.ts"), "utf8");
		const workspaceImports = [...src.matchAll(/\bfrom\s+["'](@veyyon\/[^"']+)["']/g)].map(m => m[1]);
		expect(workspaceImports).toEqual([]);
	});
});
