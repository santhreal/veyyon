import { describe, expect, it } from "bun:test";
import {
	bareVersion,
	compareDottedNumeric,
	compareSemver,
	isNewerVersion,
	isReleaseTag,
	isReleaseVersion,
	isValidSemver,
	tryCompareSemver,
} from "../src/semver";

describe("compareSemver", () => {
	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
	});
	it("returns positive for newer version", () => {
		expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
	});
	it("returns negative for older version", () => {
		expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
	});
	it("compares minor versions", () => {
		expect(compareSemver("1.1.0", "1.0.0")).toBeGreaterThan(0);
	});
	it("compares patch versions", () => {
		expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
	});
	it("prerelease is older than release", () => {
		expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
	});
});

describe("bareVersion", () => {
	it("strips leading v", () => {
		expect(bareVersion("v1.0.0")).toBe("1.0.0");
	});
	it("returns unchanged without v prefix", () => {
		expect(bareVersion("1.0.0")).toBe("1.0.0");
	});
	it("handles empty string", () => {
		expect(bareVersion("")).toBe("");
	});
	it("only strips first v", () => {
		expect(bareVersion("vv1.0.0")).toBe("v1.0.0");
	});
});

describe("isNewerVersion", () => {
	it("returns true when candidate is newer", () => {
		expect(isNewerVersion("2.0.0", "1.0.0")).toBe(true);
	});
	it("returns false when candidate is older", () => {
		expect(isNewerVersion("1.0.0", "2.0.0")).toBe(false);
	});
	it("returns false when equal", () => {
		expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
	});
});

describe("isValidSemver", () => {
	it("validates standard version", () => {
		expect(isValidSemver("1.0.0")).toBe(true);
	});
	it("validates version with prerelease", () => {
		expect(isValidSemver("1.0.0-alpha.1")).toBe(true);
	});
	it("validates version with build metadata", () => {
		expect(isValidSemver("1.0.0+build.123")).toBe(true);
	});
	it("validates version with prerelease and build", () => {
		expect(isValidSemver("1.0.0-alpha+build")).toBe(true);
	});
	it("rejects missing patch", () => {
		expect(isValidSemver("1.0")).toBe(false);
	});
	it("rejects leading zeros in major", () => {
		expect(isValidSemver("01.0.0")).toBe(false);
	});
	it("rejects non-numeric", () => {
		expect(isValidSemver("a.b.c")).toBe(false);
	});
	it("rejects empty string", () => {
		expect(isValidSemver("")).toBe(false);
	});
	it("validates zero version", () => {
		expect(isValidSemver("0.0.0")).toBe(true);
	});
	it("validates large version numbers", () => {
		expect(isValidSemver("10.20.30")).toBe(true);
	});
});

describe("isReleaseVersion", () => {
	it("accepts X.Y.Z without prerelease", () => {
		expect(isReleaseVersion("1.0.0")).toBe(true);
	});
	it("rejects prerelease version", () => {
		expect(isReleaseVersion("1.0.0-alpha")).toBe(false);
	});
	it("rejects build metadata", () => {
		expect(isReleaseVersion("1.0.0+build")).toBe(false);
	});
	it("rejects missing patch", () => {
		expect(isReleaseVersion("1.0")).toBe(false);
	});
	it("rejects leading zeros", () => {
		expect(isReleaseVersion("1.02.0")).toBe(false);
	});
});

describe("isReleaseTag", () => {
	it("accepts v-prefixed release version", () => {
		expect(isReleaseTag("v1.0.0")).toBe(true);
	});
	it("rejects without v prefix", () => {
		expect(isReleaseTag("1.0.0")).toBe(false);
	});
	it("rejects prerelease tag", () => {
		expect(isReleaseTag("v1.0.0-alpha")).toBe(false);
	});
	it("rejects non-version", () => {
		expect(isReleaseTag("vhello")).toBe(false);
	});
});

describe("tryCompareSemver", () => {
	it("returns comparison for valid versions", () => {
		expect(tryCompareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
	});
	it("returns undefined for invalid first arg", () => {
		expect(tryCompareSemver("not-a-version", "1.0.0")).toBeUndefined();
	});
	it("returns undefined for invalid second arg", () => {
		expect(tryCompareSemver("1.0.0", "not-a-version")).toBeUndefined();
	});
	it("returns 0 for equal versions", () => {
		expect(tryCompareSemver("1.0.0", "1.0.0")).toBe(0);
	});
});

describe("compareDottedNumeric", () => {
	it("compares standard versions", () => {
		expect(compareDottedNumeric("1.2.10", "1.2.9")).toBeGreaterThan(0);
	});
	it("missing component reads as zero", () => {
		expect(compareDottedNumeric("1.2", "1.2.0")).toBe(0);
	});
	it("extra components count", () => {
		expect(compareDottedNumeric("1.2.3.4", "1.2.3")).toBeGreaterThan(0);
	});
	it("suffixed component is text-compared", () => {
		expect(compareDottedNumeric("1.0rc1", "1.0")).not.toBe(0);
	});
	it("equal versions return 0", () => {
		expect(compareDottedNumeric("1.2.3", "1.2.3")).toBe(0);
	});
	it("compares single component", () => {
		expect(compareDottedNumeric("2", "1")).toBeGreaterThan(0);
	});
	it("compares empty strings as equal", () => {
		expect(compareDottedNumeric("", "")).toBe(0);
	});
	it("compares large numbers", () => {
		expect(compareDottedNumeric("100.0.0", "99.0.0")).toBeGreaterThan(0);
	});
	it("text comparison is deterministic for non-numeric", () => {
		const result = compareDottedNumeric("1.a", "1.b");
		expect(result).toBeLessThan(0);
	});
});
