/**
 * WHY THIS SUITE EXISTS. Superseded-result pruning asked "is THIS candidate cheap to rewrite" and
 * nothing else, so it only ever fired in the last few thousand tokens of the conversation. Measured
 * on real sessions that reclaimed 55 results out of 17,094 with every pruning setting switched on:
 * at 120k of live context, no candidate outside the tail passed the test on its own, while together
 * the stale copies were most of the dead weight in the window and were re-read on every later turn.
 *
 * THE CLASS THIS CLOSES: a cache-cost guard evaluated per item when the cost is shared by the batch.
 * The price of a rewrite is set by the earliest entry it touches and paid once; the saving is the
 * whole batch's mass, collected every turn afterwards. So the arms below pin the decision as an
 * aggregate one, in both directions: a batch worth its rewrite is taken, a single stale result deep
 * in a warm prefix is still left alone, and the tail case keeps working when neither applies.
 *
 * WHAT THIS DOES NOT CATCH: whether `paybackTurns` matches how long a given session actually keeps
 * its context. It is a deliberate underestimate of the measured compaction interval, so the trade is
 * conservative rather than exact, and a session that compacts far sooner than 60 turns pays a
 * rewrite it does not fully recover.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	pruneSupersededToolResults,
	readToolSupersedeKey,
	SUPERSEDED_NOTICE,
	type SupersedePruneConfig,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@veyyon/ai";

let idCounter = 0;
function nextId(): string {
	return `sweep-${idCounter++}`;
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

function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `call-${idCounter++}`;
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(result, timestamp),
	];
}

/** Assistant prose that carries no tool call, used to build the warm suffix a rewrite would bust. */
function filler(tokens: number, timestamp: number): SessionMessageEntry {
	return messageEntry(assistantMessage([{ type: "text", text: "x".repeat(tokens * 4) }], timestamp), timestamp);
}

const CONFIG: SupersedePruneConfig = {
	supersedeKey: readToolSupersedeKey,
	protectedTools: [],
	// A fixed clock far below the idle flush window: every arm here must be decided by the cache
	// arithmetic, never by "the cache expired so rewriting is free".
	now: 10_000,
	idleFlushMs: 30 * 60_000,
};

function prunedTexts(entries: readonly SessionEntry[]): string[] {
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as ToolResultMessage;
		if (message.role !== "toolResult" || message.prunedAt === undefined) continue;
		out.push((message.content[0] as TextContent).text);
	}
	return out;
}

describe("a deep batch of superseded reads", () => {
	/**
	 * Ten stale copies of ten different files, each ~4k tokens, sitting under a 40k-token suffix.
	 * Alone, every one of them fails the tail test; together they are 40k of dead weight against an
	 * ~80k rewrite, which pays back well inside the 30-turn horizon the default assumes.
	 */
	function sessionWithStaleReads(count: number, staleTokens: number, suffixTokens: number): SessionEntry[] {
		const entries: SessionEntry[] = [];
		let clock = 1;
		for (let i = 0; i < count; i++) {
			entries.push(...readPair(`src/file-${i}.ts`, "s".repeat(staleTokens * 4), clock++));
		}
		// The newer read of each file is what makes the copy above it superseded.
		for (let i = 0; i < count; i++) {
			entries.push(...readPair(`src/file-${i}.ts`, "fresh", clock++));
		}
		entries.push(filler(suffixTokens, clock++));
		return entries;
	}

	test("is pruned together, because the batch pays for the rewrite its earliest member forces", () => {
		const entries = sessionWithStaleReads(10, 4_000, 40_000);
		const result = pruneSupersededToolResults(entries, CONFIG);

		expect(result.prunedCount).toBe(10);
		expect(prunedTexts(entries)).toEqual(Array.from({ length: 10 }, () => SUPERSEDED_NOTICE));
		// Reclaimed mass is the point of the trade, so assert it is the batch's and not one member's.
		expect(result.tokensSaved).toBeGreaterThan(35_000);
	});

	test("is left alone when the reclaimed mass cannot pay, however deep it sits", () => {
		// One stale read of 300 tokens under a 40k suffix: 300 * 60 payback turns is far below
		// 12.5 * 40_000, so rewriting costs more than it ever returns.
		const entries: SessionEntry[] = [];
		entries.push(...readPair("src/only.ts", "s".repeat(300 * 4), 1));
		entries.push(...readPair("src/only.ts", "fresh", 2));
		entries.push(filler(40_000, 3));

		expect(pruneSupersededToolResults(entries, CONFIG)).toEqual({ prunedCount: 0, tokensSaved: 0 });
		expect(prunedTexts(entries)).toEqual([]);
	});

	test("stops at the cut that pays, leaving deeper members that would only add rewrite cost", () => {
		// A tiny stale read buried under a large suffix, then a heavy batch nearer the tail. Taking
		// the deep one drags the rewrite boundary back over the whole conversation for 200 tokens.
		const entries: SessionEntry[] = [];
		entries.push(...readPair("src/deep.ts", "s".repeat(200 * 4), 1));
		entries.push(...readPair("src/deep.ts", "fresh", 2));
		entries.push(filler(60_000, 3));
		for (let i = 0; i < 6; i++) entries.push(...readPair(`src/near-${i}.ts`, "s".repeat(3_000 * 4), 4 + i));
		for (let i = 0; i < 6; i++) entries.push(...readPair(`src/near-${i}.ts`, "fresh", 20 + i));
		entries.push(filler(10_000, 40));

		const result = pruneSupersededToolResults(entries, CONFIG);

		expect(result.prunedCount).toBe(6);
		// The deep 200-token copy is still live: its own rewrite boundary is the expensive one.
		const survivor = entries[1] as SessionMessageEntry;
		expect((survivor.message as ToolResultMessage).prunedAt).toBeUndefined();
	});

	test("keeps pruning the cheap tail when no batch is worth a rewrite", () => {
		// The read -> edit -> read loop: one stale copy with almost nothing after it.
		const entries: SessionEntry[] = [];
		entries.push(filler(50_000, 1));
		entries.push(...readPair("src/tail.ts", "s".repeat(400 * 4), 2));
		entries.push(...readPair("src/tail.ts", "fresh", 3));

		expect(pruneSupersededToolResults(entries, CONFIG).prunedCount).toBe(1);
	});

	test("never rewrites entries the latest compaction already summarized away", () => {
		const entries = sessionWithStaleReads(10, 2_500, 40_000);
		// Boundary at the last entry: everything above it is summarized away and never sent, so a
		// rewrite there churns history and shrinks no prompt.
		const keepBoundaryId = (entries.at(-1) as SessionMessageEntry).id;

		expect(pruneSupersededToolResults(entries, { ...CONFIG, keepBoundaryId })).toEqual({
			prunedCount: 0,
			tokensSaved: 0,
		});
	});

	test("takes the whole batch once the cache has expired, without consulting the arithmetic", () => {
		const entries = sessionWithStaleReads(4, 200, 80_000);
		// Same shape as the "cannot pay" arm, but idle: the prefix is cold, so the rewrite is free
		// and the trade does not apply.
		const idle = { ...CONFIG, now: 10_000 + 31 * 60_000 };

		expect(pruneSupersededToolResults(entries, idle).prunedCount).toBe(4);
	});
});
