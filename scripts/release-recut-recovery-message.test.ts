/**
 * The message an operator sees when a release cannot go forward, and why it has
 * to distinguish two cases that look identical to the version check.
 *
 * `release.ts` refuses a version that is not newer than the latest tag. Two very
 * different situations land there. Asking for an OLDER version is a mistake and
 * "pick a higher one" is the right answer. Asking for the version that is
 * ALREADY TAGGED is usually not a mistake: it is the documented recovery from a
 * publish that died after the tag was pushed, which is why `prepareReleaseTree`
 * is idempotent and why the commit step tags the existing HEAD when the bump
 * commit already landed.
 *
 * That recovery was unreachable in practice. The only message was "must be
 * greater than latest tag", which reads as "pick a higher version", and cutting a
 * fresh version is precisely what an operator recovering a failed publish must
 * not do: it burns a version number and leaves the dead tag behind. The recovery
 * commands lived only in a code comment further down the file.
 */
import { describe, expect, it } from "bun:test";
import { versionNotNewerFailure } from "./release";

describe("versionNotNewerFailure", () => {
	/**
	 * THE REGRESSION. Re-cutting the tagged version is the recovery path, so the
	 * message must name it and must carry the exact commands, because the operator
	 * is mid-incident and the tag deletion is the step that unblocks everything.
	 */
	it("names the recovery and both tag deletions when the version is already tagged", () => {
		const lines = versionNotNewerFailure("1.0.50", "v1.0.50");

		expect(lines[0]).toBe("Error: v1.0.50 is already tagged.");
		expect(lines).toContain("    git push origin :refs/tags/v1.0.50");
		expect(lines).toContain("    git tag -d v1.0.50");
		expect(lines.join("\n")).toContain("re-cut this same version");
	});

	/**
	 * And it must NOT say that when re-cutting is the wrong move. Telling an
	 * operator to delete a tag whose release actually published is worse than the
	 * bug this fixes.
	 */
	it("tells an operator asking for an older version to pick a higher one, with no delete advice", () => {
		const lines = versionNotNewerFailure("1.0.49", "v1.0.50");

		expect(lines).toEqual(["Error: Version 1.0.49 must be greater than latest tag v1.0.50"]);
		expect(lines.join("\n")).not.toContain("git push origin :refs/tags");
	});

	/** The first release has no tag, and the 0.0.0 baseline must not read as one. */
	it("does not offer to delete the synthetic baseline used before the first release", () => {
		const lines = versionNotNewerFailure("0.0.0", "0.0.0");

		expect(lines).toEqual(["Error: Version 0.0.0 must be greater than latest tag 0.0.0"]);
	});
});
