/**
 * A version heading has one definition, and the release path agrees with itself
 * about what one is.
 *
 * Four private spellings of `## [X.Y.Z]` had grown up on the release path, and
 * two of them disagreed on the thing that matters. `hasVersionHeading` (the gate
 * deciding whether a version is documented) accepts a heading with no date;
 * `removeEmptyVersionEntries` (the cleanup deleting hollow sections) required
 * one. So an undated empty section survived the cleanup AND satisfied the gate,
 * and the release shipped a heading with nothing under it. That is the same
 * failure the empty-`[Unreleased]` gate exists to prevent, arriving by the other
 * door.
 *
 * Two of the four spellings also used `\d+\.\d+\.\d+`, which accepts `01.2.3`.
 * A version heading no tag can ever match is not a version heading.
 */

import { describe, expect, it } from "bun:test";
import { RELEASE_VERSION_BODY } from "@veyyon/utils/semver";
import { hasVersionHeading, versionHeadings } from "./changelog-unreleased.ts";
import { applyReleaseToChangelog } from "./release.ts";

describe("versionHeadings", () => {
	it("returns every version heading in document order with its 1-based line", () => {
		const md = ["# Changelog", "", "## [Unreleased]", "", "## [1.2.0] - 2026-01-02", "", "## [1.1.0]", ""].join("\n");

		expect(versionHeadings(md)).toEqual([
			{ version: "1.2.0", line: 5 },
			{ version: "1.1.0", line: 7 },
		]);
	});

	it("does not treat Unreleased or a prose heading as a version", () => {
		const md = ["## [Unreleased]", "## Upstream history", "## [not-a-version]", ""].join("\n");

		expect(versionHeadings(md)).toEqual([]);
	});

	/**
	 * The grammar is shared with `isReleaseVersion`, so a string the release gate
	 * would refuse to cut cannot become a version section by being written as one.
	 */
	it("rejects a leading zero, which the private spellings accepted", () => {
		expect(versionHeadings("## [01.2.3] - 2026-01-01\n")).toEqual([]);
		expect(versionHeadings("## [1.2.3] - 2026-01-01\n")).toEqual([{ version: "1.2.3", line: 1 }]);
	});

	it("does not match a heading that only starts with a version", () => {
		expect(versionHeadings("## [1.2.3.4]\n")).toEqual([]);
	});

	it("builds its pattern from the shared release grammar rather than a private copy", () => {
		// The body carries three groups (major, minor, patch); the heading wraps it in a fourth.
		expect(new RegExp(`^${RELEASE_VERSION_BODY}$`).test("1.2.3")).toBe(true);
		expect(new RegExp(`^${RELEASE_VERSION_BODY}$`).test("01.2.3")).toBe(false);
	});
});

describe("hasVersionHeading", () => {
	it("finds a version whether or not the heading carries a date", () => {
		expect(hasVersionHeading("## [1.2.3] - 2026-01-01\n", "1.2.3")).toBe(true);
		expect(hasVersionHeading("## [1.2.3]\n", "1.2.3")).toBe(true);
	});

	it("does not match a different version that shares a prefix", () => {
		expect(hasVersionHeading("## [1.2.30] - 2026-01-01\n", "1.2.3")).toBe(false);
	});
});

describe("the gate and the cleanup agree on what a version section is", () => {
	/**
	 * The divergence, driven through the real roll. An undated empty section is
	 * what `hasVersionHeading` accepts, so the cleanup has to be able to remove
	 * it; while the date was mandatory it could not, and the pair contradicted
	 * each other on exactly the input that reaches the release.
	 */
	it("removes an empty version section that carries no date", () => {
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [1.0.0]",
			"",
			"## [0.9.0] - 2026-01-01",
			"",
			"### Fixed",
			"",
			"- real",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.1.0", "2026-02-02");

		expect(hasVersionHeading(after, "1.0.0")).toBe(false);
		expect(versionHeadings(after).map(heading => heading.version)).toEqual(["0.9.0"]);
	});

	it("still removes an empty dated section, and keeps one that has content", () => {
		const before = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"## [0.9.0] - 2025-12-01",
			"",
			"### Fixed",
			"",
			"- real",
			"",
		].join("\n");

		const after = applyReleaseToChangelog(before, "1.1.0", "2026-02-02");

		expect(versionHeadings(after).map(heading => heading.version)).toEqual(["0.9.0"]);
		expect(after).toContain("- real");
	});
});
