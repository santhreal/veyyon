import { describe, expect, it } from "bun:test";
import {
	combineSearchGlobs,
	formatPathRelativeToCwd,
	globSearchBase,
	isInternalUrlPath,
	isReadableUrlPath,
	normalizeLocalScheme,
	parseSearchPath,
	selectorLineRanges,
} from "@veyyon/coding-agent/tools/path-utils";

/**
 * A cluster of pure path/glob/URL helpers in path-utils.ts had no direct test even though
 * they decide search scope, URL routing, and how paths are displayed. isPathWithinCwd,
 * parseLineRanges, splitPathAndSel, and peelWriteUrlSelector are well covered elsewhere;
 * these siblings were not. Each contract is pinned so a regression that widens a search
 * scope, misroutes a URL, or shows the wrong path is caught:
 *   - globSearchBase returns the longest leading metachar-free directory run (the fixed
 *     root the cwd boundary checks); a bare `*.ts`/`**\/x` bases at "" (meaning cwd);
 *   - isReadableUrlPath matches strict/collapsed http(s) and scheme-less www., not ftp;
 *   - combineSearchGlobs joins a prefix and suffix with exactly one slash, trimming a
 *     trailing slash on the prefix and a leading slash on the suffix, and passes either
 *     through untouched when the other is absent;
 *   - parseSearchPath splits at the first glob segment, backslash-normalized;
 *   - selectorLineRanges extracts the range from a `raw`/`conflicts`-compounded selector
 *     and yields undefined for a pure display-mode or empty selector;
 *   - normalizeLocalScheme expands `local:/` to `local://` (single-slash to authority form);
 *   - isInternalUrlPath recognizes the top-level internal schemes but not a plain path;
 *   - formatPathRelativeToCwd shows an in-cwd path relative (cwd itself as "."), an
 *     out-of-cwd path absolute, an internal URL verbatim, and honors trailingSlash.
 */

describe("globSearchBase", () => {
	it("returns the longest metachar-free leading directory run", () => {
		expect(globSearchBase("src/**/*.ts")).toBe("src");
		expect(globSearchBase("/etc/**")).toBe("/etc");
		expect(globSearchBase("a/b/c[1]/d")).toBe("a/b");
	});

	it("treats a no-metachar pattern as its own base and trims surrounding whitespace", () => {
		expect(globSearchBase("/etc/passwd")).toBe("/etc/passwd");
		expect(globSearchBase("  src/a/*.ts  ")).toBe("src/a");
	});

	it("bases a leading-glob pattern at the empty string (meaning cwd)", () => {
		expect(globSearchBase("*.ts")).toBe("");
		expect(globSearchBase("**/x")).toBe("");
	});
});

describe("isReadableUrlPath", () => {
	it("accepts strict, collapsed, and scheme-less www. URL spellings", () => {
		expect(isReadableUrlPath("http://x")).toBe(true);
		expect(isReadableUrlPath("https://x")).toBe(true);
		expect(isReadableUrlPath("http:/x")).toBe(true);
		expect(isReadableUrlPath("https:/host")).toBe(true);
		expect(isReadableUrlPath("www.foo.com")).toBe(true);
	});

	it("rejects non-http(s) schemes and plain paths", () => {
		expect(isReadableUrlPath("ftp://x")).toBe(false);
		expect(isReadableUrlPath("/local")).toBe(false);
	});
});

describe("combineSearchGlobs", () => {
	it("passes a single non-empty side through unchanged", () => {
		expect(combineSearchGlobs(undefined, undefined)).toBeUndefined();
		expect(combineSearchGlobs("a/", undefined)).toBe("a/");
		expect(combineSearchGlobs(undefined, "/b")).toBe("/b");
	});

	it("joins prefix and suffix with exactly one slash, trimming the seam", () => {
		expect(combineSearchGlobs("src/", "/*.ts")).toBe("src/*.ts");
		expect(combineSearchGlobs("src", "*.ts")).toBe("src/*.ts");
	});
});

describe("parseSearchPath", () => {
	it("splits at the first glob segment and normalizes backslashes", () => {
		expect(parseSearchPath("src/**/*.ts")).toEqual({ basePath: "src", glob: "**/*.ts" });
		expect(parseSearchPath("src/a.ts")).toEqual({ basePath: "src/a.ts" });
		expect(parseSearchPath("*.ts")).toEqual({ basePath: ".", glob: "*.ts" });
		expect(parseSearchPath("a\\b\\*.ts")).toEqual({ basePath: "a/b", glob: "*.ts" });
	});
});

describe("selectorLineRanges", () => {
	it("extracts a range from a range or a raw-compounded selector", () => {
		expect(selectorLineRanges("5-10")).toEqual([{ startLine: 5, endLine: 10 }]);
		expect(selectorLineRanges("raw:50-100")).toEqual([{ startLine: 50, endLine: 100 }]);
	});

	it("yields undefined for a pure display-mode or an absent selector", () => {
		expect(selectorLineRanges(undefined)).toBeUndefined();
		expect(selectorLineRanges("raw")).toBeUndefined();
		expect(selectorLineRanges("conflicts")).toBeUndefined();
	});
});

describe("normalizeLocalScheme", () => {
	it("expands a single-slash local: to the authority form and leaves others alone", () => {
		expect(normalizeLocalScheme("local:/x")).toBe("local://x");
		expect(normalizeLocalScheme("local://x")).toBe("local://x");
		expect(normalizeLocalScheme("/a")).toBe("/a");
	});
});

describe("isInternalUrlPath", () => {
	it("recognizes top-level internal schemes but not a plain path", () => {
		expect(isInternalUrlPath("agent://1")).toBe(true);
		expect(isInternalUrlPath("artifact://5")).toBe(true);
		expect(isInternalUrlPath("mcp://s/r")).toBe(true);
		expect(isInternalUrlPath("local:/x")).toBe(true);
		expect(isInternalUrlPath("/a/b")).toBe(false);
	});
});

describe("formatPathRelativeToCwd", () => {
	it("shows an in-cwd path relative, with cwd itself as '.'", () => {
		expect(formatPathRelativeToCwd("/home/u/proj/src/a.ts", "/home/u/proj")).toBe("src/a.ts");
		expect(formatPathRelativeToCwd("/home/u/proj", "/home/u/proj")).toBe(".");
	});

	it("shows an out-of-cwd path absolute and an internal URL verbatim", () => {
		expect(formatPathRelativeToCwd("/etc/passwd", "/home/u/proj")).toBe("/etc/passwd");
		expect(formatPathRelativeToCwd("agent://1", "/home/u/proj")).toBe("agent://1");
	});

	it("appends a trailing slash for a directory when requested", () => {
		expect(formatPathRelativeToCwd("/home/u/proj/src", "/home/u/proj", { trailingSlash: true })).toBe("src/");
	});
});
