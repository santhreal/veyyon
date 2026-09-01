import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import {
	EMPTY_COMPLETION_BASE_DELAY_MS,
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	MAX_EMPTY_COMPLETION_RETRIES,
} from "../src/utils/empty-completion-retry";

function msg(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content } as AssistantMessage;
}

describe("constants", () => {
	it("MAX_EMPTY_COMPLETION_RETRIES is 2", () => {
		expect(MAX_EMPTY_COMPLETION_RETRIES).toBe(2);
	});
	it("EMPTY_COMPLETION_BASE_DELAY_MS is 500", () => {
		expect(EMPTY_COMPLETION_BASE_DELAY_MS).toBe(500);
	});
	it("EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE mentions num_ctx", () => {
		expect(EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE).toContain("num_ctx");
	});
});

describe("hasVisibleAssistantContent", () => {
	it("returns false for empty content", () => {
		expect(hasVisibleAssistantContent(msg([]))).toBe(false);
	});
	it("returns true for text with non-whitespace content", () => {
		expect(hasVisibleAssistantContent(msg([{ type: "text", text: "hello" }]))).toBe(true);
	});
	it("returns false for whitespace-only text", () => {
		expect(hasVisibleAssistantContent(msg([{ type: "text", text: "   \n\t  " }]))).toBe(false);
	});
	it("returns false for empty text", () => {
		expect(hasVisibleAssistantContent(msg([{ type: "text", text: "" }]))).toBe(false);
	});
	it("returns true for tool call", () => {
		expect(hasVisibleAssistantContent(msg([{ type: "toolCall", id: "1", name: "read", arguments: {} }]))).toBe(
			true,
		);
	});
	it("returns false for thinking-only content", () => {
		expect(hasVisibleAssistantContent(msg([{ type: "thinking", thinking: "deep thoughts" }]))).toBe(false);
	});
	it("returns true when text and thinking are mixed with visible text", () => {
		expect(
			hasVisibleAssistantContent(
				msg([
					{ type: "thinking", thinking: "thoughts" },
					{ type: "text", text: "response" },
				]),
			),
		).toBe(true);
	});
	it("returns false when thinking has content but text is whitespace", () => {
		expect(
			hasVisibleAssistantContent(
				msg([
					{ type: "thinking", thinking: "thoughts" },
					{ type: "text", text: "  " },
				]),
			),
		).toBe(false);
	});
	it("returns true for tool call even with empty text", () => {
		expect(
			hasVisibleAssistantContent(
				msg([
					{ type: "text", text: "" },
				{ type: "toolCall", id: "1", name: "write", arguments: {} },
				]),
			),
		).toBe(true);
	});
});
