import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@veyyon/ai";
import {
	getToolResultMessage,
	KEEP_NOTHING_ENTRY_ID,
	resolveCompactionBoundaryIndex,
	type SessionEntry,
} from "../src/compaction/entries";
import { filterProviderReplayMessages, isProviderRefusalMessage } from "../src/replay-policy";

describe("getToolResultMessage", () => {
	it("returns undefined for non-message entry", () => {
		const entry: SessionEntry = {
			id: "1",
			type: "compaction",
			timestamp: 0,
		} as unknown as SessionEntry;
		expect(getToolResultMessage(entry)).toBeUndefined();
	});

	it("returns undefined for message entry with non-toolResult role", () => {
		const entry: SessionEntry = {
			id: "1",
			type: "message",
			timestamp: 0,
			message: { role: "user", content: "hello", timestamp: 0 },
		} as unknown as SessionEntry;
		expect(getToolResultMessage(entry)).toBeUndefined();
	});

	it("returns toolResult message for message entry with toolResult role", () => {
		const toolResult = {
			role: "toolResult",
			toolCallId: "call1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 0,
		};
		const entry: SessionEntry = {
			id: "1",
			type: "message",
			timestamp: 0,
			message: toolResult,
		} as unknown as SessionEntry;
		expect(getToolResultMessage(entry)).toEqual(toolResult as unknown as ToolResultMessage);
	});

	it("returns undefined for assistant message", () => {
		const entry: SessionEntry = {
			id: "1",
			type: "message",
			timestamp: 0,
			message: {
				role: "assistant",
				content: [],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {},
				stopReason: "stop",
				timestamp: 0,
			},
		} as unknown as SessionEntry;
		expect(getToolResultMessage(entry)).toBeUndefined();
	});
});

describe("resolveCompactionBoundaryIndex", () => {
	it("returns 0 when keepBoundaryId is undefined", () => {
		const entries: SessionEntry[] = [{ id: "a", type: "message", timestamp: 0 } as unknown as SessionEntry];
		expect(resolveCompactionBoundaryIndex(entries, undefined)).toBe(0);
	});

	it("returns 0 when keepBoundaryId is not found", () => {
		const entries: SessionEntry[] = [{ id: "a", type: "message", timestamp: 0 } as unknown as SessionEntry];
		expect(resolveCompactionBoundaryIndex(entries, "nonexistent")).toBe(0);
	});

	it("returns index of matching entry", () => {
		const entries: SessionEntry[] = [
			{ id: "a", type: "message", timestamp: 0 } as unknown as SessionEntry,
			{ id: "b", type: "message", timestamp: 1 } as unknown as SessionEntry,
			{ id: "c", type: "message", timestamp: 2 } as unknown as SessionEntry,
		];
		expect(resolveCompactionBoundaryIndex(entries, "b")).toBe(1);
	});

	it("returns 0 for KEEP_NOTHING_ENTRY_ID when no compaction entry exists", () => {
		const entries: SessionEntry[] = [{ id: "a", type: "message", timestamp: 0 } as unknown as SessionEntry];
		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBe(0);
	});

	it("returns index after last compaction entry for KEEP_NOTHING_ENTRY_ID", () => {
		const entries: SessionEntry[] = [
			{ id: "a", type: "message", timestamp: 0 } as unknown as SessionEntry,
			{ id: "b", type: "compaction", timestamp: 1 } as unknown as SessionEntry,
			{ id: "c", type: "message", timestamp: 2 } as unknown as SessionEntry,
		];
		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBe(2);
	});

	it("returns index after last compaction when multiple compactions exist", () => {
		const entries: SessionEntry[] = [
			{ id: "a", type: "compaction", timestamp: 0 } as unknown as SessionEntry,
			{ id: "b", type: "message", timestamp: 1 } as unknown as SessionEntry,
			{ id: "c", type: "compaction", timestamp: 2 } as unknown as SessionEntry,
			{ id: "d", type: "message", timestamp: 3 } as unknown as SessionEntry,
		];
		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBe(3);
	});

	it("returns 0 for empty entries with KEEP_NOTHING_ENTRY_ID", () => {
		expect(resolveCompactionBoundaryIndex([], KEEP_NOTHING_ENTRY_ID)).toBe(0);
	});

	it("returns 0 for empty entries with undefined", () => {
		expect(resolveCompactionBoundaryIndex([], undefined)).toBe(0);
	});
});

describe("isProviderRefusalMessage", () => {
	function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "anthropic",
			provider: "anthropic",
			model: "test",
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "error",
			timestamp: 0,
			...overrides,
		} as unknown as AssistantMessage;
	}

	it("returns false when stopReason is not error", () => {
		expect(isProviderRefusalMessage(makeAssistant({ stopReason: "stop" }))).toBe(false);
	});

	it("returns true when stopDetails type is refusal", () => {
		expect(
			isProviderRefusalMessage(
				makeAssistant({ stopDetails: { type: "refusal" } as unknown as AssistantMessage["stopDetails"] }),
			),
		).toBe(true);
	});

	it("returns true when stopDetails type is sensitive", () => {
		expect(
			isProviderRefusalMessage(
				makeAssistant({ stopDetails: { type: "sensitive" } as unknown as AssistantMessage["stopDetails"] }),
			),
		).toBe(true);
	});

	it("returns false when stopDetails type is other", () => {
		expect(
			isProviderRefusalMessage(
				makeAssistant({ stopDetails: { type: "other" } as unknown as AssistantMessage["stopDetails"] }),
			),
		).toBe(false);
	});

	it("returns false when stopDetails is undefined", () => {
		expect(isProviderRefusalMessage(makeAssistant({ stopDetails: undefined }))).toBe(false);
	});

	it("returns false when stopDetails is null", () => {
		expect(isProviderRefusalMessage(makeAssistant({ stopDetails: null }))).toBe(false);
	});
});

describe("filterProviderReplayMessages", () => {
	function makeAssistant(overrides: Partial<AssistantMessage> = {}): Message {
		return {
			role: "assistant",
			content: [],
			api: "anthropic",
			provider: "anthropic",
			model: "test",
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "error",
			timestamp: 0,
			...overrides,
		} as unknown as Message;
	}

	it("filters out refusal messages", () => {
		const messages: Message[] = [
			makeAssistant({ stopDetails: { type: "refusal" } as unknown as AssistantMessage["stopDetails"] }),
			makeAssistant({ stopReason: "stop", stopDetails: undefined }),
		];
		const result = filterProviderReplayMessages(messages);
		expect(result.length).toBe(1);
		expect((result[0] as AssistantMessage).stopReason).toBe("stop");
	});

	it("filters out sensitive messages", () => {
		const messages: Message[] = [
			makeAssistant({ stopDetails: { type: "sensitive" } as unknown as AssistantMessage["stopDetails"] }),
		];
		expect(filterProviderReplayMessages(messages).length).toBe(0);
	});

	it("preserves non-assistant messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 0 } as unknown as Message,
			makeAssistant({ stopDetails: { type: "refusal" } as unknown as AssistantMessage["stopDetails"] }),
		];
		const result = filterProviderReplayMessages(messages);
		expect(result.length).toBe(1);
		expect(result[0].role).toBe("user");
	});

	it("preserves assistant messages that are not refusals", () => {
		const messages: Message[] = [
			makeAssistant({ stopReason: "stop", stopDetails: undefined }),
			makeAssistant({ stopReason: "length", stopDetails: undefined }),
		];
		expect(filterProviderReplayMessages(messages).length).toBe(2);
	});

	it("handles empty array", () => {
		expect(filterProviderReplayMessages([])).toEqual([]);
	});

	it("preserves all when no refusals", () => {
		const messages: Message[] = [
			{ role: "user", content: "a", timestamp: 0 } as unknown as Message,
			makeAssistant({ stopReason: "stop", stopDetails: undefined }),
			{ role: "user", content: "b", timestamp: 1 } as unknown as Message,
		];
		expect(filterProviderReplayMessages(messages).length).toBe(3);
	});

	it("filters all when all are refusals", () => {
		const messages: Message[] = [
			makeAssistant({ stopDetails: { type: "refusal" } as unknown as AssistantMessage["stopDetails"] }),
			makeAssistant({ stopDetails: { type: "sensitive" } as unknown as AssistantMessage["stopDetails"] }),
		];
		expect(filterProviderReplayMessages(messages).length).toBe(0);
	});
});
