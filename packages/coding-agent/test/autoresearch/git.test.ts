import { describe, expect, it } from "bun:test";
import {
	computeRunModifiedPaths,
	normalizeStatusPath,
	parseDirtyPaths,
	parseDirtyPathsWithStatus,
	parseWorkDirDirtyPaths,
	parseWorkDirDirtyPathsWithStatus,
	relativizeGitPathToWorkDir,
} from "@veyyon/coding-agent/autoresearch/git";

/**
 * autoresearch/git.ts parses `git status --porcelain` output to decide whether the
 * worktree is clean enough to start an autoresearch run and, afterwards, which paths
 * the run itself touched. All of it was pure and untested. A regression here is
 * quietly dangerous: mis-parsing dirty paths can either wrongly refuse to start
 * ("worktree is dirty") or, worse, treat a dirty tree as clean and let the discard
 * flow reset changes it should not touch. These pin the two wire formats and the
 * path math with exact arrays:
 *
 *  - The `-z` format is "XY " + path + NUL, and a rename/copy (R/C) carries TWO
 *    NUL-terminated paths (destination and source) that must BOTH be recorded.
 *  - The human line format separates a rename's two paths with " -> ".
 *  - `??` marks an untracked entry; every other status is tracked, and a rename's
 *    second path is never untracked.
 *  - Paths are de-duplicated, surrounding quotes are stripped, and paths outside the
 *    caller's work-dir prefix are dropped (null) rather than mis-attributed.
 *  - computeRunModifiedPaths returns only paths NOT present before the run, split
 *    into tracked vs untracked.
 */

const NUL = "\0";
/** Build a porcelain `-z` record: two-char status + separator space + path + NUL. */
const zRecord = (status: string, ...paths: string[]): string => `${status} ${paths.join(NUL)}${NUL}`;

describe("parseDirtyPaths", () => {
	it("parses the -z format including both paths of a rename", () => {
		const z = zRecord(" M", "src/a.ts") + zRecord("??", "new.txt") + zRecord("R ", "pkg/dest.ts", "pkg/orig.ts");
		expect(parseDirtyPaths(z)).toEqual(["src/a.ts", "new.txt", "pkg/dest.ts", "pkg/orig.ts"]);
	});

	it("parses the human line format splitting a rename on ' -> '", () => {
		const lines = " M src/a.ts\n?? new.txt\nR  orig.ts -> dest.ts";
		expect(parseDirtyPaths(lines)).toEqual(["src/a.ts", "new.txt", "orig.ts", "dest.ts"]);
	});

	it("de-duplicates repeated paths and returns an empty list for empty input", () => {
		const z = zRecord(" M", "dup.ts") + zRecord("MM", "dup.ts");
		expect(parseDirtyPaths(z)).toEqual(["dup.ts"]);
		expect(parseDirtyPaths("")).toEqual([]);
	});
});

describe("parseDirtyPathsWithStatus", () => {
	it("marks only ?? entries untracked and treats a rename's second path as tracked", () => {
		const z =
			zRecord(" M", "src/a.ts") +
			zRecord("??", "new.txt") +
			zRecord("A ", "added.ts") +
			zRecord("R ", "dest.ts", "orig.ts");
		expect(parseDirtyPathsWithStatus(z)).toEqual([
			{ path: "src/a.ts", untracked: false },
			{ path: "new.txt", untracked: true },
			{ path: "added.ts", untracked: false },
			{ path: "dest.ts", untracked: false },
			{ path: "orig.ts", untracked: false },
		]);
	});

	it("marks ?? entries untracked in the human line format too", () => {
		expect(parseDirtyPathsWithStatus("?? a.txt\n M b.ts")).toEqual([
			{ path: "a.txt", untracked: true },
			{ path: "b.ts", untracked: false },
		]);
	});
});

describe("normalizeStatusPath", () => {
	it("strips surrounding quotes and trims surrounding whitespace", () => {
		expect(normalizeStatusPath('"a b/c.ts"')).toBe("a b/c.ts");
		expect(normalizeStatusPath("  src/x.ts  ")).toBe("src/x.ts");
	});
});

describe("relativizeGitPathToWorkDir", () => {
	it("returns the path relative to a non-empty work-dir prefix", () => {
		expect(relativizeGitPathToWorkDir("pkg/coding/x.ts", "pkg/coding")).toBe("x.ts");
	});

	it("returns '.' when the path equals the prefix", () => {
		expect(relativizeGitPathToWorkDir("pkg/coding", "pkg/coding")).toBe(".");
	});

	it("returns null for a path outside the prefix (no false prefix match)", () => {
		expect(relativizeGitPathToWorkDir("other/x.ts", "pkg/coding")).toBeNull();
		// "pkg/codingX" must not match prefix "pkg/coding".
		expect(relativizeGitPathToWorkDir("pkg/codingX/x.ts", "pkg/coding")).toBeNull();
	});

	it("returns the path unchanged when the prefix is empty or '.'", () => {
		expect(relativizeGitPathToWorkDir("a/b.ts", "")).toBe("a/b.ts");
		expect(relativizeGitPathToWorkDir("a/b.ts", ".")).toBe("a/b.ts");
	});
});

describe("parseWorkDirDirtyPaths and parseWorkDirDirtyPathsWithStatus", () => {
	it("drops paths outside the work-dir prefix and relativizes the rest", () => {
		const z = zRecord(" M", "pkg/coding/a.ts") + zRecord("??", "pkg/coding/n.txt") + zRecord(" M", "other/z.ts");
		expect(parseWorkDirDirtyPaths(z, "pkg/coding")).toEqual(["a.ts", "n.txt"]);
		expect(parseWorkDirDirtyPathsWithStatus(z, "pkg/coding")).toEqual([
			{ path: "a.ts", untracked: false },
			{ path: "n.txt", untracked: true },
		]);
	});
});

describe("computeRunModifiedPaths", () => {
	it("returns only paths not dirty before the run, split into tracked and untracked", () => {
		const z = zRecord(" M", "src/a.ts") + zRecord("??", "new.txt") + zRecord("A ", "added.ts");
		expect(computeRunModifiedPaths(["src/a.ts"], z, "")).toEqual({
			tracked: ["added.ts"],
			untracked: ["new.txt"],
		});
	});

	it("returns empty lists when every dirty path predates the run", () => {
		const z = zRecord(" M", "a.ts") + zRecord(" M", "b.ts");
		expect(computeRunModifiedPaths(["a.ts", "b.ts"], z, "")).toEqual({ tracked: [], untracked: [] });
	});
});
