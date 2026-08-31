import { describe, expect, it } from "bun:test";
import {
	bareVersion,
	compareDottedNumeric,
	compareSemver,
	isNewerVersion,
	isReleaseTag,
	isReleaseVersion,
	isValidSemver,
} from "../src/semver";
import { kebabToCamel, titleCaseSentence, titleCaseWords } from "../src/string-case";

describe("compareSemver", () => {
	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
	});
	it("returns positive for newer candidate", () => {
		expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
	});
	it("returns negative for older candidate", () => {
		expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
	});
	it("compares minor versions correctly", () => {
		expect(compareSemver("1.1.0", "1.0.0")).toBeGreaterThan(0);
	});
	it("compares patch versions correctly", () => {
		expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
	});
	it("handles prerelease versions", () => {
		expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
	});
	it("handles build metadata", () => {
		expect(compareSemver("1.0.0+build", "1.0.0")).toBe(0);
	});
});

describe("bareVersion", () => {
	it("strips leading v", () => {
		expect(bareVersion("v1.0.0")).toBe("1.0.0");
	});
	it("returns as-is when no v prefix", () => {
		expect(bareVersion("1.0.0")).toBe("1.0.0");
	});
	it("handles empty string", () => {
		expect(bareVersion("")).toBe("");
	});
	it("does not strip v from middle", () => {
		expect(bareVersion("1.0.0-v")).toBe("1.0.0-v");
	});
});

describe("isNewerVersion", () => {
	it("returns true when candidate is newer", () => {
		expect(isNewerVersion("2.0.0", "1.0.0")).toBe(true);
	});
	it("returns false when candidate is older", () => {
		expect(isNewerVersion("1.0.0", "2.0.0")).toBe(false);
	});
	it("returns false for equal versions", () => {
		expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
	});
});

describe("isValidSemver", () => {
	it("validates standard version", () => {
		expect(isValidSemver("1.0.0")).toBe(true);
	});
	it("validates version with prerelease", () => {
		expect(isValidSemver("1.0.0-alpha")).toBe(true);
	});
	it("validates version with build metadata", () => {
		expect(isValidSemver("1.0.0+build")).toBe(true);
	});
	it("validates zero versions", () => {
		expect(isValidSemver("0.0.0")).toBe(true);
	});
	it("rejects missing patch", () => {
		expect(isValidSemver("1.0")).toBe(false);
	});
	it("rejects non-numeric", () => {
		expect(isValidSemver("abc")).toBe(false);
	});
	it("rejects leading zeros in major", () => {
		expect(isValidSemver("01.0.0")).toBe(false);
	});
	it("rejects empty string", () => {
		expect(isValidSemver("")).toBe(false);
	});
});

describe("isReleaseVersion", () => {
	it("accepts plain release version", () => {
		expect(isReleaseVersion("1.0.0")).toBe(true);
	});
	it("rejects prerelease version", () => {
		expect(isReleaseVersion("1.0.0-alpha")).toBe(false);
	});
	it("rejects version with build metadata", () => {
		expect(isReleaseVersion("1.0.0+build")).toBe(false);
	});
	it("rejects non-semver", () => {
		expect(isReleaseVersion("abc")).toBe(false);
	});
	it("accepts zero version", () => {
		expect(isReleaseVersion("0.0.0")).toBe(true);
	});
});

describe("isReleaseTag", () => {
	it("accepts v-prefixed release version", () => {
		expect(isReleaseTag("v1.0.0")).toBe(true);
	});
	it("rejects non-v-prefixed", () => {
		expect(isReleaseTag("1.0.0")).toBe(false);
	});
	it("rejects v-prefixed prerelease", () => {
		expect(isReleaseTag("v1.0.0-alpha")).toBe(false);
	});
	it("rejects empty string", () => {
		expect(isReleaseTag("")).toBe(false);
	});
	it("accepts v0.0.0", () => {
		expect(isReleaseTag("v0.0.0")).toBe(true);
	});
});

describe("compareDottedNumeric", () => {
	it("returns 0 for equal strings", () => {
		expect(compareDottedNumeric("1.0.0", "1.0.0")).toBe(0);
	});
	it("returns positive when left is greater", () => {
		expect(compareDottedNumeric("2.0.0", "1.0.0")).toBeGreaterThan(0);
	});
	it("returns negative when left is lesser", () => {
		expect(compareDottedNumeric("1.0.0", "2.0.0")).toBeLessThan(0);
	});
	it("handles different lengths with missing as 0", () => {
		expect(compareDottedNumeric("1.0", "1.0.0")).toBe(0);
	});
	it("handles different lengths with extra component", () => {
		expect(compareDottedNumeric("1.0.1", "1.0")).toBeGreaterThan(0);
	});
	it("handles non-numeric components lexicographically", () => {
		expect(compareDottedNumeric("1.0.alpha", "1.0.beta")).toBeLessThan(0);
	});
	it("handles mixed numeric and non-numeric", () => {
		const result = compareDottedNumeric("1.0.10", "1.0.9");
		expect(result).toBeGreaterThan(0);
	});
	it("handles single component", () => {
		expect(compareDottedNumeric("5", "3")).toBeGreaterThan(0);
	});
	it("handles empty strings", () => {
		expect(compareDottedNumeric("", "")).toBe(0);
	});
	it("handles empty vs non-empty", () => {
		expect(compareDottedNumeric("", "1")).toBeLessThan(0);
	});
});

describe("kebabToCamel", () => {
	it("converts simple kebab-case to camelCase", () => {
		expect(kebabToCamel("thinking-level")).toBe("thinkingLevel");
	});
	it("returns as-is when no hyphen", () => {
		expect(kebabToCamel("simple")).toBe("simple");
	});
	it("converts multiple hyphens", () => {
		expect(kebabToCamel("foo-bar-baz")).toBe("fooBarBaz");
	});
	it("does not lift numeric segment after hyphen", () => {
		expect(kebabToCamel("utf-8")).toBe("utf-8");
	});
	it("does not lift uppercase segment after hyphen", () => {
		expect(kebabToCamel("X-Header")).toBe("X-Header");
	});
	it("handles empty string", () => {
		expect(kebabToCamel("")).toBe("");
	});
	it("handles trailing hyphen", () => {
		expect(kebabToCamel("foo-")).toBe("foo-");
	});
	it("handles leading hyphen", () => {
		expect(kebabToCamel("-foo")).toBe("Foo");
	});
});

describe("titleCaseWords", () => {
	it("capitalizes each word", () => {
		expect(titleCaseWords("hello world")).toBe("Hello World");
	});
	it("handles single word", () => {
		expect(titleCaseWords("hello")).toBe("Hello");
	});
	it("handles empty string", () => {
		expect(titleCaseWords("")).toBe("");
	});
	it("handles multiple spaces", () => {
		expect(titleCaseWords("hello   world")).toBe("Hello World");
	});
	it("handles leading/trailing whitespace", () => {
		expect(titleCaseWords("  hello  ")).toBe("Hello");
	});
	it("preserves existing uppercase", () => {
		expect(titleCaseWords("HELLO")).toBe("HELLO");
	});
});

describe("titleCaseSentence", () => {
	it("capitalizes first letter", () => {
		expect(titleCaseSentence("hello world")).toBe("Hello world");
	});
	it("handles empty string", () => {
		expect(titleCaseSentence("")).toBe("");
	});
	it("handles whitespace-only string", () => {
		expect(titleCaseSentence("   ")).toBe("");
	});
	it("preserves existing capitalization", () => {
		expect(titleCaseSentence("Hello")).toBe("Hello");
	});
	it("trims leading whitespace before capitalizing", () => {
		expect(titleCaseSentence("  hello")).toBe("Hello");
	});
	it("does not change rest of sentence", () => {
		expect(titleCaseSentence("hello World")).toBe("Hello World");
	});
});
