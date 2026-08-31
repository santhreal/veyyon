import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@veyyon/coding-agent/edit/file-snapshot-store";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * WHY THIS SUITE EXISTS (Contract & Regression Suite):
 *
 * Closes two production-path defect classes in the text search engine:
 *
 * 1. TRUNCATION & SEEN-LINES DEFECT:
 *    Native grep column-truncates output based on UTF-8 byte limits (`max_columns` bytes),
 *    appending `...` when a line exceeds the threshold. For multi-byte UTF-8 text (such as
 *    CJK characters, 3 bytes each), a 600-byte line has ~200 characters. Previously, the JS
 *    layer checked `line.length >= DEFAULT_MAX_COLUMN` (character count), which evaluated to
 *    false for truncated CJK context lines because 200 < 512. As a result, truncated CJK
 *    context lines leaked into `seenLines`, allowing the model to anchor edits on lines it
 *    had never seen in full.
 *    This suite verifies that column-truncated CJK and ASCII context lines never enter `seenLines`,
 *    while legitimate short lines ending with `...` or `…` remain fully visible and enter `seenLines`.
 *
 * 2. SCOPE PROVENANCE & UNION SEMANTICS DEFECT:
 *    When a query specified both a line-range constrained target and an unrestricted sibling scope
 *    (such as `file:90-100;.` or `.;file:90-100`), the range filter on `file` previously overrode
 *    and dropped matches outside lines 90-100 that were reached through the unrestricted scope `.`.
 *    Under union semantics, an unrestricted scope retains all its matches; a line selector on one
 *    target cannot constrain the same file reached through an unrestricted sibling scope.
 *    This suite verifies that ranged-only scopes constrain matches to the range, while ranged-plus-
 *    unrestricted scopes retain all matches across both input orderings.
 *
 * What this suite does NOT catch:
 *    Does not exercise out-of-process distributed worker transports or binary file encodings.
 */

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

function parseSnapshotTag(text: string, fileName: string): string | undefined {
	const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const groupPattern = new RegExp(`## ${escaped}#([0-9A-Fa-f]+)`);
	const groupMatch = text.match(groupPattern);
	if (groupMatch) return groupMatch[1];
	const singlePattern = new RegExp(`\\[(?:.+?/)?${escaped}#([0-9A-Fa-f]+)\\]`);
	const singleMatch = text.match(singlePattern);
	return singleMatch ? singleMatch[1] : undefined;
}

describe("SearchTool (text) seenLines truncation & scope provenance contracts", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-seen-prov-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(settingsOverrides: Record<string, unknown> = {}): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			getTurnIndex: () => 0,
			getSessionFile: () => null,
			settings: Settings.isolated({
				"search.contextBefore": 1,
				"search.contextAfter": 1,
				...settingsOverrides,
			}),
		});
	}

	describe("Defect 1: Truncated lines and seenLines isolation", () => {
		it("byte-truncated CJK context lines must never enter seenLines", async () => {
			const filePath = path.join(tmpDir, "cjk.txt");
			// Line 1 is 300 CJK characters (900 bytes UTF-8) -> truncated by native grep
			const longCjkBefore = "前置超长文本测试内容".repeat(30);
			// Line 3 is 300 CJK characters (900 bytes UTF-8) -> truncated by native grep
			const longCjkAfter = "后置超长文本测试内容".repeat(30);
			await fs.writeFile(filePath, `${longCjkBefore}\ntarget-needle-cjk\n${longCjkAfter}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-cjk", {
				type: "text",
				input: "target-needle-cjk",
				path: "cjk.txt",
			});

			const text = extractText(result);
			expect(text).toContain("target-needle-cjk");
			const tag = parseSnapshotTag(text, "cjk.txt");
			expect(tag).toBeDefined();
			if (!tag) throw new Error("Missing snapshot tag");

			const store = getFileSnapshotStore(session);
			const snapshot = store.byHash(canonicalSnapshotKey(filePath), tag);
			expect(snapshot).toBeDefined();
			expect(snapshot?.seenLines).toBeDefined();

			// Match line 2 is fully visible and MUST be in seenLines
			expect(snapshot?.seenLines?.has(2)).toBe(true);
			// Truncated CJK context lines (lines 1 and 3) MUST NOT enter seenLines
			expect(snapshot?.seenLines?.has(1)).toBe(false);
			expect(snapshot?.seenLines?.has(3)).toBe(false);
		});

		it("byte-truncated ASCII context lines must never enter seenLines", async () => {
			const filePath = path.join(tmpDir, "ascii.txt");
			const longAsciiBefore = "a".repeat(800);
			const longAsciiAfter = "b".repeat(800);
			await fs.writeFile(filePath, `${longAsciiBefore}\ntarget-needle-ascii\n${longAsciiAfter}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ascii", {
				type: "text",
				input: "target-needle-ascii",
				path: "ascii.txt",
			});

			const text = extractText(result);
			expect(text).toContain("target-needle-ascii");
			const tag = parseSnapshotTag(text, "ascii.txt");
			expect(tag).toBeDefined();
			if (!tag) throw new Error("Missing snapshot tag");

			const store = getFileSnapshotStore(session);
			const snapshot = store.byHash(canonicalSnapshotKey(filePath), tag);
			expect(snapshot?.seenLines?.has(2)).toBe(true);
			expect(snapshot?.seenLines?.has(1)).toBe(false);
			expect(snapshot?.seenLines?.has(3)).toBe(false);
		});

		it("legitimate short lines ending in ... or … remain seen in seenLines", async () => {
			const filePath = path.join(tmpDir, "short-dots.txt");
			const line1 = 'const status = "Loading...";';
			const line2 = "target-needle-short-dots";
			const line3 = "const cjk = '// 正在加载...';";
			const line4 = 'const done = "Completed…";';
			await fs.writeFile(filePath, `${line1}\n${line2}\n${line3}\n${line4}\n`, "utf-8");

			const session = createSession({
				"search.contextBefore": 1,
				"search.contextAfter": 2,
			});
			const tool = new SearchTool(session);

			const result = await tool.execute("search-short-dots", {
				type: "text",
				input: "target-needle-short-dots",
				path: "short-dots.txt",
			});

			const text = extractText(result);
			expect(text).toContain("target-needle-short-dots");
			const tag = parseSnapshotTag(text, "short-dots.txt");
			expect(tag).toBeDefined();
			if (!tag) throw new Error("Missing snapshot tag");

			const store = getFileSnapshotStore(session);
			const snapshot = store.byHash(canonicalSnapshotKey(filePath), tag);
			// All visible context and match lines must enter seenLines
			expect(snapshot?.seenLines?.has(1)).toBe(true);
			expect(snapshot?.seenLines?.has(2)).toBe(true);
			expect(snapshot?.seenLines?.has(3)).toBe(true);
			expect(snapshot?.seenLines?.has(4)).toBe(true);
		});

		it("legitimate 508-byte context line ending in ... enters seenLines without false positive truncation", async () => {
			const filePath = path.join(tmpDir, "exact-508.txt");
			// Exactly 505 'a' characters + '...' = 508 bytes (<= 512 maxColumns, so not truncated by native grep)
			const line508 = `${"a".repeat(505)}...`;
			const lineMatch = "target-needle-508";
			await fs.writeFile(filePath, `${line508}\n${lineMatch}\n`, "utf-8");

			const session = createSession({
				"search.contextBefore": 1,
				"search.contextAfter": 0,
			});
			const tool = new SearchTool(session);

			const result = await tool.execute("search-508", {
				type: "text",
				input: "target-needle-508",
				path: "exact-508.txt",
			});

			const text = extractText(result);
			expect(text).toContain("target-needle-508");
			const tag = parseSnapshotTag(text, "exact-508.txt");
			expect(tag).toBeDefined();
			if (!tag) throw new Error("Missing snapshot tag");

			const store = getFileSnapshotStore(session);
			const snapshot = store.byHash(canonicalSnapshotKey(filePath), tag);
			// The 508-byte context line was fully visible (not column-truncated) and must enter seenLines
			expect(snapshot?.seenLines?.has(1)).toBe(true);
			expect(snapshot?.seenLines?.has(2)).toBe(true);
		});

		it("legitimate 509-byte context line ending in ... enters seenLines via explicit metadata", async () => {
			const filePath = path.join(tmpDir, "exact-509.txt");
			// Exactly 506 'a' characters + '...' = 509 bytes (<= 512 maxColumns, so not truncated)
			const line509 = `${"a".repeat(506)}...`;
			const lineMatch = "target-needle-509";
			await fs.writeFile(filePath, `${line509}\n${lineMatch}\n`, "utf-8");

			const session = createSession({
				"search.contextBefore": 1,
				"search.contextAfter": 0,
			});
			const tool = new SearchTool(session);

			const result = await tool.execute("search-509", {
				type: "text",
				input: "target-needle-509",
				path: "exact-509.txt",
			});

			const text = extractText(result);
			expect(text).toContain("target-needle-509");
			const tag = parseSnapshotTag(text, "exact-509.txt");
			expect(tag).toBeDefined();
			if (!tag) throw new Error("Missing snapshot tag");

			const store = getFileSnapshotStore(session);
			const snapshot = store.byHash(canonicalSnapshotKey(filePath), tag);
			// The 509-byte context line was fully visible (not column-truncated) and enters seenLines
			expect(snapshot?.seenLines?.has(1)).toBe(true);
			expect(snapshot?.seenLines?.has(2)).toBe(true);
		});
	});

	describe("Defect 2: Scope provenance and union semantics", () => {
		beforeEach(async () => {
			// Create a 120-line file with matches at lines 1, 50, and 100
			const lines: string[] = [];
			for (let i = 1; i <= 120; i++) {
				if (i === 1) {
					lines.push("target-needle line 1");
				} else if (i === 50) {
					lines.push("target-needle line 50");
				} else if (i === 100) {
					lines.push("target-needle line 100");
				} else {
					lines.push(`plain line ${i}`);
				}
			}
			await fs.writeFile(path.join(tmpDir, "file.txt"), `${lines.join("\n")}\n`, "utf-8");
		});

		it("ranged-only scope file:90-100 returns only matches in that range", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-only", {
				type: "text",
				input: "target-needle",
				path: "file.txt:90-100",
			});

			const text = extractText(result);
			expect(text).toContain("*100:target-needle line 100");
			expect(text).not.toContain("*1:target-needle line 1");
			expect(text).not.toContain("*50:target-needle line 50");
		});

		it("ranged-plus-unrestricted scope 'file.txt:90-100;.' returns all matches under union semantics", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-plus-unrestricted", {
				type: "text",
				input: "target-needle",
				path: "file.txt:90-100;.",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle line 1");
			expect(text).toContain("*100:target-needle line 100");
		});

		it("ranged-plus-unrestricted scope in reverse order '.;file.txt:90-100' returns all matches under union semantics", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-unrestricted-plus-ranged", {
				type: "text",
				input: "target-needle",
				path: ".;file.txt:90-100",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle line 1");
			expect(text).toContain("*100:target-needle line 100");
		});

		it("ranged file plus unrestricted sibling file 'file.txt:90-100;file.txt' returns all matches", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-plus-file", {
				type: "text",
				input: "target-needle",
				path: "file.txt:90-100;file.txt",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle line 1");
			expect(text).toContain("*100:target-needle line 100");
		});

		it("multiple ranged selectors on the same file merge their line ranges", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-multi-range", {
				type: "text",
				input: "target-needle",
				path: "file.txt:1-10;file.txt:90-100",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle line 1");
			expect(text).toContain("*100:target-needle line 100");
			expect(text).not.toContain("*50:target-needle line 50");
		});

		it("ranged file plus disjoint sibling directory constrains only the ranged file", async () => {
			await fs.mkdir(path.join(tmpDir, "dir1"), { recursive: true });
			await fs.mkdir(path.join(tmpDir, "dir2"), { recursive: true });

			const dir1Lines = ["target-needle dir1 line 1", "plain", "target-needle dir1 line 100"];
			await fs.writeFile(path.join(tmpDir, "dir1", "file.txt"), `${dir1Lines.join("\n")}\n`, "utf-8");

			const dir2Lines = ["target-needle dir2 line 1", "plain", "target-needle dir2 line 100"];
			await fs.writeFile(path.join(tmpDir, "dir2", "file.txt"), `${dir2Lines.join("\n")}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-and-sibling-dir", {
				type: "text",
				input: "target-needle",
				path: "dir1/file.txt:3;dir2",
			});

			const text = extractText(result);
			expect(text).toContain("*3:target-needle dir1 line 100");
			expect(text).not.toContain("*1:target-needle dir1 line 1");

			// dir2 was searched unrestricted, so both lines are retained
			expect(text).toContain("*1:target-needle dir2 line 1");
			expect(text).toContain("*3:target-needle dir2 line 100");
		});

		it("ranged file plus unrestricted glob scope 'file.txt:90-100;*.txt' returns all matches under union semantics", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-plus-glob", {
				type: "text",
				input: "target-needle",
				path: "file.txt:90-100;*.txt",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle line 1");
			expect(text).toContain("*100:target-needle line 100");
		});

		it("unrestricted glob scope plus ranged file in reverse order '*.txt;file.txt:90-100' returns all matches under union semantics", async () => {
			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-glob-plus-ranged", {
				type: "text",
				input: "target-needle",
				path: "*.txt;file.txt:90-100",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle line 1");
			expect(text).toContain("*100:target-needle line 100");
		});

		it("ranged file plus recursive glob scope 'sub/file.txt:90-100;sub/**/*.txt' returns all matches", async () => {
			await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
			const subLines = ["target-needle sub line 1", "plain", "target-needle sub line 100"];
			await fs.writeFile(path.join(tmpDir, "sub", "file.txt"), `${subLines.join("\n")}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-plus-recursive-glob", {
				type: "text",
				input: "target-needle",
				path: "sub/file.txt:3;sub/**/*.txt",
			});

			const text = extractText(result);
			expect(text).toContain("*1:target-needle sub line 1");
			expect(text).toContain("*3:target-needle sub line 100");
		});

		it("ranged file outside glob directory 'file.txt:90-100;sub/**/*.txt' keeps root file constrained", async () => {
			await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
			const subLines = ["target-needle sub line 1", "plain", "target-needle sub line 100"];
			await fs.writeFile(path.join(tmpDir, "sub", "other.txt"), `${subLines.join("\n")}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-outside-glob-root", {
				type: "text",
				input: "target-needle",
				path: "file.txt:90-100;sub/**/*.txt",
			});

			const text = extractText(result);
			// file.txt is outside sub, so remains constrained to lines 90-100
			expect(text).toContain("*100:target-needle line 100");
			expect(text).not.toContain("*1:target-needle line 1");

			// sub/other.txt is unrestricted under the glob
			expect(text).toContain("*1:target-needle sub line 1");
			expect(text).toContain("*3:target-needle sub line 100");
		});

		it("ranged file outside glob extension pattern 'file.txt:90-100;*.md' keeps file.txt constrained to range", async () => {
			await fs.writeFile(path.join(tmpDir, "readme.md"), "target-needle in md line 1\n", "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-outside-glob-ext", {
				type: "text",
				input: "target-needle",
				path: "file.txt:90-100;*.md",
			});

			const text = extractText(result);
			// file.txt is NOT matched by *.md, so its range constraint [90-100] is not lifted
			expect(text).toContain("*100:target-needle line 100");
			expect(text).not.toContain("*1:target-needle line 1");

			// readme.md is matched by *.md
			expect(text).toContain("*1:target-needle in md line 1");
		});

		it("ranged file in sibling directory 'dir1/file.txt:3;dir2/*.txt' keeps dir1 file constrained", async () => {
			await fs.mkdir(path.join(tmpDir, "dir1"), { recursive: true });
			await fs.mkdir(path.join(tmpDir, "dir2"), { recursive: true });
			const d1Lines = ["target-needle d1 line 1", "plain", "target-needle d1 line 100"];
			await fs.writeFile(path.join(tmpDir, "dir1", "file.txt"), `${d1Lines.join("\n")}\n`, "utf-8");
			const d2Lines = ["target-needle d2 line 1", "plain", "target-needle d2 line 100"];
			await fs.writeFile(path.join(tmpDir, "dir2", "file.txt"), `${d2Lines.join("\n")}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-ranged-scoped-glob", {
				type: "text",
				input: "target-needle",
				path: "dir1/file.txt:3;dir2/*.txt",
			});

			const text = extractText(result);
			// dir1/file.txt is outside dir2/*.txt scope, so only line 3 is kept
			expect(text).toContain("*3:target-needle d1 line 100");
			expect(text).not.toContain("*1:target-needle d1 line 1");

			// dir2/file.txt is inside dir2/*.txt scope, so both lines are retained
			expect(text).toContain("*1:target-needle d2 line 1");
			expect(text).toContain("*3:target-needle d2 line 100");
		});

		it("handles literal bracket paths without breaking", async () => {
			await fs.mkdir(path.join(tmpDir, "routes", "[id]"), { recursive: true });
			const bracketLines = ["target-needle bracket line 1", "plain", "target-needle bracket line 100"];
			await fs.writeFile(path.join(tmpDir, "routes", "[id]", "page.tsx"), `${bracketLines.join("\n")}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-bracket-path", {
				type: "text",
				input: "target-needle",
				path: "routes/[id]/page.tsx:3;routes/[id]/page.tsx",
			});

			const text = extractText(result);
			// Unrestricted bracket file path supersedes the range constraint
			expect(text).toContain("*1:target-needle bracket line 1");
			expect(text).toContain("*3:target-needle bracket line 100");
		});

		it("child file named '..dotprefix.txt' inside directory is recognized as inside directory and lifted to unrestricted", async () => {
			await fs.mkdir(path.join(tmpDir, "subpkg"), { recursive: true });
			const dotLines = ["target-needle dot line 1", "plain", "target-needle dot line 100"];
			await fs.writeFile(path.join(tmpDir, "subpkg", "..dotprefix.txt"), `${dotLines.join("\n")}\n`, "utf-8");

			const session = createSession();
			const tool = new SearchTool(session);

			const result = await tool.execute("search-dot-prefix-file", {
				type: "text",
				input: "target-needle",
				path: "subpkg/..dotprefix.txt:3;subpkg",
			});

			const text = extractText(result);
			// subpkg is unrestricted, so subpkg/..dotprefix.txt should have both lines 1 and 3 retained
			expect(text).toContain("*1:target-needle dot line 1");
			expect(text).toContain("*3:target-needle dot line 100");
		});
	});
});
