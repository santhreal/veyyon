import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	compactionContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	getLastAssistantUsage,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, ToolResultMessage, Usage } from "@veyyon/ai";

const IMAGE_TOKEN_ESTIMATE = 1200;
const FRAME_TOKEN_ESTIMATE = 5024;

let idCounter = 0;
function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-07-19T00:00:00.000Z", message };
}

function usage(over: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...over,
	};
}

function assistant(content: AssistantMessage["content"], over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: usage(),
		stopReason: "stop",
		...over,
	};
}

const IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("estimateTokens — role branches", () => {
	test("bashExecution counts command + output, empty yields 0", () => {
		const withText = estimateTokens({ role: "bashExecution", command: "ls -la", output: "a\nb\nc" } as never);
		expect(withText).toBeGreaterThan(0);
		const empty = estimateTokens({ role: "bashExecution" } as never);
		expect(empty).toBe(0);
	});

	test("user string content and array content both count text", () => {
		const asString = estimateTokens({ role: "user", content: "hello world", timestamp: 1 });
		const asArray = estimateTokens(userMessage("hello world"));
		expect(asString).toBeGreaterThan(0);
		expect(asArray).toBe(asString);
	});

	test("assistant thinkingSignature is counted by default and excluded on the compaction floor", () => {
		const msg = assistant([{ type: "thinking", thinking: "reasoning", thinkingSignature: "SIGNATURE-BLOB-XYZ" }]);
		const withSig = estimateTokens(msg);
		const withoutSig = estimateTokens(msg, { excludeEncryptedReasoning: true });
		expect(withSig).toBeGreaterThan(withoutSig);
	});

	test("assistant redactedThinking blob is counted by default and excluded on the floor", () => {
		const msg = assistant([{ type: "redactedThinking", data: "ENCRYPTED-REASONING-PAYLOAD" }]);
		const withData = estimateTokens(msg);
		const withoutData = estimateTokens(msg, { excludeEncryptedReasoning: true });
		expect(withData).toBeGreaterThan(0);
		expect(withoutData).toBe(0);
	});

	test("assistant toolCall counts the name and stringified arguments", () => {
		const msg = assistant([{ type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "foo" } }]);
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	test("toolResult with an image adds exactly the image estimate over text-only", () => {
		const textOnly: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 1,
		};
		const withImage: ToolResultMessage = { ...textOnly, content: [{ type: "text", text: "file body" }, IMAGE] };
		expect(estimateTokens(withImage) - estimateTokens(textOnly)).toBe(IMAGE_TOKEN_ESTIMATE);
	});

	test("toolResult string content counts the raw string", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: "raw output string" as never,
			isError: false,
			timestamp: 1,
		};
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	test("compactionSummary images add one frame estimate each over the bare summary", () => {
		const bare: AgentMessage = { role: "compactionSummary", summary: "recap", tokensBefore: 0, timestamp: 1 };
		const withImages: AgentMessage = { ...bare, images: [IMAGE, IMAGE] };
		expect(estimateTokens(withImages) - estimateTokens(bare)).toBe(2 * FRAME_TOKEN_ESTIMATE);
	});

	test("compactionSummary blocks: image blocks add a frame estimate, text blocks add tokens", () => {
		const textBlockOnly: AgentMessage = {
			role: "compactionSummary",
			summary: "recap",
			tokensBefore: 0,
			blocks: [{ type: "text", text: "archived body" }],
			timestamp: 1,
		};
		const withImageBlock: AgentMessage = {
			...textBlockOnly,
			blocks: [{ type: "text", text: "archived body" }, IMAGE],
		};
		expect(estimateTokens(withImageBlock) - estimateTokens(textBlockOnly)).toBe(FRAME_TOKEN_ESTIMATE);
	});

	test("branchSummary counts its summary text", () => {
		const msg: AgentMessage = { role: "branchSummary", summary: "branch recap", fromId: "x", timestamp: 1 };
		expect(estimateTokens(msg)).toBeGreaterThan(0);
	});

	test("unknown role yields 0", () => {
		expect(estimateTokens({ role: "label" } as never)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	test("returns the most recent non-aborted / non-error assistant usage", () => {
		const good = usage({ input: 111 });
		const entries: SessionEntry[] = [
			messageEntry(assistant([{ type: "text", text: "a" }], { usage: good })),
			messageEntry(
				assistant([{ type: "text", text: "b" }], { stopReason: "aborted", usage: usage({ input: 222 }) }),
			),
			messageEntry(assistant([{ type: "text", text: "c" }], { stopReason: "error", usage: usage({ input: 333 }) })),
		];
		expect(getLastAssistantUsage(entries)).toBe(good);
	});

	test("returns undefined when no assistant message carries usable usage", () => {
		const entries: SessionEntry[] = [messageEntry(userMessage("hi"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("compactionContextTokens", () => {
	test("takes the larger of provider usage and the stored-conversation floor", () => {
		expect(compactionContextTokens(100, 50)).toBe(100);
		expect(compactionContextTokens(50, 100)).toBe(100);
	});

	test("clamps negative inputs to zero before comparing", () => {
		expect(compactionContextTokens(-5, 10)).toBe(10);
		expect(compactionContextTokens(-5, -3)).toBe(0);
	});
});

describe("findTurnStartIndex", () => {
	test("walks back to the user message that started the turn", () => {
		const entries: SessionEntry[] = [
			messageEntry(userMessage("start")),
			messageEntry(assistant([{ type: "toolCall", id: "c", name: "t", arguments: {} }])),
			messageEntry({
				role: "toolResult",
				toolCallId: "c",
				toolName: "t",
				content: [{ type: "text", text: "r" }],
				isError: false,
				timestamp: 1,
			} as ToolResultMessage),
		];
		expect(findTurnStartIndex(entries, 2, 0)).toBe(0);
	});

	test("treats a bashExecution message as a turn start", () => {
		const entries: SessionEntry[] = [
			messageEntry({ role: "bashExecution", command: "ls", output: "" } as never),
			messageEntry(assistant([{ type: "text", text: "ok" }])),
		];
		expect(findTurnStartIndex(entries, 1, 0)).toBe(0);
	});

	test("treats a branch_summary entry as a turn start", () => {
		const entries: SessionEntry[] = [
			{ type: "branch_summary", id: "b", parentId: null, timestamp: "t", fromId: "f", summary: "s" },
			messageEntry(assistant([{ type: "text", text: "ok" }])),
		];
		expect(findTurnStartIndex(entries, 1, 0)).toBe(0);
	});

	test("returns -1 when no turn start exists before the index", () => {
		const entries: SessionEntry[] = [messageEntry(assistant([{ type: "text", text: "only-assistant" }]))];
		expect(findTurnStartIndex(entries, 0, 0)).toBe(-1);
	});
});

describe("findCutPoint", () => {
	test("returns the start index and no split when there are no valid cut points", () => {
		const entries: SessionEntry[] = [
			messageEntry({
				role: "toolResult",
				toolCallId: "c",
				toolName: "t",
				content: [{ type: "text", text: "r" }],
				isError: false,
				timestamp: 1,
			} as ToolResultMessage),
		];
		expect(findCutPoint(entries, 0, entries.length, 10)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});
	});

	test("cutting at a user message is not a split turn", () => {
		const big = "word ".repeat(4000);
		const entries: SessionEntry[] = [
			messageEntry(userMessage("turn one")),
			messageEntry(assistant([{ type: "text", text: "answer one" }])),
			messageEntry(userMessage(big)),
			messageEntry(assistant([{ type: "text", text: "answer two" }])),
		];
		const result = findCutPoint(entries, 0, entries.length, 100);
		expect(result.firstKeptEntryIndex).toBe(2);
		expect(result.isSplitTurn).toBe(false);
		expect(result.turnStartIndex).toBe(-1);
	});

	test("cutting mid-turn at an assistant message reports the split and the turn start", () => {
		const big = "word ".repeat(4000);
		const entries: SessionEntry[] = [
			messageEntry(userMessage("turn start")),
			messageEntry(assistant([{ type: "text", text: big }])),
		];
		const result = findCutPoint(entries, 0, entries.length, 100);
		// The budget is met walking back into the assistant reply, so the cut lands
		// on the assistant message (index 1), which is a split of the turn that
		// started at the user message (index 0).
		expect(result.firstKeptEntryIndex).toBe(1);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(0);
	});

	test("branch_summary and custom_message entries are valid cut points; tool results are not", () => {
		const big = "word ".repeat(4000);
		const entries: SessionEntry[] = [
			messageEntry(userMessage("older")),
			{ type: "branch_summary", id: "bs", parentId: null, timestamp: "t", fromId: "f", summary: "branch" },
			{
				type: "custom_message",
				id: "cm",
				parentId: null,
				timestamp: "t",
				customType: "note",
				content: [{ type: "text", text: big }],
				display: true,
			},
			messageEntry(assistant([{ type: "text", text: "recent" }])),
		];
		// A tiny budget stops at the newest message (the assistant, index 3), then
		// the backward scan sweeps the preceding non-message-role entries
		// (custom_message at 2, branch_summary at 1) into the kept tail, landing the
		// cut on the branch_summary at index 1. The scan stops at the user message.
		const result = findCutPoint(entries, 0, entries.length, 1);
		expect(result.firstKeptEntryIndex).toBe(1);
	});

	test("branch_summary and custom_message tokens count toward keepRecentTokens", () => {
		const big = "word ".repeat(4000);
		const entries: SessionEntry[] = [
			messageEntry(userMessage("older turn")),
			messageEntry(assistant([{ type: "text", text: "older answer" }])),
			{
				type: "custom_message",
				id: "cm",
				parentId: null,
				timestamp: "t",
				customType: "note",
				content: [{ type: "text", text: big }],
				display: true,
			},
			messageEntry(assistant([{ type: "text", text: "recent" }])),
		];
		// Budget is met by the custom_message alone (it stays in the retained
		// tail, so its tokens must count). The cut must land on the
		// custom_message (index 2) or later, not before it.
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(2);
	});

	test("budget crossed only at the oldest entry cuts strictly after it (no keep-everything dead end)", () => {
		const big = "word ".repeat(4000);
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "goal",
				parentId: null,
				timestamp: "t",
				customType: "goal",
				content: [{ type: "text", text: big }],
				display: true,
			},
			messageEntry(userMessage("work on the release")),
			messageEntry(assistant([{ type: "text", text: "on it" }])),
		];
		// The recent tail alone is tiny; the huge oldest entry is the only one
		// that crosses the budget. Keeping everything would leave compaction
		// nothing to summarize, so the cut moves past the crossing entry.
		const result = findCutPoint(entries, 0, entries.length, 100);
		expect(result.firstKeptEntryIndex).toBe(1);
	});

	test("scans backwards over non-message entries to include them with the kept tail", () => {
		const big = "word ".repeat(4000);
		const entries: SessionEntry[] = [
			messageEntry(userMessage("older turn")),
			messageEntry(assistant([{ type: "text", text: "older answer" }])),
			{ type: "thinking_level_change", id: "tlc", parentId: null, timestamp: "t", thinkingLevel: "high" },
			messageEntry(userMessage(big)),
		];
		// Budget forces the cut onto the last user message (index 3); the preceding
		// thinking_level_change (index 2) is a non-message entry, so the cut scans
		// back to include it, landing on index 2. Because that entry is not itself a
		// user message but its turn began at the user message (index 0), the cut is
		// reported as a split turn.
		const result = findCutPoint(entries, 0, entries.length, 100);
		expect(result.firstKeptEntryIndex).toBe(2);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(0);
	});
});
