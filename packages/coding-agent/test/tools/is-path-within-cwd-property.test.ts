import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isPathWithinCwd, resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";

/**
 * isPathWithinCwd properties: reflexivity, child inclusion, sibling exclusion.
 */

describe("isPathWithinCwd property-style", () => {
	const cwds = ["/home/user/project", "/tmp/w", "/var/lib/app/data", "/Users/x/code/repo"];

	it("cwd is always within itself", () => {
		for (const cwd of cwds) {
			expect(isPathWithinCwd(cwd, cwd)).toBe(true);
			expect(isPathWithinCwd(path.resolve(cwd), cwd)).toBe(true);
		}
	});

	it("every nested child is within cwd", () => {
		for (const cwd of cwds) {
			for (const rel of ["a", "a/b", "a/b/c.ts", "x/y/z/w.md"]) {
				expect(isPathWithinCwd(path.join(cwd, rel), cwd)).toBe(true);
			}
		}
	});

	it("sibling directories sharing a prefix are outside", () => {
		for (const cwd of cwds) {
			const sibling = `${cwd}-sibling`;
			expect(isPathWithinCwd(sibling, cwd)).toBe(false);
			expect(isPathWithinCwd(path.join(sibling, "x"), cwd)).toBe(false);
		}
	});

	it("parent of cwd is outside", () => {
		for (const cwd of cwds) {
			expect(isPathWithinCwd(path.dirname(cwd), cwd)).toBe(false);
		}
	});

	it("resolveToCwd relative child is within cwd", () => {
		for (const cwd of cwds) {
			const r = resolveToCwd("nested/file.ts", cwd);
			expect(isPathWithinCwd(r, cwd)).toBe(true);
		}
	});
});
