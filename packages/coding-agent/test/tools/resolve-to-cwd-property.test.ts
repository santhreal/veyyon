import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isPathWithinCwd, resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";

/**
 * resolveToCwd + isPathWithinCwd identity properties over many relative paths.
 */

describe("resolveToCwd property-style", () => {
	const roots = ["/home/u/proj", "/tmp/w", "/var/lib/app"];

	it("absolute paths resolve to path.resolve of themselves for every root", () => {
		const absolutes = ["/etc/passwd", "/tmp/x", "/home/u/proj/src/a.ts"];
		for (const cwd of roots) {
			for (const abs of absolutes) {
				expect(resolveToCwd(abs, cwd)).toBe(path.resolve(abs));
			}
		}
	});

	it("relative children are always within cwd", () => {
		const children = ["a", "a/b", "a/b/c.ts", "./z", "x/../y"];
		for (const cwd of roots) {
			for (const rel of children) {
				const r = resolveToCwd(rel, cwd);
				expect(isPathWithinCwd(r, cwd)).toBe(true);
				expect(r.startsWith(path.resolve(cwd))).toBe(true);
			}
		}
	});

	it("parent escapes are never within cwd", () => {
		for (const cwd of roots) {
			for (const rel of ["..", "../x", "../../y", "a/../../.."]) {
				const r = resolveToCwd(rel, cwd);
				expect(isPathWithinCwd(r, cwd)).toBe(false);
			}
		}
	});

	it("resolve is idempotent for absolute results", () => {
		for (const cwd of roots) {
			const r1 = resolveToCwd("src/a.ts", cwd);
			const r2 = resolveToCwd(r1, cwd);
			expect(r2).toBe(r1);
		}
	});
});
