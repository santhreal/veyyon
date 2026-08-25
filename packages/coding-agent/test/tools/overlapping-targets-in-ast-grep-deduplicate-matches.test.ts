// WHY THIS SUITE EXISTS
// --------------------
// When ast_grep was converted to scan multiple targets concurrently, it aggregated
// target results into `retainedMatches` without deduplicating across targets. When
// two targets overlap (for example a directory and a file or subdirectory inside it),
// matches were inserted twice, inflating `totalMatches` and `filesWithMatches`, and
// allowing duplicate rows to displace unique matches once the retained capacity
// (`skip + limit + 1`) filled, silently dropping real hits during paging.
//
// This suite closes the class of multi-target overlap defects in ast_grep by
// asserting that:
// 1. Matches from overlapping targets appear exactly once in rendered results.
// 2. Details `matchCount` (totalMatches) and `fileCount` (filesWithMatches) reflect unique counts.
// 3. Paging with skip and limit across overlapping targets produces the exact same
//    sequence of matches as the single non-overlapping target query without dropped hits.
// 4. Overlap deduplication works in both target orderings (directory; file and file; directory).
//
// Gaps left:
// Deduplication operates on matching files and AST nodes; semantic duplicates
// across distinct physical files with identical content are not deduplicated.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

describe("ast_grep overlapping target deduplication", () => {
	it("deduplicates matches when searching overlapping directory and file targets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-overlap-"));
		try {
			const dirA = path.join(tempDir, "pkg-a");
			const dirB = path.join(tempDir, "pkg-b");
			await fs.mkdir(dirA, { recursive: true });
			await fs.mkdir(dirB, { recursive: true });

			const fileA1 = path.join(dirA, "a1.ts");
			const fileA2 = path.join(dirA, "a2.ts");
			const fileB1 = path.join(dirB, "b1.ts");
			await Bun.write(fileA1, 'const alpha = targetFunction("alpha");\nconst beta = targetFunction("beta");\n');
			await Bun.write(fileA2, 'const delta = targetFunction("delta");\n');
			await Bun.write(fileB1, 'const gamma = targetFunction("gamma");\n');

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			// Search overlapping targets: `pkg-a` directory, explicit file `pkg-a/a1.ts`, and `pkg-b`
			const result = await tool!.execute("ast-grep-overlap", {
				pat: "targetFunction($A)",
				path: `${dirA}; ${fileA1}; ${dirB}`,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as
				| { matchCount?: number; fileCount?: number; filesSearched?: number }
				| undefined;

			// Check that each unique match appears exactly once in the output text
			const alphaMatches = text.match(/targetFunction\("alpha"\)/g);
			const betaMatches = text.match(/targetFunction\("beta"\)/g);
			const deltaMatches = text.match(/targetFunction\("delta"\)/g);
			const gammaMatches = text.match(/targetFunction\("gamma"\)/g);

			expect(alphaMatches?.length).toBe(1);
			expect(betaMatches?.length).toBe(1);
			expect(deltaMatches?.length).toBe(1);
			expect(gammaMatches?.length).toBe(1);

			// Details must count unique matches (4) and unique files with matches (3)
			expect(details?.matchCount).toBe(4);
			expect(details?.fileCount).toBe(3);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("deduplicates matches regardless of target order (file before directory)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-overlap-order-"));
		try {
			const dirA = path.join(tempDir, "pkg-a");
			const dirB = path.join(tempDir, "pkg-b");
			await fs.mkdir(dirA, { recursive: true });
			await fs.mkdir(dirB, { recursive: true });

			const fileA1 = path.join(dirA, "a1.ts");
			const fileB1 = path.join(dirB, "b1.ts");
			await Bun.write(fileA1, 'const alpha = targetFunction("alpha");\n');
			await Bun.write(fileB1, 'const beta = targetFunction("beta");\n');

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			// Search file first, then parent directory, then sibling directory
			const result = await tool!.execute("ast-grep-overlap-rev", {
				pat: "targetFunction($A)",
				path: `${fileA1}; ${dirA}; ${dirB}`,
			});

			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as
				| { matchCount?: number; fileCount?: number }
				| undefined;

			const alphaMatches = text.match(/targetFunction\("alpha"\)/g);
			const betaMatches = text.match(/targetFunction\("beta"\)/g);

			expect(alphaMatches?.length).toBe(1);
			expect(betaMatches?.length).toBe(1);
			expect(details?.matchCount).toBe(2);
			expect(details?.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("preserves exact paging results without losing hits when capacity fills across overlapping targets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-overlap-paging-"));
		try {
			const dirA = path.join(tempDir, "pkg-a");
			const dirB = path.join(tempDir, "pkg-b");
			await fs.mkdir(dirA, { recursive: true });
			await fs.mkdir(dirB, { recursive: true });

			// Create 30 files under pkg-a, each with 2 matches = 60 matches
			for (let i = 0; i < 30; i++) {
				const num = i.toString().padStart(2, "0");
				await Bun.write(
					path.join(dirA, `item-${num}.ts`),
					`function fA${num}() {\n  callMarker("pkgA-first-${num}");\n  callMarker("pkgA-second-${num}");\n}\n`,
				);
			}

			// Create 10 files under pkg-b, each with 1 match = 10 matches (total 70 unique matches across 40 files)
			for (let i = 0; i < 10; i++) {
				const num = i.toString().padStart(2, "0");
				await Bun.write(
					path.join(dirB, `item-${num}.ts`),
					`function fB${num}() {\n  callMarker("pkgB-${num}");\n}\n`,
				);
			}

			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "ast_grep");
			expect(tool).toBeDefined();

			// Baseline: search pkg-a and pkg-b without duplicates
			const baselinePath = `${dirA}; ${dirB}`;
			const totalExpectedMatches = 70;
			const totalExpectedFiles = 40;
			const pageSize = 15;

			const baselinePages: string[] = [];
			for (let skip = 0; skip < totalExpectedMatches; skip += pageSize) {
				const baselinePage = await tool!.execute(`ast-grep-base-${skip}`, {
					pat: "callMarker($A)",
					path: baselinePath,
					skip,
				});
				const baseText = baselinePage.content.find(content => content.type === "text")?.text ?? "";
				baselinePages.push(baseText);
			}

			// Overlapping targets: pkg-a + first 15 files of pkg-a explicitly + pkg-b
			const explicitOverlapFiles = Array.from({ length: 15 }, (_, i) =>
				path.join(dirA, `item-${i.toString().padStart(2, "0")}.ts`),
			).join("; ");
			const overlappingPath = `${dirA}; ${explicitOverlapFiles}; ${dirB}`;

			// Paging with overlapping targets must produce identical pages and exact unique counts
			for (let pageIdx = 0, skip = 0; skip < totalExpectedMatches; pageIdx++, skip += pageSize) {
				const overlappingPage = await tool!.execute(`ast-grep-overlap-page-${skip}`, {
					pat: "callMarker($A)",
					path: overlappingPath,
					skip,
				});

				const overlapText = overlappingPage.content.find(content => content.type === "text")?.text ?? "";
				const details = overlappingPage.details as
					| { matchCount?: number; fileCount?: number }
					| undefined;

				expect(details?.matchCount).toBe(totalExpectedMatches);
				expect(details?.fileCount).toBe(totalExpectedFiles);
				expect(overlapText).toBe(baselinePages[pageIdx]!);
			}
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
