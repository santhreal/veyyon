import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import { stopReasonForTerminallessEof } from "../src/utils/terminalless-eof";

function textBlock(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

function thinkingBlock(thinking: string): { type: "thinking"; thinking: string } {
	return { type: "thinking", thinking };
}

function toolCallBlock(id: string, name: string): { type: "toolCall"; id: string; name: string; arguments: Readonly<Record<string, unknown>> } {
	return { type: "toolCall", id, name, arguments: {} };
}

describe("stopReasonForTerminallessEof", () => {
	it("returns toolUse when tool calls present and batch is complete", () => {
		const content: AssistantMessage["content"] = [toolCallBlock("1", "read")];
		expect(stopReasonForTerminallessEof(content, true)).toBe("toolUse");
	});
	it("returns undefined when tool calls present but batch is not complete", () => {
		const content: AssistantMessage["content"] = [toolCallBlock("1", "read")];
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("returns stop when text block has non-whitespace content", () => {
		const content: AssistantMessage["content"] = [textBlock("hello world")];
		expect(stopReasonForTerminallessEof(content, false)).toBe("stop");
	});
	it("returns stop when text block has content even with tool batch complete", () => {
		const content: AssistantMessage["content"] = [textBlock("hello")];
		expect(stopReasonForTerminallessEof(content, true)).toBe("stop");
	});
	it("returns length when only thinking block has content", () => {
		const content: AssistantMessage["content"] = [thinkingBlock("deep thoughts")];
		expect(stopReasonForTerminallessEof(content, false)).toBe("length");
	});
	it("returns undefined for empty content", () => {
		const content: AssistantMessage["content"] = [];
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("returns undefined for whitespace-only text", () => {
		const content: AssistantMessage["content"] = [textBlock("   \n\t  ")];
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("returns undefined for whitespace-only thinking", () => {
		const content: AssistantMessage["content"] = [thinkingBlock("   ")];
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("returns undefined for empty text and empty thinking", () => {
		const content: AssistantMessage["content"] = [textBlock(""), thinkingBlock("")];
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("tool calls take priority over text", () => {
		const content: AssistantMessage["content"] = [textBlock("hello"), toolCallBlock("1", "read")];
		expect(stopReasonForTerminallessEof(content, true)).toBe("toolUse");
	});
	it("text takes priority over thinking", () => {
		const content: AssistantMessage["content"] = [thinkingBlock("thoughts"), textBlock("response")];
		expect(stopReasonForTerminallessEof(content, false)).toBe("stop");
	});
});
