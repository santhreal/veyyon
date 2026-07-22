import { afterEach, describe, expect, it } from "bun:test";
import { parseFileDiffs } from "../../src/commit/git/diff";
import { shouldUseMapReduce } from "../../src/commit/map-reduce/index";
import { estimateTokens } from "../../src/commit/map-reduce/utils";

/**
 * shouldUseMapReduce decides whether a commit diff is large enough to route to the
 * two-phase map-reduce analyzer instead of the single-shot model. It had no test.
 * The decision has four gates, all pinned here:
 *   - the VEYYON_COMMIT_MAP_REDUCE=false env var (case-insensitive) and
 *     settings.enabled === false are hard kill switches that win over size;
 *   - map-reduce is used when the count of NON-EXCLUDED changed files reaches
 *     minFiles (default 4); excluded files (lockfiles, etc.) do not count;
 *   - it is also used when ANY single file's estimated tokens exceed maxFileTokens
 *     (a strict greater-than, so a file exactly at the cap does NOT trigger);
 *   - otherwise it is not used.
 * A regression would run the expensive map-reduce path on a tiny diff, or fail to
 * use it on a huge one.
 */

function fileDiff(name: string, lines: string[]): string {
	return [
		`diff --git a/${name} b/${name}`,
		"index 000..111 100644",
		`--- a/${name}`,
		`+++ b/${name}`,
		`@@ -1,1 +1,${lines.length} @@`,
		...lines.map(l => `+${l}`),
	].join("\n");
}

const twoFiles = [fileDiff("a.ts", ["x"]), fileDiff("b.ts", ["y"])].join("\n");

afterEach(() => {
	delete process.env.VEYYON_COMMIT_MAP_REDUCE;
});

describe("shouldUseMapReduce kill switches", () => {
	it("returns false when settings.enabled is false, even if the size would qualify", () => {
		expect(shouldUseMapReduce(twoFiles, { enabled: false, minFiles: 1 })).toBe(false);
	});

	it("returns false when VEYYON_COMMIT_MAP_REDUCE is 'false' (case-insensitive)", () => {
		process.env.VEYYON_COMMIT_MAP_REDUCE = "FALSE";
		expect(shouldUseMapReduce(twoFiles, { minFiles: 1 })).toBe(false);
	});

	it("does not disable when the env var is unset", () => {
		expect(shouldUseMapReduce(twoFiles, { minFiles: 1 })).toBe(true);
	});
});

describe("shouldUseMapReduce file-count threshold", () => {
	it("uses map-reduce when the non-excluded file count reaches minFiles", () => {
		expect(shouldUseMapReduce(twoFiles, { minFiles: 2, maxFileTokens: 1_000_000 })).toBe(true);
	});

	it("does not use map-reduce when the count is below minFiles", () => {
		expect(shouldUseMapReduce(twoFiles, { minFiles: 3, maxFileTokens: 1_000_000 })).toBe(false);
	});

	it("excludes lockfiles from the count", () => {
		// One real source file plus package-lock.json: only 1 counts, below minFiles 2.
		const withLock = [fileDiff("a.ts", ["x"]), fileDiff("package-lock.json", ["lots"])].join("\n");
		expect(shouldUseMapReduce(withLock, { minFiles: 2, maxFileTokens: 1_000_000 })).toBe(false);
	});
});

describe("shouldUseMapReduce single-file token threshold", () => {
	const bigLines = Array.from({ length: 50 }, (_, i) => `const value${i} = ${i};`);
	const bigDiff = fileDiff("big.ts", bigLines);
	const bigTokens = estimateTokens(parseFileDiffs(bigDiff)[0].content);

	it("uses map-reduce when a single file's tokens strictly exceed maxFileTokens", () => {
		// minFiles high so only the token gate can trigger; cap one below the count.
		expect(shouldUseMapReduce(bigDiff, { minFiles: 99, maxFileTokens: bigTokens - 1 })).toBe(true);
	});

	it("does NOT trigger when the file's tokens exactly equal maxFileTokens (strict >)", () => {
		expect(shouldUseMapReduce(bigDiff, { minFiles: 99, maxFileTokens: bigTokens })).toBe(false);
	});

	it("does not use map-reduce for a small single-file diff under both gates", () => {
		expect(shouldUseMapReduce(fileDiff("small.ts", ["a = 1"]), { minFiles: 99, maxFileTokens: 1_000_000 })).toBe(
			false,
		);
	});
});
