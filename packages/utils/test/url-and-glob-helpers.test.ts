import { describe, expect, it } from "bun:test";
import { parseGitignorePatterns } from "../src/glob";
import {
	containsUrlScheme,
	hasUriScheme,
	hasUrlScheme,
	normalizeBaseUrl,
	trimTrailingSlashes,
	urlScheme,
} from "../src/url";

describe("trimTrailingSlashes", () => {
	it("removes single trailing slash", () => {
		expect(trimTrailingSlashes("https://example.com/")).toBe("https://example.com");
	});
	it("removes multiple trailing slashes", () => {
		expect(trimTrailingSlashes("https://example.com///")).toBe("https://example.com");
	});
	it("returns as-is when no trailing slash", () => {
		expect(trimTrailingSlashes("https://example.com")).toBe("https://example.com");
	});
	it("handles empty string", () => {
		expect(trimTrailingSlashes("")).toBe("");
	});
	it("preserves internal slashes", () => {
		expect(trimTrailingSlashes("https://example.com/api/v1/")).toBe("https://example.com/api/v1");
	});
	it("handles only slashes", () => {
		expect(trimTrailingSlashes("///")).toBe("");
	});
});

describe("normalizeBaseUrl", () => {
	it("trims trailing slashes from provided URL", () => {
		expect(normalizeBaseUrl("https://example.com/", "fallback")).toBe("https://example.com");
	});
	it("trims whitespace from provided URL", () => {
		expect(normalizeBaseUrl("  https://example.com  ", "fallback")).toBe("https://example.com");
	});
	it("returns fallback when baseUrl is undefined", () => {
		expect(normalizeBaseUrl(undefined, "fallback")).toBe("fallback");
	});
	it("returns undefined when baseUrl is undefined and no fallback", () => {
		expect(normalizeBaseUrl(undefined)).toBeUndefined();
	});
	it("returns fallback when baseUrl is empty string", () => {
		expect(normalizeBaseUrl("", "fallback")).toBe("fallback");
	});
	it("returns fallback when baseUrl is whitespace-only", () => {
		expect(normalizeBaseUrl("   ", "fallback")).toBe("fallback");
	});
	it("removes trailing slashes and whitespace", () => {
		expect(normalizeBaseUrl("https://example.com/   ", "fallback")).toBe("https://example.com");
	});
});

describe("hasUrlScheme", () => {
	it("returns true for https URL", () => {
		expect(hasUrlScheme("https://example.com")).toBe(true);
	});
	it("returns true for http URL", () => {
		expect(hasUrlScheme("http://example.com")).toBe(true);
	});
	it("returns true for custom scheme", () => {
		expect(hasUrlScheme("myapp://path")).toBe(true);
	});
	it("returns false for plain path", () => {
		expect(hasUrlScheme("/path/to/file")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasUrlScheme("")).toBe(false);
	});
	it("returns false for scheme without //", () => {
		expect(hasUrlScheme("mailto:test@example.com")).toBe(false);
	});
});

describe("hasUriScheme", () => {
	it("returns true for https URI", () => {
		expect(hasUriScheme("https://example.com")).toBe(true);
	});
	it("returns true for mailto URI", () => {
		expect(hasUriScheme("mailto:test@example.com")).toBe(true);
	});
	it("returns true for custom scheme", () => {
		expect(hasUriScheme("myapp:path")).toBe(true);
	});
	it("returns false for plain path", () => {
		expect(hasUriScheme("/path/to/file")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasUriScheme("")).toBe(false);
	});
});

describe("urlScheme", () => {
	it("returns lowercase scheme for https URL", () => {
		expect(urlScheme("https://example.com")).toBe("https");
	});
	it("returns lowercase scheme for HTTP URL", () => {
		expect(urlScheme("HTTP://example.com")).toBe("http");
	});
	it("returns null for plain path", () => {
		expect(urlScheme("/path/to/file")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(urlScheme("")).toBeNull();
	});
	it("returns custom scheme", () => {
		expect(urlScheme("myapp://path")).toBe("myapp");
	});
});

describe("containsUrlScheme", () => {
	it("returns true when URL scheme is at start", () => {
		expect(containsUrlScheme("https://example.com")).toBe(true);
	});
	it("returns true when URL scheme is embedded", () => {
		expect(containsUrlScheme("prefix https://example.com suffix")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(containsUrlScheme("no url here")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(containsUrlScheme("")).toBe(false);
	});
});

describe("parseGitignorePatterns", () => {
	it("returns empty array for empty content", () => {
		expect(parseGitignorePatterns("", "/repo", "/repo")).toEqual([]);
	});
	it("skips comment lines", () => {
		expect(parseGitignorePatterns("# comment\n# another", "/repo", "/repo")).toEqual([]);
	});
	it("skips empty lines", () => {
		expect(parseGitignorePatterns("\n\n", "/repo", "/repo")).toEqual([]);
	});
	it("skips negation patterns", () => {
		expect(parseGitignorePatterns("!important.txt", "/repo", "/repo")).toEqual([]);
	});
	it("handles simple filename pattern", () => {
		const result = parseGitignorePatterns("node_modules", "/repo", "/repo");
		expect(result).toContain("**/node_modules");
		expect(result).toContain("**/node_modules/**");
	});
	it("handles directory pattern with trailing slash", () => {
		const result = parseGitignorePatterns("dist/", "/repo", "/repo");
		expect(result).toContain("**/dist");
		expect(result).toContain("**/dist/**");
	});
	it("handles anchored pattern with leading slash", () => {
		const result = parseGitignorePatterns("/build", "/repo", "/repo");
		expect(result.length).toBeGreaterThan(0);
	});
	it("handles pattern with path separator", () => {
		const result = parseGitignorePatterns("src/temp", "/repo", "/repo");
		expect(result.length).toBeGreaterThan(0);
	});
	it("handles multiple patterns", () => {
		const result = parseGitignorePatterns("node_modules\ndist\n*.log", "/repo", "/repo");
		expect(result.length).toBeGreaterThanOrEqual(6);
	});
});
