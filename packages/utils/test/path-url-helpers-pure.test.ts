import { describe, expect, it } from "bun:test";
import { expandTilde, looksLikeFilePath, stripWindowsExtendedLengthPathPrefix } from "../src/path";
import {
	containsUrlScheme,
	hasUriScheme,
	hasUrlScheme,
	normalizeBaseUrl,
	trimTrailingSlashes,
	URI_SCHEME_PREFIX_RE,
	URL_SCHEME_PREFIX_RE,
	urlScheme,
} from "../src/url";

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("returns unchanged on non-win32 platform", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\foo", "linux")).toBe("\\\\?\\C:\\foo");
	});
	it("strips drive extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\foo\\bar", "win32")).toBe("C:\\foo\\bar");
	});
	it("strips UNC extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\?\\UNC\\server\\share\\foo", "win32")).toBe(
			"\\\\server\\share\\foo",
		);
	});
	it("strips forward-slash drive extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("//?/C:/foo/bar", "win32")).toBe("C:/foo/bar");
	});
	it("strips forward-slash UNC extended prefix on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("//?/UNC/server/share/foo", "win32")).toBe("//server/share/foo");
	});
	it("returns unchanged when no prefix matches", () => {
		expect(stripWindowsExtendedLengthPathPrefix("C:\\foo\\bar", "win32")).toBe("C:\\foo\\bar");
	});
	it("handles NT-style double-question prefix", () => {
		expect(stripWindowsExtendedLengthPathPrefix("\\\\??\\C:\\foo", "win32")).toBe("C:\\foo");
	});
});

describe("looksLikeFilePath", () => {
	it("returns true for paths with forward slash", () => {
		expect(looksLikeFilePath("foo/bar")).toBe(true);
	});
	it("returns true for paths with backslash", () => {
		expect(looksLikeFilePath("foo\\bar")).toBe(true);
	});
	it("returns false for plain text without separator", () => {
		expect(looksLikeFilePath("hello")).toBe(false);
	});
	it("returns false when no extensions and no separator", () => {
		expect(looksLikeFilePath("hello.txt", [])).toBe(false);
	});
	it("returns true when extension matches", () => {
		expect(looksLikeFilePath("hello.md", ["md"])).toBe(true);
	});
	it("returns true when extension matches case-insensitively", () => {
		expect(looksLikeFilePath("hello.MD", ["md"])).toBe(true);
	});
	it("returns false when extension does not match", () => {
		expect(looksLikeFilePath("hello.txt", [".md"])).toBe(false);
	});
	it("returns false for no extension and no separator", () => {
		expect(looksLikeFilePath("hello", [".md", ".txt"])).toBe(false);
	});
	it("returns true for absolute path", () => {
		expect(looksLikeFilePath("/home/user/file")).toBe(true);
	});
	it("returns true for relative path with dot", () => {
		expect(looksLikeFilePath("./file.md")).toBe(true);
	});
});

describe("expandTilde", () => {
	it("expands bare tilde to home", () => {
		expect(expandTilde("~", "/home/user")).toBe("/home/user");
	});
	it("expands tilde-slash path", () => {
		expect(expandTilde("~/foo", "/home/user")).toBe("/home/user/foo");
	});
	it("expands tilde-backslash path", () => {
		expect(expandTilde("~\\foo", "C:\\Users\\user")).toBe("C:\\Users\\user\\foo");
	});
	it("expands ~name form", () => {
		const result = expandTilde("~user", "/home");
		expect(result).toContain("user");
	});
	it("returns unchanged when no tilde", () => {
		expect(expandTilde("/foo/bar", "/home/user")).toBe("/foo/bar");
	});
	it("returns unchanged for relative path", () => {
		expect(expandTilde("foo/bar", "/home/user")).toBe("foo/bar");
	});
});

describe("trimTrailingSlashes", () => {
	it("strips single trailing slash", () => {
		expect(trimTrailingSlashes("http://x/")).toBe("http://x");
	});
	it("strips multiple trailing slashes", () => {
		expect(trimTrailingSlashes("http://x//")).toBe("http://x");
	});
	it("returns unchanged when no trailing slash", () => {
		expect(trimTrailingSlashes("http://x")).toBe("http://x");
	});
	it("handles empty string", () => {
		expect(trimTrailingSlashes("")).toBe("");
	});
	it("preserves interior slashes", () => {
		expect(trimTrailingSlashes("http://x/api/")).toBe("http://x/api");
	});
});

describe("normalizeBaseUrl", () => {
	it("trims trailing slashes", () => {
		expect(normalizeBaseUrl("http://x/", "fallback")).toBe("http://x");
	});
	it("trims whitespace and slashes", () => {
		expect(normalizeBaseUrl("  http://x/  ", "fallback")).toBe("http://x");
	});
	it("returns fallback for undefined", () => {
		expect(normalizeBaseUrl(undefined, "fallback")).toBe("fallback");
	});
	it("returns fallback for empty string", () => {
		expect(normalizeBaseUrl("", "fallback")).toBe("fallback");
	});
	it("returns undefined when no fallback and input is empty", () => {
		expect(normalizeBaseUrl(undefined)).toBeUndefined();
	});
	it("returns undefined when no fallback and input is blank", () => {
		expect(normalizeBaseUrl("  ")).toBeUndefined();
	});
	it("handles interleaved trailing slashes and spaces", () => {
		expect(normalizeBaseUrl("http://x / ", "fallback")).toBe("http://x");
	});
});

describe("hasUrlScheme", () => {
	it("returns true for https://", () => {
		expect(hasUrlScheme("https://example.com")).toBe(true);
	});
	it("returns true for http://", () => {
		expect(hasUrlScheme("http://example.com")).toBe(true);
	});
	it("returns true for custom scheme", () => {
		expect(hasUrlScheme("skill://demo")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(hasUrlScheme("hello world")).toBe(false);
	});
	it("returns false for path", () => {
		expect(hasUrlScheme("/foo/bar")).toBe(false);
	});
	it("returns false for scheme without //", () => {
		expect(hasUrlScheme("mailto:foo@bar.com")).toBe(false);
	});
});

describe("hasUriScheme", () => {
	it("returns true for scheme://", () => {
		expect(hasUriScheme("https://example.com")).toBe(true);
	});
	it("returns true for scheme: without //", () => {
		expect(hasUriScheme("mailto:foo@bar.com")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(hasUriScheme("hello world")).toBe(false);
	});
	it("returns false for path", () => {
		expect(hasUriScheme("/foo/bar")).toBe(false);
	});
});

describe("urlScheme", () => {
	it("returns lowercase scheme", () => {
		expect(urlScheme("HTTPS://example.com")).toBe("https");
	});
	it("returns null for no scheme", () => {
		expect(urlScheme("hello world")).toBeNull();
	});
	it("returns null for path", () => {
		expect(urlScheme("/foo/bar")).toBeNull();
	});
	it("returns custom scheme", () => {
		expect(urlScheme("skill://demo")).toBe("skill");
	});
});

describe("containsUrlScheme", () => {
	it("returns true when scheme is at start", () => {
		expect(containsUrlScheme("https://example.com")).toBe(true);
	});
	it("returns true when scheme is embedded", () => {
		expect(containsUrlScheme("see https://example.com for more")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(containsUrlScheme("hello world")).toBe(false);
	});
	it("returns false for path", () => {
		expect(containsUrlScheme("/foo/bar")).toBe(false);
	});
});

describe("URL_SCHEME_PREFIX_RE", () => {
	it("is non-global", () => {
		expect(URL_SCHEME_PREFIX_RE.global).toBe(false);
	});
});

describe("URI_SCHEME_PREFIX_RE", () => {
	it("is non-global", () => {
		expect(URI_SCHEME_PREFIX_RE.global).toBe(false);
	});
});
