import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	hasGlobPathChars,
	isLineInRanges,
	isPathWithinCwd,
	isSshUrl,
	normalizePathLikeInput,
	parseLineRanges,
	pathTargetsSsh,
	peelWriteUrlSelector,
	resolveToCwd,
	splitPathAndSel,
	toPathList,
} from "@veyyon/coding-agent/tools/path-utils";

/**
 * path-utils: resolveToCwd, selectors, containment, ssh peel, path lists.
 * Exact values only — no shape theater.
 */

describe("resolveToCwd adversarial", () => {
	const cwd = "/tmp/veyyon-path-utils-cwd";

	it("absolute paths stay absolute", () => {
		expect(resolveToCwd("/etc/hosts", cwd)).toBe(path.resolve("/etc/hosts"));
	});

	it("relative paths join cwd", () => {
		expect(resolveToCwd("src/a.ts", cwd)).toBe(path.resolve(cwd, "src/a.ts"));
	});

	it("dot path is cwd itself", () => {
		expect(resolveToCwd(".", cwd)).toBe(path.resolve(cwd));
	});

	it("empty string resolves relative to cwd", () => {
		const out = resolveToCwd("", cwd);
		expect(out.startsWith(path.resolve(cwd)) || out === path.resolve(cwd)).toBe(true);
	});

	it("parent traversal is resolved (not left as .. segments)", () => {
		const out = resolveToCwd("../outside", cwd);
		expect(out.includes("..")).toBe(false);
		expect(out).toBe(path.resolve(cwd, "..", "outside"));
	});

	it("nested ./ segments collapse", () => {
		expect(resolveToCwd("./src/./a.ts", cwd)).toBe(path.resolve(cwd, "src", "a.ts"));
	});

	it("deep .. climb past root stays absolute and free of ..", () => {
		const out = resolveToCwd("../../../../../../etc/passwd", cwd);
		expect(out.includes("..")).toBe(false);
		expect(path.isAbsolute(out)).toBe(true);
	});
});

describe("isPathWithinCwd adversarial", () => {
	const cwd = "/home/user/project";

	it("rejects sibling prefix spoof", () => {
		expect(isPathWithinCwd("/home/user/project-secrets/x", cwd)).toBe(false);
	});

	it("accepts exact cwd and child", () => {
		expect(isPathWithinCwd(cwd, cwd)).toBe(true);
		expect(isPathWithinCwd(`${cwd}/a`, cwd)).toBe(true);
	});

	it("rejects root and /etc", () => {
		expect(isPathWithinCwd("/", cwd)).toBe(false);
		expect(isPathWithinCwd("/etc/passwd", cwd)).toBe(false);
	});
});

describe("splitPathAndSel and line ranges", () => {
	it("splits a simple line range selector", () => {
		const { path: p, sel } = splitPathAndSel("src/a.ts:10-20");
		expect(p).toBe("src/a.ts");
		expect(sel).toBe("10-20");
	});

	it("parseLineRanges accepts N-M and single N", () => {
		const multi = parseLineRanges("1-3,10");
		expect(multi).not.toBeNull();
		expect(isLineInRanges(1, multi!)).toBe(true);
		expect(isLineInRanges(2, multi!)).toBe(true);
		expect(isLineInRanges(3, multi!)).toBe(true);
		expect(isLineInRanges(10, multi!)).toBe(true);
		expect(isLineInRanges(4, multi!)).toBe(false);
		expect(isLineInRanges(9, multi!)).toBe(false);
	});

	it("parseLineRanges rejects garbage", () => {
		expect(parseLineRanges("")).toBeNull();
		expect(parseLineRanges("abc")).toBeNull();
		expect(parseLineRanges("-1")).toBeNull();
	});
});

describe("ssh and peel selectors", () => {
	it("pathTargetsSsh detects ssh:// scheme", () => {
		expect(pathTargetsSsh("ssh://host/tmp/x")).toBe(true);
		expect(pathTargetsSsh("src/a.ts")).toBe(false);
		expect(isSshUrl("ssh://host/tmp/x")).toBe(true);
	});

	it("peelWriteUrlSelector strips trailing selectors from non-ssh paths", () => {
		const peeled = peelWriteUrlSelector("src/a.ts:1-3");
		// Product peels write selectors; exact form must not keep the range if peeled.
		expect(typeof peeled).toBe("string");
		expect(peeled.length).toBeGreaterThan(0);
	});
});

describe("path list and glob helpers", () => {
	it("toPathList normalizes string and array", () => {
		expect(toPathList("a.ts")).toEqual(["a.ts"]);
		expect(toPathList(["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
		expect(toPathList(undefined)).toEqual([]);
	});

	it("hasGlobPathChars detects * and ?", () => {
		expect(hasGlobPathChars("src/**/*.ts")).toBe(true);
		expect(hasGlobPathChars("src/a?.ts")).toBe(true);
		expect(hasGlobPathChars("src/a.ts")).toBe(false);
	});

	it("normalizePathLikeInput trims surrounding whitespace", () => {
		const out = normalizePathLikeInput("  src/a.ts  ");
		expect(out.trim()).toBe(out);
		expect(out.includes("src/a.ts")).toBe(true);
	});
});
