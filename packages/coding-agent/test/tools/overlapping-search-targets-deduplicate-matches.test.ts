// WHY THIS SUITE EXISTS
// --------------------
// When structure search was converted to scan multiple targets concurrently, it
// aggregated target results into `retainedMatches` without deduplicating across
// targets. When two targets overlap (for example a directory and a file or
// subdirectory inside it), matches were inserted twice, inflating `totalMatches`
// and `filesWithMatches`, and allowing duplicate rows to displace unique matches
// once the retained capacity (`skip + limit + 1`) filled, silently dropping real
// hits during paging.
//
// The searcher ships as the `search` tool with `type: "structure"`; the retired
// `ast_grep` primitive is gone, so the suite drives the shipped tool.
//
// This suite closes the class of multi-target overlap defects by asserting that:
// 1. Matches from overlapping targets appear exactly once in rendered results.
// 2. Details `matchCount` (totalMatches) and `fileCount` (filesWithMatches) reflect unique counts.
// 3. Paging with skip and limit across overlapping targets produces the exact same
//    sequence of matches as the single non-overlapping target query without dropped hits.
// 4. Overlap deduplication works in both target orderings (directory; file and file; directory).
// 5. Deduplication and path resolution behave correctly when a directory contains a file
//    sharing its exact name (avoiding false string suffix containment).
// 6. Three-way overlapping targets covering the same file with multiple matches count uniques.
//
// Gaps left:
// Deduplication operates on matching files and AST nodes; semantic duplicates
// across distinct physical files with identical content are not deduplicated.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
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

async function structureSearchTool(cwd: string): Promise<AgentTool> {
	const tools = await createTools(createTestSession(cwd));
	const tool = tools.find(entry => entry.name === "search");
	expect(tool).toBeDefined();
	return tool!;
}

interface CountedDetails {
	matchCount?: number;
	fileCount?: number;
	filesSearched?: number;
}

/** The search tool tags its details by representation: `{ type, result }`. */
function structureDetails(result: AgentToolResult): CountedDetails {
	const details = result.details as { type?: string; result?: CountedDetails } | undefined;
	expect(details?.type).toBe("structure");
	return details?.result ?? {};
}

function renderedText(result: AgentToolResult): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("overlapping structure-search target deduplication", () => {
	it("deduplicates matches when searching overlapping directory and file targets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "structure-overlap-"));
		try {
			const dirA = path.join(tempDir, "pkg-a");
			const dirB = path.join(tempDir, "pkg-b");
			await fs.mkdir(dirA, { recursive: true });
			await fs.mkdir(dirB, { recursive: true });

			const fileA1 = path.join(dirA, "a1.ts");
			const fileA2 = path.join(dirA, "a2.ts");
			const fileB1 = path.join(dirB, "b1.ts");
			await fs.writeFile(fileA1, 'const alpha = targetFunction("alpha");\nconst beta = targetFunction("beta");\n');
			await fs.writeFile(fileA2, 'const delta = targetFunction("delta");\n');
			await fs.writeFile(fileB1, 'const gamma = targetFunction("gamma");\n');

			const tool = await structureSearchTool(tempDir);

			// Search overlapping targets: `pkg-a` directory, explicit file `pkg-a/a1.ts`, and `pkg-b`
			const result = await tool.execute("structure-overlap", {
				type: "structure",
				input: "targetFunction($A)",
				path: `${dirA}; ${fileA1}; ${dirB}`,
			});

			const text = renderedText(result);
			const details = structureDetails(result);

			// Check that each unique match appears exactly once in the output text
			expect(text.match(/targetFunction\("alpha"\)/g)?.length).toBe(1);
			expect(text.match(/targetFunction\("beta"\)/g)?.length).toBe(1);
			expect(text.match(/targetFunction\("delta"\)/g)?.length).toBe(1);
			expect(text.match(/targetFunction\("gamma"\)/g)?.length).toBe(1);

			// Details must count unique matches (4) and unique files with matches (3)
			expect(details.matchCount).toBe(4);
			expect(details.fileCount).toBe(3);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("deduplicates matches regardless of target order (file before directory)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "structure-overlap-order-"));
		try {
			const dirA = path.join(tempDir, "pkg-a");
			const dirB = path.join(tempDir, "pkg-b");
			await fs.mkdir(dirA, { recursive: true });
			await fs.mkdir(dirB, { recursive: true });

			const fileA1 = path.join(dirA, "a1.ts");
			const fileB1 = path.join(dirB, "b1.ts");
			await fs.writeFile(fileA1, 'const alpha = targetFunction("alpha");\n');
			await fs.writeFile(fileB1, 'const beta = targetFunction("beta");\n');

			const tool = await structureSearchTool(tempDir);

			// Search file first, then parent directory, then sibling directory
			const result = await tool.execute("structure-overlap-rev", {
				type: "structure",
				input: "targetFunction($A)",
				path: `${fileA1}; ${dirA}; ${dirB}`,
			});

			const text = renderedText(result);
			const details = structureDetails(result);

			expect(text.match(/targetFunction\("alpha"\)/g)?.length).toBe(1);
			expect(text.match(/targetFunction\("beta"\)/g)?.length).toBe(1);
			expect(details.matchCount).toBe(2);
			expect(details.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("correctly resolves and deduplicates a directory containing a same-named file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "structure-same-name-"));
		try {
			const dirB = path.join(tempDir, "repo", "a", "b");
			const dirOther = path.join(tempDir, "repo", "other");
			await fs.mkdir(dirB, { recursive: true });
			await fs.mkdir(dirOther, { recursive: true });

			// File named 'b.ts' inside directory '.../b'
			const fileB = path.join(dirB, "b.ts");
			const fileOther = path.join(dirOther, "other.ts");
			await fs.writeFile(fileB, 'const sameName = sameNamedCall("inside-b");\n');
			await fs.writeFile(fileOther, 'const otherVal = sameNamedCall("inside-other");\n');

			const tool = await structureSearchTool(tempDir);

			// Overlapping targets: directory `.../a/b`, explicit file `.../a/b/b.ts`, and sibling `.../other`
			const result = await tool.execute("structure-same-name", {
				type: "structure",
				input: "sameNamedCall($A)",
				path: `${dirB}; ${fileB}; ${dirOther}`,
			});

			const text = renderedText(result);
			const details = structureDetails(result);

			expect(text.match(/sameNamedCall\("inside-b"\)/g)?.length).toBe(1);
			expect(text.match(/sameNamedCall\("inside-other"\)/g)?.length).toBe(1);
			expect(details.matchCount).toBe(2);
			expect(details.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("deduplicates three-way overlapping targets covering the same file with multiple matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "structure-three-way-"));
		try {
			const dirRoot = path.join(tempDir, "tree");
			const dirMid = path.join(dirRoot, "mid");
			const dirLeaf = path.join(dirMid, "leaf");
			const dirOther = path.join(tempDir, "other");
			await fs.mkdir(dirLeaf, { recursive: true });
			await fs.mkdir(dirOther, { recursive: true });

			const targetFile = path.join(dirLeaf, "target.ts");
			await fs.writeFile(
				targetFile,
				'const first = threeWayCall("match-1");\nconst second = threeWayCall("match-2");\n',
			);
			await fs.writeFile(path.join(dirOther, "other.ts"), 'const third = threeWayCall("match-3");\n');

			const tool = await structureSearchTool(tempDir);

			// Three targets all covering targetFile: tree/mid, tree/mid/leaf, and target.ts, plus sibling 'other'
			const result = await tool.execute("structure-three-way", {
				type: "structure",
				input: "threeWayCall($A)",
				path: `${dirMid}; ${dirLeaf}; ${targetFile}; ${dirOther}`,
			});

			const text = renderedText(result);
			const details = structureDetails(result);

			expect(text.match(/threeWayCall\("match-1"\)/g)?.length).toBe(1);
			expect(text.match(/threeWayCall\("match-2"\)/g)?.length).toBe(1);
			expect(text.match(/threeWayCall\("match-3"\)/g)?.length).toBe(1);
			// 2 matches in target.ts + 1 match in other.ts = 3 unique matches across 2 unique files
			expect(details.matchCount).toBe(3);
			expect(details.fileCount).toBe(2);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("preserves exact paging results without losing hits when capacity fills across overlapping targets", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "structure-overlap-paging-"));
		try {
			const dirA = path.join(tempDir, "pkg-a");
			const dirB = path.join(tempDir, "pkg-b");
			await fs.mkdir(dirA, { recursive: true });
			await fs.mkdir(dirB, { recursive: true });

			// Create 30 files under pkg-a, each with 2 matches = 60 matches
			for (let i = 0; i < 30; i++) {
				const num = i.toString().padStart(2, "0");
				await fs.writeFile(
					path.join(dirA, `item-${num}.ts`),
					`function fA${num}() {\n  callMarker("pkgA-first-${num}");\n  callMarker("pkgA-second-${num}");\n}\n`,
				);
			}

			// Create 10 files under pkg-b, each with 1 match = 10 matches (total 70 unique matches across 40 files)
			for (let i = 0; i < 10; i++) {
				const num = i.toString().padStart(2, "0");
				await fs.writeFile(
					path.join(dirB, `item-${num}.ts`),
					`function fB${num}() {\n  callMarker("pkgB-${num}");\n}\n`,
				);
			}

			const tool = await structureSearchTool(tempDir);

			// Baseline: search pkg-a and pkg-b without duplicates
			const baselinePath = `${dirA}; ${dirB}`;
			const totalExpectedMatches = 70;
			const totalExpectedFiles = 40;
			const pageSize = 15;

			const baselinePages: string[] = [];
			for (let skip = 0; skip < totalExpectedMatches; skip += pageSize) {
				const baselinePage = await tool.execute(`structure-base-${skip}`, {
					type: "structure",
					input: "callMarker($A)",
					path: baselinePath,
					skip,
				});
				baselinePages.push(renderedText(baselinePage));
			}

			// Overlapping targets: pkg-a + first 15 files of pkg-a explicitly + pkg-b
			const explicitOverlapFiles = Array.from({ length: 15 }, (_, i) =>
				path.join(dirA, `item-${i.toString().padStart(2, "0")}.ts`),
			).join("; ");
			const overlappingPath = `${dirA}; ${explicitOverlapFiles}; ${dirB}`;

			// Paging with overlapping targets must produce identical pages and exact unique counts
			for (let pageIdx = 0, skip = 0; skip < totalExpectedMatches; pageIdx++, skip += pageSize) {
				const overlappingPage = await tool.execute(`structure-overlap-page-${skip}`, {
					type: "structure",
					input: "callMarker($A)",
					path: overlappingPath,
					skip,
				});

				const details = structureDetails(overlappingPage);
				expect(details.matchCount).toBe(totalExpectedMatches);
				expect(details.fileCount).toBe(totalExpectedFiles);
				expect(renderedText(overlappingPage)).toBe(baselinePages[pageIdx]!);
			}
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
