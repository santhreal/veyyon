/**
 * WHY: `prepareCompaction` applies tail elision to the live branch as a side
 * effect of preparing — `elideTailToolResults` replaces `entry.message` with
 * a pointerless, `prunedAt`-stamped marker before any summarizer runs
 * (compaction.ts), and until the consumer offloads the originals on the
 * SUCCESS path (`#persistCompactionTailElisions`, after `appendCompaction`)
 * the preparation is the only place the bytes survive. A summarizer throw,
 * hook cancel, or abort between those two points discards the preparation;
 * without a restore the branch keeps a dead marker: `prunedAt` excludes it
 * from re-elision, the next summarizer receives marker text instead of the
 * content, and the next `rewriteEntries()` persists the pointerless marker
 * over the last copy of the output.
 *
 * The contract this suite pins: every failure path restores the originals
 * through `rollbackTailElisions` before propagating. After a failed pass the
 * branch holds the original messages byte-identically (same object, no
 * marker, no `prunedAt`), the retry summarizes the real bytes and elides the
 * new bulk, and a successful retry persists a POINTERED marker as a new
 * message object. The rollback also refuses to clobber an entry that moved
 * on after the preparation was made.
 *
 * Mutation gate: drop the `rollbackTailElisions` call (or its
 * `entry.message !== elision.message` guard) and the assertions below fail.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	renderTailElisionMarker,
	rollbackTailElisions,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";

let idCounter = 0;

const usage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function entry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-08-06T00:00:00.000Z", message };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	timestamp: 1,
	provider: "mock",
	model: "mock",
	api: "mock",
	usage: usage(),
	stopReason: "stop",
});

const withCall = (id: string) => assistant([{ type: "toolCall", id, name: "read", arguments: { path: "big" } }]);

const result = (toolCallId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

function messageOf(e: SessionEntry): AgentMessage {
	if (e.type !== "message") throw new Error("fixture entries are all message entries");
	return e.message;
}

function asToolResult(message: AgentMessage): ToolResultMessage {
	if (message.role !== "toolResult") throw new Error(`expected a toolResult, got ${message.role}`);
	return message;
}

const textOf = (message: AgentMessage): string => {
	const content = asToolResult(message).content;
	return typeof content === "string" ? content : content.map(b => (b.type === "text" ? b.text : "")).join("\n");
};

const settings = (keepRecentTokens: number) => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens });

const HUGE_A = "a".repeat(400_000);
const HUGE_B = "b".repeat(400_000);

function buildSession(): SessionEntry[] {
	idCounter = 0;
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < 6; turn++) {
		entries.push(entry(user(`q${turn}`)));
		entries.push(entry(withCall(`c${turn}`)));
		entries.push(entry(result(`c${turn}`, "small")));
	}
	// Newest turn: one tool result that dwarfs the keep-recent budget.
	entries.push(entry(user("last")));
	entries.push(entry(withCall("c-last")));
	entries.push(entry(result("c-last", HUGE_A)));
	return entries;
}

describe("a failed compaction pass rolls its tail elisions back", () => {
	it("restores the original byte-identically, then the retry summarizes the bytes and persists a pointered marker", () => {
		const entries = buildSession();
		const originalEntry = entries[entries.length - 1] as SessionMessageEntry;
		const originalMessage = asToolResult(originalEntry.message);

		// Pass 1: elision is applied to the live branch inside prepareCompaction.
		const first = prepareCompaction(entries, settings(10_000));
		expect(first).toBeDefined();
		expect(first!.tailElisions).toHaveLength(1);
		const elision = first!.tailElisions![0]!;
		expect(elision.entryId).toBe(originalEntry.id);
		expect(elision.originalText).toBe(HUGE_A);
		// The original message object rides on the elision for exactly this restore.
		expect(elision.originalMessage).toBe(originalMessage);

		// The marker on the live branch is pointerless and prunedAt-stamped.
		expect(originalEntry.message).not.toBe(originalMessage);
		expect(textOf(messageOf(originalEntry))).toContain("elided by compaction");
		expect(textOf(messageOf(originalEntry))).not.toContain("artifact://");
		expect(asToolResult(messageOf(originalEntry)).prunedAt).toBeDefined();

		// THE FAILURE: the summarizer throws and the preparation — the only
		// copy of the original bytes — would be discarded. The consumer's
		// failure path restores the originals before propagating.
		expect(rollbackTailElisions(entries, first!.tailElisions!)).toBe(1);

		// Byte-identical rollback: the same object back in the entry, no
		// marker text, no prunedAt stamp.
		expect(messageOf(originalEntry)).toBe(originalMessage);
		expect(asToolResult(messageOf(originalEntry)).prunedAt).toBeUndefined();
		const branchJson = JSON.stringify(entries);
		expect(branchJson).toContain(HUGE_A);
		expect(branchJson).not.toContain("elided by compaction");

		// RETRY: a new turn with another oversized result forces a second pass.
		entries.push(entry(user("next")));
		entries.push(entry(withCall("c-next")));
		entries.push(entry(result("c-next", HUGE_B)));

		const second = prepareCompaction(entries, settings(10_000));
		expect(second).toBeDefined();

		// The restored original is not prunedAt-blocked and not marker-text:
		// its real bytes reach the summarizer.
		const summarized = JSON.stringify(second!.messagesToSummarize);
		expect(summarized).toContain(HUGE_A.slice(0, 1_000));
		expect(summarized).not.toContain("elided by compaction");

		// The retry elides the new oversized result in the kept tail.
		expect(second!.tailElisions).toHaveLength(1);
		const retryElision = second!.tailElisions![0]!;
		expect(retryElision.originalText).toBe(HUGE_B);

		// SUCCESS this time: the consumer offloads the original and swaps the
		// marker for a NEW message object carrying the recovery pointer
		// (replace, not mutate — the identity-keyed estimate cache never sees
		// a mutation).
		const retryEntry = entries.find(
			(e): e is SessionMessageEntry => e.type === "message" && e.id === retryElision.entryId,
		)!;
		const pointered: ToolResultMessage = {
			...retryElision.message,
			content: [{ type: "text", text: renderTailElisionMarker(retryElision.toolName, retryElision.tokens, "art1") }],
		};
		retryEntry.message = pointered;
		retryElision.message = pointered;
		expect(textOf(messageOf(retryEntry))).toContain("elided by compaction");
		expect(textOf(messageOf(retryEntry))).toContain("artifact://art1");
		// The offloaded bytes survive on the elision for the artifact document.
		expect(retryElision.originalText).toBe(HUGE_B);
	});

	it("refuses to clobber an entry that no longer holds this pass's marker", () => {
		const entries = buildSession();
		const first = prepareCompaction(entries, settings(10_000));
		expect(first).toBeDefined();
		const elision = first!.tailElisions![0]!;
		const elidedEntry = entries.find(
			(e): e is SessionMessageEntry => e.type === "message" && e.id === elision.entryId,
		)!;

		// The entry moved on after the preparation was made: rollback must not
		// restore over a message some newer owner installed.
		const newer = result("c-last", "newer bytes");
		elidedEntry.message = newer;
		expect(rollbackTailElisions(entries, first!.tailElisions!)).toBe(0);
		expect(elidedEntry.message).toBe(newer);
	});
});
