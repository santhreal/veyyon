/**
 * WHY: the local prerelease step decides two things a release cannot recover
 * from once it is wrong — which paths become the bump commit, and which version
 * is cut. Both are pure functions here precisely so they can be pinned without
 * running a release.
 *
 * `statusPaths` replaced `git add -A`. A rename that stages only its new side
 * leaves the delete out of the bump commit, and a path containing a space that
 * is parsed from the C-quoted porcelain form mints a path that does not exist,
 * so `git add` fails mid-cut with the tree already rewritten.
 *
 * `resolveReleaseVersion` must keep the already-tagged case distinguishable
 * from the too-old case: re-cutting the tagged version is the documented
 * recovery from a publish that died after tagging, and telling that operator to
 * "pick a higher version" burns a version number and strands the dead tag.
 */
import { describe, expect, test } from "bun:test";
import { nextSteps, resolveReleaseVersion, statusPaths } from "./prerelease";

describe("statusPaths", () => {
	test("stages both sides of a rename so the delete is not left behind", () => {
		expect(statusPaths("R  packages/new.ts\0packages/old.ts\0 M Cargo.toml\0")).toEqual([
			"packages/new.ts",
			"packages/old.ts",
			"Cargo.toml",
		]);
	});

	test("keeps a path containing a space intact", () => {
		expect(statusPaths(" M docs/some file.md\0?? new dir/note.md\0")).toEqual(["docs/some file.md", "new dir/note.md"]);
	});

	test("reports nothing for an unchanged tree", () => {
		expect(statusPaths("")).toEqual([]);
	});
});

describe("resolveReleaseVersion", () => {
	test("bumps each component against the latest tag", () => {
		expect(resolveReleaseVersion("patch", "v1.2.3").version).toBe("1.2.4");
		expect(resolveReleaseVersion("minor", "v1.2.3").version).toBe("1.3.0");
		expect(resolveReleaseVersion("major", "v1.2.3").version).toBe("2.0.0");
	});

	test("accepts an explicit version ahead of the tag", () => {
		expect(resolveReleaseVersion("1.5.0", "v1.2.3").version).toBe("1.5.0");
	});

	test("refuses a version behind the tag and says to pick a higher one", () => {
		const { version, failure } = resolveReleaseVersion("1.0.0", "v1.2.3");
		expect(version).toBeUndefined();
		expect(failure?.join("\n")).toContain("must be greater than latest tag v1.2.3");
	});

	test("refuses the already-tagged version with the recovery, not with 'pick a higher one'", () => {
		const { version, failure } = resolveReleaseVersion("1.2.3", "v1.2.3");
		expect(version).toBeUndefined();
		const text = failure?.join("\n") ?? "";
		expect(text).toContain("git push origin :refs/tags/v1.2.3");
		expect(text).toContain("git tag -d v1.2.3");
		expect(text).not.toContain("must be greater than");
	});

	test("treats a repository with no tag as a 0.0.0 baseline", () => {
		expect(resolveReleaseVersion("major", "0.0.0").version).toBe("1.0.0");
		expect(resolveReleaseVersion("1.0.0", "0.0.0").version).toBe("1.0.0");
	});
});

describe("nextSteps", () => {
	test("pushes the bump to main before tagging, because the tag must land on a tested commit", () => {
		const steps = nextSteps("1.4.0");
		const pushIndex = steps.findIndex(line => line.includes("git push origin main"));
		const tagIndex = steps.findIndex(line => line.includes("git tag v1.4.0"));
		expect(pushIndex).toBeGreaterThanOrEqual(0);
		expect(tagIndex).toBeGreaterThan(pushIndex);
		expect(steps[tagIndex]).toContain("git push origin v1.4.0");
	});
	test("names the tag push as the step that publishes, not the main push", () => {
		const steps = nextSteps("1.4.0").join("\n");
		expect(steps).toContain("Step 3 is the release");
		expect(steps).toContain("publishes the GitHub release");
	});
});
