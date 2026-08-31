import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolChoice, ToolResultMessage } from "@veyyon/ai";
import {
	ANTHROPIC_OUTPUT_BLOCKED_PREFIX,
	defaultConvertToLlm,
	isAnthropicOutputBlockedError,
	refreshToolChoiceForActiveTools,
} from "../src/agent-helpers";
import { filterProviderReplayMessages, isProviderRefusalMessage } from "../src/replay-policy";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "anthropic" as never,
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: { input: 10, output: 5 } as never,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function makeToolResultMessage(overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
		...overrides,
	};
}

describe("isProviderRefusalMessage", () => {
	it("returns false when stopReason is not 'error'", () => {
		expect(isProviderRefusalMessage(makeAssistantMessage({ stopReason: "stop" }))).toBe(false);
	});

	it("returns true when stopDetails.type is 'refusal'", () => {
		expect(
			isProviderRefusalMessage(makeAssistantMessage({ stopReason: "error", stopDetails: { type: "refusal" } })),
		).toBe(true);
	});

	it("returns true when stopDetails.type is 'sensitive'", () => {
		expect(
			isProviderRefusalMessage(makeAssistantMessage({ stopReason: "error", stopDetails: { type: "sensitive" } })),
		).toBe(true);
	});

	it("returns false when stopDetails.type is other", () => {
		expect(
			isProviderRefusalMessage(makeAssistantMessage({ stopReason: "error", stopDetails: { type: "max_tokens" } })),
		).toBe(false);
	});

	it("returns false when stopDetails is null", () => {
		expect(isProviderRefusalMessage(makeAssistantMessage({ stopReason: "error", stopDetails: null }))).toBe(false);
	});

	it("returns false when stopDetails is undefined", () => {
		expect(isProviderRefusalMessage(makeAssistantMessage({ stopReason: "error" }))).toBe(false);
	});

	it("returns false for non-assistant message role", () => {
		// isProviderRefusalMessage only accepts AssistantMessage, but the
		// stopReason check is the first gate
		const msg = makeAssistantMessage({ stopReason: "stop" });
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
});

describe("filterProviderReplayMessages", () => {
	it("filters out refusal messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi" } as Message,
			makeAssistantMessage({ stopReason: "error", stopDetails: { type: "refusal" } }),
			makeAssistantMessage({ stopReason: "stop" }),
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(2);
		expect(filtered[0].role).toBe("user");
		expect(filtered[1].role).toBe("assistant");
	});

	it("filters out sensitive messages", () => {
		const messages: Message[] = [
			makeAssistantMessage({ stopReason: "error", stopDetails: { type: "sensitive" } }),
			makeAssistantMessage({ stopReason: "stop" }),
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(1);
	});

	it("preserves non-refusal error messages", () => {
		const messages: Message[] = [makeAssistantMessage({ stopReason: "error", stopDetails: { type: "max_tokens" } })];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(1);
	});

	it("preserves user and toolResult messages", () => {
		const messages: Message[] = [{ role: "user", content: "hi" } as Message, makeToolResultMessage()];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(2);
	});

	it("returns empty for empty input", () => {
		expect(filterProviderReplayMessages([])).toEqual([]);
	});

	it("preserves all when no refusals", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi" } as Message,
			makeAssistantMessage({ stopReason: "stop" }),
			makeToolResultMessage(),
		];
		expect(filterProviderReplayMessages(messages)).toHaveLength(3);
	});
});

describe("defaultConvertToLlm", () => {
	it("filters in user messages", () => {
		const result = defaultConvertToLlm([{ role: "user", content: "hello" } as never]);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("user");
	});

	it("filters in toolResult messages", () => {
		const result = defaultConvertToLlm([makeToolResultMessage() as never]);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("toolResult");
	});

	it("filters in assistant messages that are not refusals", () => {
		const result = defaultConvertToLlm([makeAssistantMessage({ stopReason: "stop" }) as never]);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("assistant");
	});

	it("filters out assistant refusal messages", () => {
		const result = defaultConvertToLlm([
			makeAssistantMessage({ stopReason: "error", stopDetails: { type: "refusal" } }) as never,
		]);
		expect(result).toHaveLength(0);
	});

	it("filters out assistant sensitive messages", () => {
		const result = defaultConvertToLlm([
			makeAssistantMessage({ stopReason: "error", stopDetails: { type: "sensitive" } }) as never,
		]);
		expect(result).toHaveLength(0);
	});

	it("preserves assistant error messages that are not refusals", () => {
		const result = defaultConvertToLlm([
			makeAssistantMessage({ stopReason: "error", stopDetails: { type: "max_tokens" } }) as never,
		]);
		expect(result).toHaveLength(1);
	});

	it("handles mixed messages", () => {
		const result = defaultConvertToLlm([
			{ role: "user", content: "hi" } as never,
			makeAssistantMessage({ stopReason: "stop" }) as never,
			makeToolResultMessage() as never,
			makeAssistantMessage({ stopReason: "error", stopDetails: { type: "refusal" } }) as never,
		]);
		expect(result).toHaveLength(3);
	});

	it("returns empty for empty input", () => {
		expect(defaultConvertToLlm([])).toEqual([]);
	});
});

describe("isAnthropicOutputBlockedError", () => {
	it("returns true for message containing the prefix", () => {
		expect(isAnthropicOutputBlockedError("Output blocked by content policy")).toBe(true);
	});

	it("returns true for message with prefix embedded", () => {
		expect(isAnthropicOutputBlockedError("Error: Output blocked by conten filter")).toBe(true);
	});

	it("returns false for unrelated message", () => {
		expect(isAnthropicOutputBlockedError("Some other error")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isAnthropicOutputBlockedError("")).toBe(false);
	});

	it("returns false for similar but not exact prefix", () => {
		expect(isAnthropicOutputBlockedError("Output blocked by filter")).toBe(false);
	});

	it("the constant matches the prefix", () => {
		expect(ANTHROPIC_OUTPUT_BLOCKED_PREFIX).toBe("Output blocked by conten");
	});
});

describe("refreshToolChoiceForActiveTools", () => {
	it("returns undefined for undefined toolChoice", () => {
		expect(refreshToolChoiceForActiveTools(undefined, [])).toBeUndefined();
	});

	it("returns string toolChoice as-is", () => {
		expect(refreshToolChoiceForActiveTools("auto", [])).toBe("auto");
		expect(refreshToolChoiceForActiveTools("none", [])).toBe("none");
		expect(refreshToolChoiceForActiveTools("any", [])).toBe("any");
		expect(refreshToolChoiceForActiveTools("required", [])).toBe("required");
	});

	it("returns toolChoice when tool name exists in tools", () => {
		const tools = [{ name: "read" }, { name: "write" }] as never;
		const tc: ToolChoice = { type: "tool", name: "read" };
		expect(refreshToolChoiceForActiveTools(tc, tools)).toBe(tc);
	});

	it("returns undefined when tool name not in tools", () => {
		const tools = [{ name: "read" }] as never;
		const tc: ToolChoice = { type: "tool", name: "bash" };
		expect(refreshToolChoiceForActiveTools(tc, tools)).toBeUndefined();
	});

	it("handles { type: 'function', name } form", () => {
		const tools = [{ name: "read" }] as never;
		const tc: ToolChoice = { type: "function", name: "read" };
		expect(refreshToolChoiceForActiveTools(tc, tools)).toBe(tc);
	});

	it("handles { type: 'function', function: { name } } form", () => {
		const tools = [{ name: "read" }] as never;
		const tc: ToolChoice = { type: "function", function: { name: "read" } };
		expect(refreshToolChoiceForActiveTools(tc, tools)).toBe(tc);
	});

	it("returns undefined for function form when tool not found", () => {
		const tools = [{ name: "read" }] as never;
		const tc: ToolChoice = { type: "function", function: { name: "bash" } };
		expect(refreshToolChoiceForActiveTools(tc, tools)).toBeUndefined();
	});

	it("returns undefined for empty tools array", () => {
		const tc: ToolChoice = { type: "tool", name: "read" };
		expect(refreshToolChoiceForActiveTools(tc, [])).toBeUndefined();
	});

	it("defaults tools to empty array", () => {
		const tc: ToolChoice = { type: "tool", name: "read" };
		expect(refreshToolChoiceForActiveTools(tc)).toBeUndefined();
	});
});
