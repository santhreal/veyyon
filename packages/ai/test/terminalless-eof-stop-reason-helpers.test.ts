import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import { stopReasonForTerminallessEof } from "../src/utils/terminalless-eof";

function makeContent(blocks: Array<{ type: string; text?: string; thinking?: string }>): AssistantMessage["content"] {
	return blocks as AssistantMessage["content"];
}

describe("stopReasonForTerminallessEof", () => {
	it("returns 'toolUse' when has tool calls and batch is complete", () => {
		const content = makeContent([{ type: "toolCall" }]);
		expect(stopReasonForTerminallessEof(content, true)).toBe("toolUse");
	});
	it("returns undefined when has tool calls but batch is not complete", () => {
		const content = makeContent([{ type: "toolCall" }]);
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("returns 'stop' when has text content", () => {
		const content = makeContent([{ type: "text", text: "hello world" }]);
		expect(stopReasonForTerminallessEof(content, true)).toBe("stop");
	});
	it("returns 'stop' when has text content (batch irrelevant)", () => {
		const content = makeContent([{ type: "text", text: "hello world" }]);
		expect(stopReasonForTerminallessEof(content, false)).toBe("stop");
	});
	it("returns 'length' when only thinking content with text", () => {
		const content = makeContent([{ type: "thinking", thinking: "deep thoughts" }]);
		expect(stopReasonForTerminallessEof(content, true)).toBe("length");
	});
	it("returns undefined for empty content", () => {
		const content = makeContent([]);
		expect(stopReasonForTerminallessEof(content, true)).toBeUndefined();
	});
	it("returns undefined for text with only whitespace", () => {
		const content = makeContent([{ type: "text", text: "   " }]);
		expect(stopReasonForTerminallessEof(content, true)).toBeUndefined();
	});
	it("returns undefined for thinking with only whitespace", () => {
		const content = makeContent([{ type: "thinking", thinking: "  " }]);
		expect(stopReasonForTerminallessEof(content, true)).toBeUndefined();
	});
	it("returns 'stop' when text and thinking both present", () => {
		const content = makeContent([
			{ type: "thinking", thinking: "thoughts" },
			{ type: "text", text: "answer" },
		]);
		expect(stopReasonForTerminallessEof(content, true)).toBe("stop");
	});
	it("returns 'toolUse' when tool calls and text both present, batch complete", () => {
		const content = makeContent([{ type: "text", text: "calling tool" }, { type: "toolCall" }]);
		expect(stopReasonForTerminallessEof(content, true)).toBe("toolUse");
	});
	it("returns undefined when tool calls and text both present, batch not complete", () => {
		const content = makeContent([{ type: "text", text: "calling tool" }, { type: "toolCall" }]);
		expect(stopReasonForTerminallessEof(content, false)).toBeUndefined();
	});
	it("returns 'length' for thinking with whitespace text block", () => {
		const content = makeContent([
			{ type: "text", text: "  " },
			{ type: "thinking", thinking: "thoughts" },
		]);
		expect(stopReasonForTerminallessEof(content, true)).toBe("length");
	});
	it("returns undefined for empty text and empty thinking", () => {
		const content = makeContent([
			{ type: "text", text: "" },
			{ type: "thinking", thinking: "" },
		]);
		expect(stopReasonForTerminallessEof(content, true)).toBeUndefined();
	});
});
