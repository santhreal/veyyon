import { describe, expect, it } from "bun:test";
import { isValidSemver } from "@veyyon/utils/semver";

/**
 * `isValidSemver` is the gate between an untrusted string and an installer.
 *
 * Its production caller reads a tag out of a release API response and, if this
 * returns true, hands the version to whichever package manager owns the install.
 * So a false positive here is not a formatting nit: it is a version string
 * reaching `npm install veyyon@<x>` or a release-artifact URL.
 *
 * It used to delegate to `Bun.semver.order`, which is lenient in exactly the
 * wrong direction. Each case below that Bun accepted is listed with what it
 * would have done downstream, because the reason to reject them is concrete
 * rather than pedantic:
 *
 *  - `"1.2"` and `"1"` are npm RANGES. Pinning to one installs whatever version
 *    in that range happens to be newest, which is not the release that was
 *    verified, and defeats the point of pinning at all.
 *  - `"v1.2.3"` and `" 1.2.3 "` build a download URL that does not exist, so the
 *    failure surfaces as a confusing 404 far from its cause.
 *  - `"01.2.3"` is a distinct string from `"1.2.3"`, so it compares and caches
 *    as a different version while naming the same release.
 */
describe("isValidSemver", () => {
	describe("accepts complete versions", () => {
		it("accepts a plain three-part version", () => {
			expect(isValidSemver("1.2.3")).toBe(true);
			expect(isValidSemver("0.0.0")).toBe(true);
			expect(isValidSemver("10.20.30")).toBe(true);
		});

		it("accepts prereleases, which real releases use", () => {
			// Rejecting these would block the beta channel entirely.
			expect(isValidSemver("1.2.3-rc.1")).toBe(true);
			expect(isValidSemver("1.2.3-beta")).toBe(true);
			expect(isValidSemver("1.0.0-alpha.0.1")).toBe(true);
			expect(isValidSemver("1.0.0-0.3.7")).toBe(true);
		});

		it("accepts build metadata", () => {
			expect(isValidSemver("1.2.3+build.5")).toBe(true);
			expect(isValidSemver("1.2.3-rc.1+exp.sha.5114f85")).toBe(true);
		});

		it("accepts large components without overflowing into a rejection", () => {
			expect(isValidSemver("999999.999999.999999")).toBe(true);
		});
	});

	describe("rejects the partial versions that are really ranges", () => {
		it("rejects a two-part version, which npm resolves as a range", () => {
			// The specific hazard: `veyyon@1.2` installs the newest 1.2.x, not the
			// release the updater verified and intended to pin.
			expect(isValidSemver("1.2")).toBe(false);
		});

		it("rejects a single component", () => {
			expect(isValidSemver("1")).toBe(false);
		});

		it("rejects a four-part version", () => {
			expect(isValidSemver("1.2.3.4")).toBe(false);
		});

		it("rejects an explicit range or wildcard", () => {
			// These are the strings a caller most needs distinguished from a version,
			// since they read as versions to a human skimming a config file.
			expect(isValidSemver("^1.2.3")).toBe(false);
			expect(isValidSemver("~1.2.3")).toBe(false);
			expect(isValidSemver("1.2.x")).toBe(false);
			expect(isValidSemver("*")).toBe(false);
			expect(isValidSemver(">=1.2.3")).toBe(false);
		});
	});

	describe("rejects versions that are merely dressed up", () => {
		it("rejects a leading v, which belongs to the TAG and not the version", () => {
			// Tags carry the `v`; versions do not. Passing the tag through would build a
			// `vv1.2.3` artifact path.
			expect(isValidSemver("v1.2.3")).toBe(false);
		});

		it("rejects surrounding whitespace rather than silently trimming it", () => {
			// Trimming here would hide a parsing bug upstream and put an invisible
			// character into a URL. The caller should see the value it actually has.
			expect(isValidSemver(" 1.2.3")).toBe(false);
			expect(isValidSemver("1.2.3 ")).toBe(false);
			expect(isValidSemver("1.2.3\n")).toBe(false);
		});

		it("rejects leading zeroes, which name the same release under a different string", () => {
			expect(isValidSemver("01.2.3")).toBe(false);
			expect(isValidSemver("1.02.3")).toBe(false);
			expect(isValidSemver("1.2.03")).toBe(false);
		});

		it("rejects an empty prerelease or build section", () => {
			expect(isValidSemver("1.2.3-")).toBe(false);
			expect(isValidSemver("1.2.3+")).toBe(false);
			expect(isValidSemver("1.2.3-rc..1")).toBe(false);
		});

		it("rejects a numeric prerelease identifier with a leading zero", () => {
			// Specified precedence rules compare numeric identifiers numerically, and a
			// leading zero makes two spellings of one identifier.
			expect(isValidSemver("1.2.3-01")).toBe(false);
			expect(isValidSemver("1.2.3-rc.01")).toBe(false);
		});
	});

	describe("rejects non-versions outright", () => {
		it("rejects moving pointers", () => {
			// The original documented example, kept: these are the strings that appear in
			// a release feed when something is misconfigured.
			expect(isValidSemver("latest")).toBe(false);
			expect(isValidSemver("nightly")).toBe(false);
			expect(isValidSemver("main")).toBe(false);
		});

		it("rejects the empty string and pure punctuation", () => {
			expect(isValidSemver("")).toBe(false);
			expect(isValidSemver("...")).toBe(false);
			expect(isValidSemver("..")).toBe(false);
		});

		it("rejects a multi-line string whose first line looks like a version", () => {
			// An unanchored pattern would accept this, and the extra line would end up in
			// whatever command or URL the version is interpolated into.
			expect(isValidSemver("1.2.3\nrm -rf /")).toBe(false);
		});
	});
});
