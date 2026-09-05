/**
 * The message an operator sees when a release cannot go forward, and why it has
 * to distinguish two cases that look identical to the tag check.
 *
 * Release order is publication order and the version string is a label, so
 * `release.ts` orders nothing and refuses one thing: a version that is already
 * a tag. Two very different situations land there. Asking for a number an
 * OLDER release used is a mistake and "pick one that is not tagged" is the
 * right answer. Asking for the LATEST tag is usually not a mistake: it is the
 * documented recovery from a publish that died after the tag was pushed, which
 * is why `prepareReleaseTree` is idempotent and why the commit step tags the
 * existing HEAD when the bump commit already landed.
 *
 * That recovery was unreachable in practice. The only message was "must be
 * greater than latest tag", which reads as "pick a higher version", and cutting a
 * fresh version is precisely what an operator recovering a failed publish must
 * not do: it burns a version number and leaves the dead tag behind. The recovery
 * commands lived only in a code comment further down the file.
 */
import { describe, expect, it } from "bun:test";
import { versionAlreadyTaggedFailure } from "./release";

describe("versionAlreadyTaggedFailure", () => {
	/**
	 * THE REGRESSION. Re-cutting the tagged version is the recovery path, so the
	 * message must name it and must carry the exact commands, because the operator
	 * is mid-incident and the tag deletion is the step that unblocks everything.
	 */
	it("names the recovery and both tag deletions when the version is the latest tag", () => {
		const lines = versionAlreadyTaggedFailure("1.0.50", "v1.0.50");

		expect(lines[0]).toBe("Error: v1.0.50 is already tagged.");
		expect(lines).toContain("    git push origin :refs/tags/v1.0.50");
		expect(lines).toContain("    git tag -d v1.0.50");
		expect(lines.join("\n")).toContain("re-cut this same version");
	});

	/**
	 * And it must NOT say that when re-cutting is the wrong move. Telling an
	 * operator to delete a tag whose release actually published is worse than the
	 * bug this fixes. The advice is to pick an untagged number, never a higher
	 * one: the number carries no order.
	 */
	it("tells an operator asking for an older release's number to pick an untagged one, with no delete advice", () => {
		const lines = versionAlreadyTaggedFailure("1.0.49", "v1.0.50");

		expect(lines).toEqual([
			"Error: v1.0.49 is already a tag. A version number is used once; pick one that has not been tagged.",
		]);
		expect(lines.join("\n")).not.toContain("git push origin :refs/tags");
		expect(lines.join("\n")).not.toContain("greater");
	});
});
