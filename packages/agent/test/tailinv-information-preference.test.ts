/**
 * Within the retained tail, the budget is spent on high-information content
 * first.
 *
 * Defect class: when the tail had to shrink, what actually survived was
 * whatever the cut point happened to spare — in practice the low-information
 * bulk (file reads, command stdout), because it is big enough to dominate any
 * boundary-grained choice. The contract here ranks content by information
 * density: user messages, assistant text, tool CALLS (name and args), and
 * error results are never touched; bulk tool OUTPUT is the first elision
 * candidate, and among candidates the largest goes first — regardless of
 * recency, because a huge output is not worth keeping just because it is new.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, prepareCompaction } from "@veyyon/agent-core/compaction";
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

const withCall = (id: string, path: string) => assistant([{ type: "toolCall", id, name: "read", arguments: { path } }]);

const result = (toolCallId: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError,
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

const sum = (messages: readonly AgentMessage[]) => messages.reduce((total, m) => total + estimateTokens(m), 0);

/**
 * One small old turn, then two tool turns whose results are `textA` (older)
 * and `textB` (newer), and a budget that keeps BOTH turns yet lands just
 * under their combined size — computed from the same estimator the engine
 * uses, so the cut lands exactly on turn A's user message.
 */
function twoResultSession(textA: string, textB: string, isErrorB = false) {
	idCounter = 0;
	const entries: SessionEntry[] = [
		entry(user("old question")),
		entry(assistant([{ type: "text", text: "old answer" }])),
		entry(user("please read A")),
		entry(withCall("cA", "a.txt")),
		entry(result("cA", textA)),
		entry(user("now read B")),
		entry(withCall("cB", "b.txt")),
		entry(result("cB", textB, isErrorB)),
	];
	// The tail the budget must force a choice inside: turns A and B whole.
	const tail = entries.slice(2).map(messageOf);
	const budget = sum(tail) - 1;
	const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: budget };
	return { entries, budget, settings };
}

describe("when the budget forces a choice inside the tail", () => {
	it("elides the LARGEST result first, even when it is also the newest", () => {
		// A recency-ranked policy elides the older result; an information-ranked
		// one elides the bigger one. `b` is newer AND twice the size, so the two
		// policies give opposite answers here.
		const { entries, budget, settings } = twoResultSession("a".repeat(20_000), "b".repeat(40_000));
		const originalA = messageOf(entries[4]!);
		const prepared = prepareCompaction(entries, settings);

		expect(prepared).toBeDefined();
		expect(prepared!.tailElisions).toHaveLength(1);
		expect(prepared!.tailElisions![0]!.entryId).toBe(entries[7]!.id); // the newer, larger result
		expect(prepared!.tailElisions![0]!.originalText).toBe("b".repeat(40_000));
		// The older, smaller result survives byte for byte.
		expect(messageOf(entries[4]!)).toBe(originalA);
		expect(sum(prepared!.recentMessages)).toBeLessThanOrEqual(budget);
	});

	it("keeps every user message, assistant text, and tool call verbatim while bulk goes", () => {
		// The preference list, asserted on identity: anything that is not bulk
		// tool output is the same object after the pass as before it.
		const { entries, settings } = twoResultSession("a".repeat(20_000), "b".repeat(40_000));
		const originals = entries.map(messageOf);
		const prepared = prepareCompaction(entries, settings);

		expect(prepared).toBeDefined();
		for (const [i, message] of prepared!.recentMessages.entries()) {
			if (message.role === "toolResult") continue; // the elided one; covered above
			expect(originals[i + 2]).toBe(message);
		}
		// And the elided result's CALL is still in the tail, args and all, so the
		// pairing the provider enforces survives.
		const keptCall = prepared!.recentMessages.find(
			(m): boolean => m.role === "assistant" && m.content.some(b => b.type === "toolCall" && b.id === "cB"),
		);
		expect(keptCall).toBeDefined();
	});

	it("never spends an elision on an error, even when the error is the largest bulk in reach", () => {
		// The non-error result is smaller, but it is the only candidate: an
		// error is the information its call produced, at any size.
		const { entries, settings } = twoResultSession("a".repeat(30_000), "e".repeat(60_000), true);
		const prepared = prepareCompaction(entries, settings);

		expect(prepared).toBeDefined();
		expect(prepared!.tailElisions).toHaveLength(1);
		expect(prepared!.tailElisions![0]!.entryId).toBe(entries[4]!.id); // the smaller, non-error one
		const keptError = prepared!.recentMessages.find((m): boolean => m.role === "toolResult" && m.isError);
		expect(keptError).toBeDefined();
		const content = asToolResult(keptError!).content;
		expect(!Array.isArray(content) ? content : content.map(b => (b.type === "text" ? b.text : "")).join("")).toBe(
			"e".repeat(60_000),
		);
	});
});
