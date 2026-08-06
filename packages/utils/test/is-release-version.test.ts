/**
 * The release-strict version and tag predicates.
 *
 * These replace four hand-written regexes that had already drifted apart, and
 * every case below is one of those disagreements rather than a general tour of
 * semver:
 *
 * - `scripts/release.ts:47`, the CLI's front door, used `/^\d+\.\d+\.\d+$/` and
 *   accepted `01.2.3`. A later gate in the same file, `:279`, used the strict
 *   pattern and rejected it as "not strict semver". A version could therefore
 *   get past the front door and die partway through the release.
 * - `scripts/release-policy.ts:66` threw `"is not strict vX.Y.Z semver"` while
 *   testing `/^v\d+\.\d+\.\d+$/`, which accepts `v01.2.3`. The message named a
 *   rule the code did not implement.
 * - None of them excluded a prerelease or build suffix, and a release cuts a git
 *   tag, publishes npm packages and creates a GitHub release under that exact
 *   string.
 *
 * `isValidSemver` cannot serve here: it accepts `1.2.3-rc.1` and `1.2.3+build`
 * by design, because it answers a different question.
 */
import { describe, expect, it } from "bun:test";
import { isReleaseTag, isReleaseVersion, isValidSemver } from "../src/semver";

describe("isReleaseVersion", () => {
	it("accepts a plain three-part version, including zeros", () => {
		expect(["1.2.3", "0.0.0", "10.20.30", "0.1.0"].filter(v => !isReleaseVersion(v))).toEqual([]);
	});

	/** The front-door / later-gate disagreement. `01.2.3` is not `1.2.3`. */
	it("rejects a leading zero, which the CLI's front door used to accept", () => {
		expect(["01.2.3", "1.02.3", "1.2.03"].filter(isReleaseVersion)).toEqual([]);
	});

	/**
	 * The axis no regex on the release path covered. A prerelease is a real
	 * semver version, so `isValidSemver` says yes, but the release machinery has
	 * no prerelease path and would publish artifacts that do not match the tag.
	 * Asserting both predicates here is what pins them as DIFFERENT questions
	 * rather than one of them being a stale copy of the other.
	 */
	it("rejects a prerelease or build suffix that isValidSemver accepts", () => {
		for (const value of ["1.2.3-rc.1", "1.2.3+build.5", "1.2.3-0"]) {
			expect(isValidSemver(value)).toBe(true);
			expect(isReleaseVersion(value)).toBe(false);
		}
	});

	it("rejects partial versions, ranges and anything that is not a version", () => {
		expect(["1.2", "1", "", "latest", "v1.2.3", "1.2.3.4", " 1.2.3", "1.2.3 ", "x.y.z"].filter(isReleaseVersion)).toEqual([]);
	});
});

describe("isReleaseTag", () => {
	it("accepts a v-prefixed release version", () => {
		expect(["v1.2.3", "v0.0.0", "v10.20.30"].filter(t => !isReleaseTag(t))).toEqual([]);
	});

	/** The message at release-policy.ts:66 promised this and the regex did not. */
	it("rejects a leading zero, which the tag gate accepted while calling itself strict", () => {
		expect(isReleaseTag("v01.2.3")).toBe(false);
	});

	it("requires the v, so a bare version is not a tag", () => {
		expect(isReleaseTag("1.2.3")).toBe(false);
	});

	it("rejects a prerelease tag and a doubled prefix", () => {
		expect(["v1.2.3-rc.1", "vv1.2.3", "V1.2.3", "v", ""].filter(isReleaseTag)).toEqual([]);
	});

	/** The tag and the version it names must be judged by one rule, or a tag can
	 * exist that nothing else resolves. */
	it("agrees with isReleaseVersion on the part after the v", () => {
		for (const value of ["1.2.3", "01.2.3", "1.2.3-rc.1", "1.2", "latest", "0.0.0"]) {
			expect(isReleaseTag(`v${value}`)).toBe(isReleaseVersion(value));
		}
	});
});
