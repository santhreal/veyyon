import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { globSearchBase, isPathWithinCwd, resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";

/**
 * Fixed-seed grid over pure path predicates (no fast-check dep).
 * Every in-bounds case has an out-of-bounds twin where meaningful.
 * Drive shipped exports only — these are the same helpers the cwd boundary uses.
 */

const CWD = "/home/user/project";

describe("path-utils fixed-seed grid (isPathWithinCwd)", () => {
	const rows: Array<{ label: string; resolved: string; within: boolean }> = [
		{ label: "cwd itself", resolved: CWD, within: true },
		{ label: "direct child", resolved: `${CWD}/src/a.ts`, within: true },
		{ label: "nested child", resolved: `${CWD}/packages/x/y.ts`, within: true },
		{ label: "cwd with trailing-style normalize", resolved: path.resolve(CWD, "."), within: true },
		{ label: "parent of cwd", resolved: "/home/user", within: false },
		{ label: "sibling of cwd", resolved: "/home/user/other", within: false },
		{ label: "filesystem root", resolved: "/", within: false },
		{ label: "absolute etc", resolved: "/etc/passwd", within: false },
		{ label: "cwd-prefix spoof sibling", resolved: "/home/user/project-secret", within: false },
	];

	for (const row of rows) {
		it(`${row.within ? "inside" : "outside"}: ${row.label}`, () => {
			expect(isPathWithinCwd(row.resolved, CWD)).toBe(row.within);
		});
	}
});

describe("path-utils fixed-seed grid (resolveToCwd)", () => {
	it("resolves a relative path against cwd", () => {
		expect(resolveToCwd("src/a.ts", CWD)).toBe(`${CWD}/src/a.ts`);
	});

	it("keeps an absolute path absolute", () => {
		expect(resolveToCwd("/etc/passwd", CWD)).toBe("/etc/passwd");
	});

	it("maps bare root slash to cwd (workspace alias)", () => {
		expect(resolveToCwd("/", CWD)).toBe(CWD);
	});

	it("resolves .. traversal to an absolute escape", () => {
		expect(resolveToCwd("../sibling/x", CWD)).toBe("/home/user/sibling/x");
		expect(resolveToCwd("../../../etc/passwd", CWD)).toBe("/etc/passwd");
	});

	it("resolves . to cwd", () => {
		expect(resolveToCwd(".", CWD)).toBe(CWD);
	});

	it("twins: relative in-bounds vs absolute out-of-bounds", () => {
		const inside = resolveToCwd("README.md", CWD);
		const outside = resolveToCwd("/tmp/outside", CWD);
		expect(isPathWithinCwd(inside, CWD)).toBe(true);
		expect(isPathWithinCwd(outside, CWD)).toBe(false);
	});
});

describe("path-utils fixed-seed grid (globSearchBase)", () => {
	const rows: Array<{ pattern: string; base: string }> = [
		{ pattern: "/etc/**", base: "/etc" },
		{ pattern: "/etc/passwd", base: "/etc/passwd" },
		{ pattern: "src/**/*.ts", base: "src" },
		{ pattern: "*.ts", base: "" },
		{ pattern: "**/x", base: "" },
		{ pattern: "packages/foo/bar.ts", base: "packages/foo/bar.ts" },
		{ pattern: "  src/**  ", base: "src" },
	];

	for (const row of rows) {
		it(`base(${JSON.stringify(row.pattern)}) === ${JSON.stringify(row.base)}`, () => {
			expect(globSearchBase(row.pattern)).toBe(row.base);
		});
	}

	it("twin: in-cwd base vs out-of-cwd base under the boundary predicate", () => {
		const inBase = resolveToCwd(globSearchBase("src/**/*.ts") || ".", CWD);
		const outBase = resolveToCwd(globSearchBase("/etc/**"), CWD);
		expect(isPathWithinCwd(inBase, CWD)).toBe(true);
		expect(isPathWithinCwd(outBase, CWD)).toBe(false);
	});
});
