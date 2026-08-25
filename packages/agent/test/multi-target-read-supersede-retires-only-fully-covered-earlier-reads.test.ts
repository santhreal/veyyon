/**
 * WHY: `readToolSupersedeKey` previously treated multi-target read paths (e.g. `read({ path: "a.ts; b.ts" })`)
 * as opaque composite strings. Because the string `"a.ts; b.ts"` never equalled `"a.ts"`, compound reads
 * neither superseded nor were superseded by individual reads of the files they contained, accumulating
 * redundant file contents in context. Furthermore, a compound call containing any URL scheme was exempted
 * entirely rather than per target.
 *
 * This suite defends:
 * 1. Multi-target supersede pruning where an earlier read result is retired if and only if EVERY target it
 *    carries is covered by later reads (partial cover preserves earlier compound reads).
 * 2. Target identity: path + selector (joined by NUL character \u0000). Different range selectors on the same
 *    file do NOT supersede each other; a selector-free read of a file covers all range reads of that file.
 * 3. Per-target URL and internal-scheme exemption (`skill://...`, `https://...`): schemes are exempt per
 *    target, allowing accompanying filesystem targets in compound calls to participate in supersede pruning.
 * 4. Windows drive prefixes (`C:\...`) are preserved and not mis-split at the drive colon.
 *
 * What this does not catch: Dynamic/semantic content overlap within files or tool results from non-read tools.
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

	it("does NOT supersede across different range selectors on the same file", () => {
		const [callRange1, resRange1] = readPair("src/a.ts:50-200", CONTENT_A1, T0);
		const [callRange2, resRange2] = readPair("src/a.ts:10-20", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callRange1, resRange1, callRange2, resRange2];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resRange1)).toBe(CONTENT_A1);
		expect(resultText(resRange2)).toBe(CONTENT_A2);
	});

	it("retires earlier ranged reads when a later selector-free read reads the whole file", () => {
		const [callRange, resRange] = readPair("src/a.ts:50-200", CONTENT_A1, T0);
		const [callFull, resFull] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callRange, resRange, callFull, resFull];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(1);
		expect(resultText(resRange)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resFull)).toBe(CONTENT_A2);
	});

	it("does NOT retire an earlier selector-free read when a later read carries a range selector", () => {
		const [callFull, resFull] = readPair("src/a.ts", CONTENT_A1, T0);
		const [callRange, resRange] = readPair("src/a.ts:50-200", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callFull, resFull, callRange, resRange];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resFull)).toBe(CONTENT_A1);
		expect(resultText(resRange)).toBe(CONTENT_A2);
	});

	it("exempts URL schemes per-target so accompanying files still participate in supersede pruning", () => {
		const [callMixed, resMixed] = readPair("src/a.ts; skill://react", CONTENT_A1, T0);
		const [callA, resA] = readPair("src/a.ts", CONTENT_A2, T0 + 1_000);
		const entries: SessionEntry[] = [callMixed, resMixed, callA, resA];

		// skill://react is exempt, so resMixed's only tracked target is src/a.ts.
		// When src/a.ts is read later, resMixed is fully covered and retired.
		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(1);
		expect(resultText(resMixed)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resA)).toBe(CONTENT_A2);
	});

	it("handles Windows drive letter paths and compound selectors correctly", () => {
		const [callWin1, resWin1] = readPair("C:\\Users\\admin\\file.ts:50-200", CONTENT_B1, T0);
		const [callWin2, resWin2] = readPair("C:\\Users\\admin\\file.ts", CONTENT_B2, T0 + 1_000);
		const entries: SessionEntry[] = [callWin1, resWin1, callWin2, resWin2];

		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(1);
		expect(resultText(resWin1)).toBe(SUPERSEDED_NOTICE);
		expect(resultText(resWin2)).toBe(CONTENT_B2);
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
		(resA2.message as ToolResultMessage).details = { __skipped: true, entered: false };
		const entries: SessionEntry[] = [callA1, resA1, callA2, resA2];
		const res = pruneSupersededToolResults(entries, config({ now: T0 + 1_000 }));
		expect(res.prunedCount).toBe(0);
		expect(resultText(resA1)).toBe(CONTENT_A1);
		expect(resultText(resA2)).toBe(CONTENT_A2);
	});
});
