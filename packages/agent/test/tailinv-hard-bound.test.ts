/**
 * The retained tail after compaction is HARD-bounded by `keepRecentTokens`,
 * even when the newest turn alone is bigger than the budget.
 *
 * Defect class: `findCutPoint` can only cut at turn boundaries, so a session
 * ending in one enormous tool result kept that result whole — the tail was
 * bounded by where the cut happened to land, not by the budget, and tails of
 * ~100k tokens of low-information bulk survived every pass. The two older
 * answers were to keep the oversized turn verbatim (freed nothing) or to keep
 * nothing (summarized the user's latest message away with the bulk). The
 * contract here is the third answer: keep the turn, elide the bulk, and hold
 * the tail at or under budget — with three protections that outrank the
 * bound: the newest user message, assistant text/decisions, and error results
 * are never elided.
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

const withCall = (id: string) => assistant([{ type: "toolCall", id, name: "read", arguments: { path: "big" } }]);

const result = (toolCallId: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError,
	timestamp: 1,
});

/** Small turns, then a final turn whose single tool result dwarfs the budget. */
function sessionEndingInAHugeResult(smallTurns: number, tailChars: number, isError = false): SessionEntry[] {
	idCounter = 0;
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < smallTurns; turn++) {
		entries.push(entry(user(`q${turn}`)));
		entries.push(entry(withCall(`c${turn}`)));
		entries.push(entry(result(`c${turn}`, "small")));
	}
	entries.push(entry(user("last")));
	entries.push(entry(withCall("c-last")));
	entries.push(entry(result("c-last", "x".repeat(tailChars), isError)));
	return entries;
}

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

const sum = (messages: readonly AgentMessage[]) => messages.reduce((total, m) => total + estimateTokens(m), 0);

describe("a session ending in one ~100k-token tool result", () => {
	it("retains a tail at or under budget, with the result elided behind a marker", () => {
		// THE acceptance case. Before the elision the tail was the whole newest
		// turn, bulk included: an order of magnitude over budget.
		const prepared = prepareCompaction(sessionEndingInAHugeResult(6, 400_000), settings(10_000));

		expect(prepared).toBeDefined();
		expect(sum(prepared!.recentMessages)).toBeLessThanOrEqual(10_000);

		expect(prepared!.recentMessages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
		const kept = asToolResult(prepared!.recentMessages[2]!);
		expect(textOf(kept)).toContain("elided by compaction");
		expect(textOf(kept)).toContain('"read"');
		expect(prepared!.tailElisions).toHaveLength(1);
		expect(prepared!.tailElisions![0]!.originalText).toBe("x".repeat(400_000));
	});

	it("keeps the user's newest message and the tool CALL verbatim while the output goes", () => {
		// The information-aware half of the contract: what survives is exactly
		// the high-information content — what the user asked and what the
		// assistant decided to do — and what leaves is the bulk output.
		const entries = sessionEndingInAHugeResult(6, 400_000);
		const prepared = prepareCompaction(entries, settings(10_000));

		expect(prepared!.recentMessages[0]).toBe(messageOf(entries[18]!));
		expect(prepared!.recentMessages[1]).toBe(messageOf(entries[19]!));
		const keptCall = prepared!.recentMessages[1]!;
		if (keptCall.role !== "assistant") throw new Error("expected the kept call's assistant message");
		expect(keptCall.content[0]).toEqual({ type: "toolCall", id: "c-last", name: "read", arguments: { path: "big" } });
		// Pairing survives the elision: the marker result still answers the call.
		expect(asToolResult(prepared!.recentMessages[2]!).toolCallId).toBe("c-last");
	});

	it("never elides an error result, even when the error is the bulk", () => {
		// An error IS the information: eliding it would tell the model its tool
		// call vanished. The bound yields to the protection — the tail may stay
		// over budget, but the error survives byte for byte.
		const entries = sessionEndingInAHugeResult(6, 400_000, true);
		const prepared = prepareCompaction(entries, settings(10_000));

		expect(prepared).toBeDefined();
		expect(prepared!.tailElisions).toEqual([]);
		const kept = asToolResult(prepared!.recentMessages[2]!);
		expect(kept.isError).toBe(true);
		expect(textOf(kept)).toBe("x".repeat(400_000));
	});

	it("never elides the newest user message, even when IT is the bulk", () => {
		// Same protection, other role: a huge pasted brief rides the tail whole.
		idCounter = 0;
		const entries: SessionEntry[] = [
			entry(user("q0")),
			entry(assistant([{ type: "text", text: "a0" }])),
			entry(user(`brief ${"z".repeat(400_000)}`)),
			entry(assistant([{ type: "text", text: "reading it" }])),
		];
		const prepared = prepareCompaction(entries, settings(10_000));

		expect(prepared).toBeDefined();
		expect(prepared!.tailElisions).toEqual([]);
		const kept = prepared!.recentMessages.find(m => m.role === "user");
		expect(kept).toBe(messageOf(entries[2]!));
	});
});

describe("the default keep-recent budget", () => {
	it("is 10000", () => {
		// The operator's call: the tail rides the prefix cache anyway, so the
		// default halved. This pins the engine half
		// (DEFAULT_COMPACTION_SETTINGS); the settings-domain half lives in
		// coding-agent's context.ts.
		expect(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens).toBe(10_000);
	});
});
