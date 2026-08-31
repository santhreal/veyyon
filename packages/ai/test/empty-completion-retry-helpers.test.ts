import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import {
	EMPTY_COMPLETION_BASE_DELAY_MS,
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	MAX_EMPTY_COMPLETION_RETRIES,
} from "../src/utils/empty-completion-retry";

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: { inputTokens: 0, outputTokens: 0 },
		stopReason: "stop",
		timestamp: 0,
	} as unknown as AssistantMessage;
}

describe("hasVisibleAssistantContent", () => {
	it("returns false for empty content array", () => {
		expect(hasVisibleAssistantContent(makeAssistant([]))).toBe(false);
	});

	it("returns true for text block with content", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "text", text: "hello" }]))).toBe(true);
	});

	it("returns false for text block with only whitespace", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "text", text: "   \n\t  " }]))).toBe(false);
	});

	it("returns false for empty text block", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "text", text: "" }]))).toBe(false);
	});

	it("returns true for toolCall block", () => {
		expect(
			hasVisibleAssistantContent(makeAssistant([{ type: "toolCall", id: "c1", name: "read", arguments: {} }])),
		).toBe(true);
	});

	it("returns true when text block precedes empty text block", () => {
		expect(
			hasVisibleAssistantContent(
				makeAssistant([
					{ type: "text", text: "real content" },
					{ type: "text", text: "" },
				]),
			),
		).toBe(true);
	});

	it("returns false for thinking blocks only", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "thinking", thinking: "thoughts" }]))).toBe(false);
	});

	it("returns true when toolCall follows whitespace-only text", () => {
		expect(
			hasVisibleAssistantContent(
				makeAssistant([
					{ type: "text", text: "   " },
					{ type: "toolCall", id: "c1", name: "read", arguments: {} },
				]),
			),
		).toBe(true);
	});

	it("returns false for redacted thinking blocks only", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "redactedThinking", data: "redacted" }]))).toBe(false);
	});

	it("returns true for text with single non-whitespace char", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "text", text: "x" }]))).toBe(true);
	});

	it("returns true for text with leading whitespace and content", () => {
		expect(hasVisibleAssistantContent(makeAssistant([{ type: "text", text: "  hello  " }]))).toBe(true);
	});
});

describe("MAX_EMPTY_COMPLETION_RETRIES", () => {
	it("is 2", () => {
		expect(MAX_EMPTY_COMPLETION_RETRIES).toBe(2);
	});

	it("is a positive integer", () => {
		expect(Number.isInteger(MAX_EMPTY_COMPLETION_RETRIES)).toBe(true);
		expect(MAX_EMPTY_COMPLETION_RETRIES).toBeGreaterThan(0);
	});
});

describe("EMPTY_COMPLETION_BASE_DELAY_MS", () => {
	it("is 500", () => {
		expect(EMPTY_COMPLETION_BASE_DELAY_MS).toBe(500);
	});

	it("is a positive integer", () => {
		expect(Number.isInteger(EMPTY_COMPLETION_BASE_DELAY_MS)).toBe(true);
		expect(EMPTY_COMPLETION_BASE_DELAY_MS).toBeGreaterThan(0);
	});
});

describe("EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE", () => {
	it("mentions Ollama num_ctx", () => {
		expect(EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE).toContain("num_ctx");
	});

	it("mentions context window", () => {
		expect(EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE).toContain("context window");
	});

	it("mentions raising num_ctx or shortening prompt", () => {
		expect(EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE).toContain("raise");
		expect(EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE).toContain("shorten");
	});
});
