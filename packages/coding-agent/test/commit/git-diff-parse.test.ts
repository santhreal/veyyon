import { describe, expect, it } from "bun:test";
import { parseDiffHunks, parseFileDiffs, parseFileHunks, parseNumstat } from "@veyyon/coding-agent/commit/git/diff";

/**
 * The commit pipeline parses `git diff` and `git diff --numstat` output into
 * structured file/hunk records. This module had no tests. The rename-path
 * extraction in particular regressed silently: a mid-path rename brace like
 * `src/{old => new}/file.ts` dropped the `/file.ts` suffix and reported the
 * renamed file as `src/new`, corrupting per-file attribution. These tests pin
 * the numstat counts, every rename shape, the file-split and add/delete tally,
 * binary detection, and the hunk-header ranges (including the omitted-count
 * default of 1 that matches git's own semantics).
 */

describe("parseNumstat", () => {
	it("parses additions, deletions, and path for a plain entry", () => {
		expect(parseNumstat("5\t2\tsrc/index.ts")).toEqual([{ path: "src/index.ts", additions: 5, deletions: 2 }]);
	});

	it("treats a binary entry's dash counts as zero", () => {
		expect(parseNumstat("-\t-\tassets/logo.png")).toEqual([{ path: "assets/logo.png", additions: 0, deletions: 0 }]);
	});

	it("skips blank lines and rows with fewer than three fields", () => {
		expect(parseNumstat("\n5\t2\ta.ts\n\tmalformed\n")).toEqual([{ path: "a.ts", additions: 5, deletions: 2 }]);
	});

	it("keeps the suffix after a mid-path rename brace", () => {
		// Regression guard: this used to yield `src/new`, losing `/file.ts`.
		expect(parseNumstat("10\t3\tsrc/{old => new}/file.ts")).toEqual([
			{ path: "src/new/file.ts", additions: 10, deletions: 3 },
		]);
	});

	it("handles a root-level rename brace", () => {
		expect(parseNumstat("1\t1\t{a.txt => b.txt}")).toEqual([{ path: "b.txt", additions: 1, deletions: 1 }]);
	});

	it("handles a brace that adds a new directory segment", () => {
		expect(parseNumstat("2\t0\tlib/{ => sub}/x.ts")).toEqual([{ path: "lib/sub/x.ts", additions: 2, deletions: 0 }]);
	});

	it("handles a whole-path rename without braces", () => {
		expect(parseNumstat("0\t0\told/path.ts => new/path.ts")).toEqual([
			{ path: "new/path.ts", additions: 0, deletions: 0 },
		]);
	});
});

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 context line
+added line
-removed line
diff --git a/data.bin b/data.bin
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/data.bin differ`;

describe("parseFileDiffs", () => {
	it("splits the diff into one section per file with the b/ path as filename", () => {
		const files = parseFileDiffs(SAMPLE_DIFF);
		expect(files.map(f => f.filename)).toEqual(["src/a.ts", "data.bin"]);
	});

	it("counts added and removed content lines, ignoring the +++/--- headers", () => {
		const [text] = parseFileDiffs(SAMPLE_DIFF);
		expect(text.additions).toBe(1);
		expect(text.deletions).toBe(1);
		expect(text.isBinary).toBe(false);
	});

	it("flags a binary file and reports zero line counts for it", () => {
		const bin = parseFileDiffs(SAMPLE_DIFF)[1];
		expect(bin.isBinary).toBe(true);
		expect(bin.additions).toBe(0);
		expect(bin.deletions).toBe(0);
	});

	it("returns no sections for an empty diff", () => {
		expect(parseFileDiffs("")).toEqual([]);
	});
});

describe("parseFileHunks / parseDiffHunks", () => {
	it("extracts the hunk range from the @@ header", () => {
		const [file] = parseDiffHunks(SAMPLE_DIFF);
		expect(file.filename).toBe("src/a.ts");
		expect(file.hunks).toHaveLength(1);
		expect(file.hunks[0]).toMatchObject({
			index: 0,
			oldStart: 1,
			oldLines: 2,
			newStart: 1,
			newLines: 3,
		});
	});

	it("returns no hunks for a binary file", () => {
		const bin = parseDiffHunks(SAMPLE_DIFF)[1];
		expect(bin.isBinary).toBe(true);
		expect(bin.hunks).toEqual([]);
	});

	it("defaults an omitted hunk-line count to 1, matching git semantics", () => {
		const file = parseFileHunks({
			filename: "x.ts",
			content: "diff --git a/x.ts b/x.ts\n@@ -5 +7 @@\n+one line",
			additions: 1,
			deletions: 0,
			isBinary: false,
		});
		expect(file.hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 7, newLines: 1 });
	});

	it("indexes multiple hunks in order", () => {
		const file = parseFileHunks({
			filename: "y.ts",
			content: "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,2 +10,3 @@\n c\n+d",
			additions: 2,
			deletions: 1,
			isBinary: false,
		});
		expect(file.hunks.map(h => h.index)).toEqual([0, 1]);
		expect(file.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 });
	});
});
