/**
 * WHY: `readToolSupersedeKey` previously treated multi-target read paths (e.g. `read({ path: "a.ts; b.ts" })`)
 * as opaque composite strings. Because the string `"a.ts; b.ts"` never equalled `"a.ts"`, compound reads
 * neither superseded nor were superseded by individual reads of the files they contained, accumulating
 * redundant file contents in context. Furthermore, URL-scheme paths (`skill://...`) were completely exempt,
 * and colon splitting for selectors could mis-split Windows drive letters or URI schemes.
 *
 * This suite closes the class of multi-target supersede pruning defects:
 * - Supersede keys for `read` calls are parsed into sets of normalized target paths.
 * - An earlier read result is retired if and only if EVERY target it carries is covered by later reads.
 * - Partial overlap preserves the earlier read so that unread companion files are not lost.
 * - Full overlap across one or many subsequent reads retires the earlier read.
 * - URI schemes, Windows drive prefixes, and line/raw/compound selectors are preserved or stripped correctly.
 *
 * What this does not catch: Content-level semantic changes where a file was modified externally without a
 * subsequent tool call or tool-call logging.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	pruneSupersededToolResults,
	readToolSupersedeKey,
	SUPERSEDED_NOTICE,
	type SupersedePruneConfig,
} from "@veyyon/agent-core/compaction";
import type { ProtectedToolContext } from "@veyyon/agent-core/compaction/tool-protection";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@veyyon/ai";

let idCounter = 0;
function nextId(): string {
	return `multi-read-entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return { type: "message", id: nextId(), parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function toolResultMessage(toolName: string, toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(toolResultMessage("read", callId, text, timestamp), timestamp),
	];
}

function resultText(entry: SessionEntry): string {
	const message = (entry as SessionMessageEntry).message as ToolResultMessage;
	return (message.content[0] as TextContent).text;
}

const T0 = Date.UTC(2026, 7, 25, 12, 0, 0);
const CONTENT_A1 = "file A content version 1\n".repeat(20);
const CONTENT_A2 = "file A content version 2\n".repeat(20);
const CONTENT_B1 = "file B content version 1\n".repeat(20);
const CONTENT_B2 = "file B content version 2\n".repeat(20);
const CONTENT_C1 = "file C content version 1\n".repeat(20);
const CONTENT_AB = "file A content\n---\nfile B content\n".repeat(15);
const CONTENT_ABC = "file A\n---\nfile B\n---\nfile C\n".repeat(10);

function config(over: Partial<SupersedePruneConfig> = {}): SupersedePruneConfig {
	return { supersedeKey: readToolSupersedeKey, protectedTools: [], ...over };
}

describe("multi-target read supersede pruning", () => {
	it("retires an earlier single read when a later single read touches the same file", () => {
		const [callA1, resultA1] = readPair("src/a.ts", CONTENT_A1, T0);
		const [callA2, resultA2] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callA1, resultA1, callA2, resultA2];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(1);
		expect(resultText(resultA1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultA2)).toBe(CONTENT_A2);
	});

	it("does NOT retire an earlier compound read when a later single read covers only part of its targets", () => {
		const [callAB, resultAB] = readPair("src/a.ts; src/b.ts", CONTENT_AB, T0);
		const [callA, resultA] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callAB, resultAB, callA, resultA];

		// src/b.ts in resultAB is not yet superseded by anything; resultAB must survive.
		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resultAB)).toBe(CONTENT_AB);
		expect(resultText(resultA)).toBe(CONTENT_A2);
	});

	it("retires an earlier compound read when subsequent reads cover all of its targets", () => {
		const [callAB, resultAB] = readPair("src/a.ts; src/b.ts", CONTENT_AB, T0);
		const [callA, resultA] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		const [callB, resultB] = readPair("src/b.ts", CONTENT_B2, T0 + 2_000);
		const entries: SessionEntry[] = [callAB, resultAB, callA, resultA, callB, resultB];

		// Both a.ts and b.ts are re-read later; resultAB is now fully covered and retired.
		const res = pruneSupersededToolResults(entries, config({ now: T0 + 2_000 }));
		expect(res.prunedCount).toBe(1);
		expect(resultText(resultAB)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultA)).toBe(CONTENT_A2);
		expect(resultText(resultB)).toBe(CONTENT_B2);
	});

	it("retires earlier single reads when a later compound read covers their files", () => {
		const [callA, resultA] = readPair("src/a.ts", CONTENT_A1, T0);
		const [callB, resultB] = readPair("src/b.ts", CONTENT_B1, T0 + 1_000);
		const [callAB, resultAB] = readPair("src/a.ts; src/b.ts", CONTENT_AB, T0 + 2_000);
		const entries: SessionEntry[] = [callA, resultA, callB, resultB, callAB, resultAB];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 2_000 }));
		expect(res.prunedCount).toBe(2);
		expect(resultText(resultA)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultB)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultAB)).toBe(CONTENT_AB);
	});

	it("handles multi-target reads with 3+ files stepping from partial to full cover", () => {
		const [callABC, resultABC] = readPair("src/a.ts; src/b.ts; src/c.ts", CONTENT_ABC, T0);
		const [callA, resultA] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		const [callB, resultB] = readPair("src/b.ts", CONTENT_B2, T0 + 2_000);
		let entries: SessionEntry[] = [callABC, resultABC, callA, resultA, callB, resultB];

		// Only 2 of 3 covered: compound read survives.
		let res = pruneSupersededToolResults(entries, config({ now: T0 + 2_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resultABC)).toBe(CONTENT_ABC);

		// 3rd file covered: compound read is now retired.
		const [callC, resultC] = readPair("src/c.ts", CONTENT_C1, T0 + 3_000);
		entries = [...entries, callC, resultC];
		res = pruneSupersededToolResults(entries, config({ now: T0 + 3_000 }));
		expect(res.prunedCount).toBe(1);
		expect(resultText(resultABC)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resultA)).toBe(CONTENT_A2);
		expect(resultText(resultB)).toBe(CONTENT_B2);
		expect(resultText(resultC)).toBe(CONTENT_C1);
	});

	it("compares URI schemes, Windows drive letters, and line/raw selectors correctly", () => {
		const [callSkill1, resSkill1] = readPair("skill://react:10-50", CONTENT_A1, T0);
		const [callSkill2, resSkill2] = readPair("skill://react:raw", CONTENT_A2, T0 + 1_000);

		const [callWin1, resWin1] = readPair("C:\\Users\\admin\\file.ts:50-200", CONTENT_B1, T0 + 2_000);
		const [callWin2, resWin2] = readPair("C:\\Users\\admin\\file.ts:raw:1-5", CONTENT_B2, T0 + 3_000);

		const [callHttp1, resHttp1] = readPair("https://example.com/docs:50-", CONTENT_C1, T0 + 4_000);
		const [callHttp2, resHttp2] = readPair("https://example.com/docs", CONTENT_A1, T0 + 5_000);

		const entries: SessionEntry[] = [
			callSkill1,
			resSkill1,
			callSkill2,
			resSkill2,
			callWin1,
			resWin1,
			callWin2,
			resWin2,
			callHttp1,
			resHttp1,
			callHttp2,
			resHttp2,
		];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 5_000 }));
		expect(res.prunedCount).toBe(3);
		expect(resultText(resSkill1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resSkill2)).toBe(CONTENT_A2);
		expect(resultText(resWin1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resWin2)).toBe(CONTENT_B2);
		expect(resultText(resHttp1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resHttp2)).toBe(CONTENT_A1);
	});

	it("does not supersede across distinct URI resources under the same scheme", () => {
		const [callSkillA, resSkillA] = readPair("skill://alpha", CONTENT_A1, T0);
		const [callSkillB, resSkillB] = readPair("skill://beta", CONTENT_B1, T0 + 1_000);
		const entries: SessionEntry[] = [callSkillA, resSkillA, callSkillB, resSkillB];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resSkillA)).toBe(CONTENT_A1);
		expect(resultText(resSkillB)).toBe(CONTENT_B1);
	});

	it("preserves protected tool results from being retired", () => {
		const protectDoc = ({ toolCall }: ProtectedToolContext): boolean =>
			(toolCall?.arguments as Record<string, unknown> | undefined)?.path === "docs.md";
		const [callDoc1, resDoc1] = readPair("docs.md", CONTENT_A1, T0);
		const [callDoc2, resDoc2] = readPair("docs.md", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callDoc1, resDoc1, callDoc2, resDoc2];

		const res = pruneSupersededToolResults(entries, config({ protectedTools: [protectDoc], now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resDoc1)).toBe(CONTENT_A1);
		expect(resultText(resDoc2)).toBe(CONTENT_A2);
	});

	it("skips tool results that never ran from being retired or acting as superseders", () => {
		const [callA1, resA1] = readPair("src/a.ts", CONTENT_A1, T0);
		const [callA2, resA2] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		// Mark resA2 as never having run (e.g. skipped or synthetic placeholder)
		(resA2.message as ToolResultMessage).details = { __skipped: true, entered: false };
		const entries: SessionEntry[] = [callA1, resA1, callA2, resA2];
		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resA1)).toBe(CONTENT_A1);
		expect(resultText(resA2)).toBe(CONTENT_A2);
	});
});
