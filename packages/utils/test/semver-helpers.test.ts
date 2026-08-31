import { describe, expect, it } from "bun:test";
import {
	bareVersion,
	compareDottedNumeric,
	compareSemver,
	isNewerVersion,
	isReleaseTag,
	isReleaseVersion,
	isValidSemver,
	RELEASE_VERSION_BODY,
} from "../src/semver";

describe("bareVersion", () => {
	it("strips leading v", () => {
		expect(bareVersion("v1.2.3")).toBe("1.2.3");
	});

	it("returns unchanged when no v prefix", () => {
		expect(bareVersion("1.2.3")).toBe("1.2.3");
	});

	it("handles empty string", () => {
		expect(bareVersion("")).toBe("");
	});

	it("handles just v", () => {
		expect(bareVersion("v")).toBe("");
	});

	it("does not strip v from middle", () => {
		expect(bareVersion("1v.2.3")).toBe("1v.2.3");
	});
});

describe("compareSemver", () => {
	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	it("returns positive for newer version", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
	});

	it("returns negative for older version", () => {
		expect(compareSemver("1.2.2", "1.2.3")).toBeLessThan(0);
	});

	it("compares major versions", () => {
		expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
	});

	it("compares minor versions", () => {
		expect(compareSemver("1.1.0", "1.0.0")).toBeGreaterThan(0);
	});

	it("handles pre-release versions", () => {
		expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
	});
});

describe("isNewerVersion", () => {
	it("returns true when candidate is newer", () => {
		expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
	});

	it("returns false when candidate is older", () => {
		expect(isNewerVersion("1.2.2", "1.2.3")).toBe(false);
	});

	it("returns false when versions are equal", () => {
		expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
	});

	it("returns true for major version bump", () => {
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
	});
});

describe("isValidSemver", () => {
	it("returns true for valid semver", () => {
		expect(isValidSemver("1.2.3")).toBe(true);
		expect(isValidSemver("0.0.0")).toBe(true);
		expect(isValidSemver("10.20.30")).toBe(true);
	});

	it("returns true for pre-release versions", () => {
		expect(isValidSemver("1.0.0-alpha")).toBe(true);
		expect(isValidSemver("1.0.0-alpha.1")).toBe(true);
		expect(isValidSemver("1.0.0-beta.2")).toBe(true);
	});

	it("returns true for build metadata", () => {
		expect(isValidSemver("1.0.0+build.1")).toBe(true);
	});

	it("returns false for missing patch", () => {
		expect(isValidSemver("1.2")).toBe(false);
	});

	it("returns false for missing minor and patch", () => {
		expect(isValidSemver("1")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isValidSemver("")).toBe(false);
	});

	it("returns false for leading zeros", () => {
		expect(isValidSemver("01.2.3")).toBe(false);
	});

	it("returns false for v prefix", () => {
		expect(isValidSemver("v1.2.3")).toBe(false);
	});
});

describe("isReleaseVersion", () => {
	it("returns true for x.y.z", () => {
		expect(isReleaseVersion("1.2.3")).toBe(true);
		expect(isReleaseVersion("0.0.0")).toBe(true);
	});

	it("returns false for pre-release", () => {
		expect(isReleaseVersion("1.0.0-alpha")).toBe(false);
	});

	it("returns false for build metadata", () => {
		expect(isReleaseVersion("1.0.0+build")).toBe(false);
	});

	it("returns false for incomplete version", () => {
		expect(isReleaseVersion("1.2")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isReleaseVersion("")).toBe(false);
	});
});

describe("isReleaseTag", () => {
	it("returns true for vX.Y.Z", () => {
		expect(isReleaseTag("v1.2.3")).toBe(true);
		expect(isReleaseTag("v0.0.0")).toBe(true);
	});

	it("returns false for version without v prefix", () => {
		expect(isReleaseTag("1.2.3")).toBe(false);
	});

	it("returns false for pre-release tag", () => {
		expect(isReleaseTag("v1.0.0-alpha")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isReleaseTag("")).toBe(false);
	});

	it("returns false for just v", () => {
		expect(isReleaseTag("v")).toBe(false);
	});
});

describe("compareDottedNumeric", () => {
	it("returns 0 for equal versions", () => {
		expect(compareDottedNumeric("1.2.3", "1.2.3")).toBe(0);
	});

	it("returns positive for newer version", () => {
		expect(compareDottedNumeric("1.2.4", "1.2.3")).toBeGreaterThan(0);
	});

	it("returns negative for older version", () => {
		expect(compareDottedNumeric("1.2.2", "1.2.3")).toBeLessThan(0);
	});

	it("handles different lengths (missing = 0)", () => {
		expect(compareDottedNumeric("1.2", "1.2.0")).toBe(0);
		expect(compareDottedNumeric("1.2.1", "1.2")).toBeGreaterThan(0);
	});

	it("compares first differing component", () => {
		expect(compareDottedNumeric("1.10.0", "1.9.0")).toBeGreaterThan(0);
	});

	it("handles non-numeric components lexicographically", () => {
		expect(compareDottedNumeric("1.a.0", "1.b.0")).toBeLessThan(0);
	});

	it("handles single component", () => {
		expect(compareDottedNumeric("2", "1")).toBeGreaterThan(0);
		expect(compareDottedNumeric("1", "2")).toBeLessThan(0);
		expect(compareDottedNumeric("1", "1")).toBe(0);
	});

	it("handles empty string as less than 0", () => {
		// "".split(".") = [""], which is lexicographically less than "0"
		expect(compareDottedNumeric("", "0")).toBeLessThan(0);
	});

	it("handles large version numbers", () => {
		expect(compareDottedNumeric("100.200.300", "99.199.299")).toBeGreaterThan(0);
	});
});

describe("RELEASE_VERSION_BODY", () => {
	it("is a string containing the semver pattern", () => {
		expect(typeof RELEASE_VERSION_BODY).toBe("string");
		expect(RELEASE_VERSION_BODY).toContain("0|[1-9]");
	});
});
