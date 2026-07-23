import { describe, expect, it } from "bun:test";
import { buildGrepResultFromToolResult } from "@veyyon/ai/providers/cursor";
import type { ToolResultMessage } from "@veyyon/ai/types";

/**
 * Regression suite for a grep-output classification bug in the Cursor provider.
 *
 * `buildGrepResultFromToolResult` parses ripgrep-style lines in `content` mode.
 * Match lines are `file:line:content`; context lines (from -A/-B/-C) are
 * `file-line-content`. The parser tries the match regex first and only falls
 * back to the context regex (`match = matchLine ?? contextLine`), which is
 * correct. The bug was in the SEPARATE flag it derived: `isContextLine` was
 * `Boolean(contextLine)`, computed independently of which regex actually won.
 *
 * The two regexes overlap. A genuine MATCH line whose content contains a
 * `-<digits>-` run — an ISO date like `2024-01-15`, an index like `arr[i-1-x]` —
 * ALSO satisfies the context regex, so `contextLine` was non-null and the real
 * match was mislabeled `isContextLine: true`. That both corrupted the per-match
 * flag and dropped the line from `totalMatchedLines` (incremented only when
 * `!isContextLine`), silently undercounting matches.
 *
 * The fix derives the flag from the winning regex: `isContextLine = matchLine === null`.
 * These tests lock the exact classification and the match count.
 */

function grepToolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-grep",
		toolName: "grep",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function contentMatches(text: string) {
	const grep = buildGrepResultFromToolResult({ pattern: "x", outputMode: "content" }, grepToolResult(text));
	if (grep.result.case !== "success") throw new Error(`expected success, got ${grep.result.case}`);
	const union = grep.result.value.workspaceResults["."];
	if (!union) throw new Error("missing default-workspace result");
	if (union.result.case !== "content") throw new Error(`expected content union, got ${union.result.case}`);
	return union.result.value;
}

describe("cursor grep content-mode context classification", () => {
	it("labels a match line whose content holds an ISO date as a match, not context", () => {
		const content = contentMatches(`src/app.ts:42:const RELEASE = "2024-01-15";`);
		expect(content.matches).toHaveLength(1);
		const file = content.matches[0]!;
		expect(file.file).toBe("src/app.ts");
		expect(file.matches).toHaveLength(1);
		const entry = file.matches[0]!;
		expect(entry.lineNumber).toBe(42);
		expect(entry.content).toBe(`const RELEASE = "2024-01-15";`);
		expect(entry.isContextLine).toBe(false);
		// The whole point: the date-bearing match still counts as a match.
		expect(content.totalMatchedLines).toBe(1);
	});

	it("labels a match line whose content holds a -digit- index run as a match", () => {
		const content = contentMatches(`lib/util.ts:7:return arr[i-1-offset];`);
		const entry = content.matches[0]!.matches[0]!;
		expect(entry.lineNumber).toBe(7);
		expect(entry.content).toBe("return arr[i-1-offset];");
		expect(entry.isContextLine).toBe(false);
		expect(content.totalMatchedLines).toBe(1);
	});

	it("labels a genuine context line (file-line-content) as context and does not count it", () => {
		const content = contentMatches(`src/app.ts-41-// the line before the match`);
		const entry = content.matches[0]!.matches[0]!;
		expect(entry.lineNumber).toBe(41);
		expect(entry.content).toBe("// the line before the match");
		expect(entry.isContextLine).toBe(true);
		expect(content.totalMatchedLines).toBe(0);
	});

	it("counts every date-bearing match line in a batch (the undercount the bug caused)", () => {
		const text = [`a.ts:1:x = "2024-01-15"`, `b.ts:2:y = "2023-12-31"`, `c.ts:3:z = "1999-09-09"`].join("\n");
		const content = contentMatches(text);
		// Three files, one match each, all real matches — pre-fix this reported 0.
		expect(content.matches).toHaveLength(3);
		expect(content.totalMatchedLines).toBe(3);
		expect(content.matches.every(f => f.matches.every(m => m.isContextLine === false))).toBe(true);
	});

	it("classifies a mixed match+context block by the winning regex, not by date content", () => {
		const text = [
			`src/x.ts-9-// context above`,
			`src/x.ts:10:const d = "2024-06-01"; // real match with a date`,
			`src/x.ts:11:const plain = 1; // real match, no date`,
			`src/x.ts-12-// context below`,
		].join("\n");
		const content = contentMatches(text);
		const entries = content.matches.flatMap(f => f.matches);
		const flags = new Map(entries.map(e => [e.lineNumber, e.isContextLine]));
		expect(flags.get(9)).toBe(true);
		expect(flags.get(10)).toBe(false);
		expect(flags.get(11)).toBe(false);
		expect(flags.get(12)).toBe(true);
		// Only the two `file:line:` lines are matches.
		expect(content.totalMatchedLines).toBe(2);
	});
});
