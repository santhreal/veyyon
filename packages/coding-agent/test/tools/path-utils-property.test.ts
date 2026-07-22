import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	isPathWithinCwd,
	parseLineRanges,
	isLineInRanges,
	resolveToCwd,
} from "@veyyon/coding-agent/tools/path-utils";

/**
 * Path containment and resolve properties over many relative paths.
 */

describe("path-utils property-style", () => {
	const cwd = "/home/user/project";

	it("every relative child path resolve is within cwd", () => {
		const children = ["a", "a/b", "a/b/c.ts", "src/index.ts", "./x", "x/../y/z"];
		for (const rel of children) {
			const resolved = resolveToCwd(rel, cwd);
			expect(isPathWithinCwd(resolved, cwd)).toBe(true);
			expect(resolved.includes("..")).toBe(false);
		}
	});

	it("every absolute escape path is outside cwd", () => {
		const escapes = ["/etc/passwd", "/home/user", "/home/user/other", "/tmp/x", "/"];
		for (const abs of escapes) {
			if (abs === cwd || abs.startsWith(`${cwd}/`)) continue;
			expect(isPathWithinCwd(path.resolve(abs), cwd)).toBe(false);
		}
	});

	it("parent traversal resolve is never reported as within cwd", () => {
		for (const rel of ["..", "../x", "../../etc/passwd", "a/../../.."]) {
			const resolved = resolveToCwd(rel, cwd);
			expect(isPathWithinCwd(resolved, cwd)).toBe(false);
		}
	});

	it("parseLineRanges bare N is open-ended from N (includes all larger lines)", () => {
		// Product contract: `:N` means startLine=N with no endLine (open-ended).
		for (let n = 1; n <= 30; n++) {
			const ranges = parseLineRanges(String(n));
			expect(ranges).not.toBeNull();
			expect(isLineInRanges(n, ranges!)).toBe(true);
			expect(isLineInRanges(n + 50, ranges!)).toBe(true);
			if (n > 1) expect(isLineInRanges(n - 1, ranges!)).toBe(false);
		}
	});

	it("parseLineRanges N-N is a closed single-line range", () => {
		for (let n = 1; n <= 20; n++) {
			const ranges = parseLineRanges(`${n}-${n}`);
			expect(ranges).not.toBeNull();
			expect(isLineInRanges(n, ranges!)).toBe(true);
			expect(isLineInRanges(n + 1, ranges!)).toBe(false);
			if (n > 1) expect(isLineInRanges(n - 1, ranges!)).toBe(false);
		}
	});

	it("parseLineRanges contiguous range covers every endpoint inclusive", () => {
		const ranges = parseLineRanges("5-15");
		expect(ranges).not.toBeNull();
		for (let i = 5; i <= 15; i++) {
			expect(isLineInRanges(i, ranges!)).toBe(true);
		}
		expect(isLineInRanges(4, ranges!)).toBe(false);
		expect(isLineInRanges(16, ranges!)).toBe(false);
	});
});
