import { describe, expect, it } from "bun:test";
import type { AssistantMessage, TextContent } from "../src/types";
import {
	assistantText,
	assistantTextBlocks,
	assistantTextBlocksFromUnknown,
	assistantTextFromUnknown,
} from "../src/utils/message-text";
import {
	isForcedToolChoice,
	mapToOpenAICompletionsToolChoice,
	mapToOpenAIResponsesToolChoice,
} from "../src/utils/tool-choice";

function makeMessage(content: AssistantMessage["content"]): Pick<AssistantMessage, "content"> {
	return { content };
}

describe("mapToOpenAICompletionsToolChoice", () => {
	it("returns undefined for undefined", () => {
		expect(mapToOpenAICompletionsToolChoice(undefined)).toBeUndefined();
	});
	it("maps any to required", () => {
		expect(mapToOpenAICompletionsToolChoice("any")).toBe("required");
	});
	it("maps auto", () => {
		expect(mapToOpenAICompletionsToolChoice("auto")).toBe("auto");
	});
	it("maps none", () => {
		expect(mapToOpenAICompletionsToolChoice("none")).toBe("none");
	});
	it("maps required", () => {
		expect(mapToOpenAICompletionsToolChoice("required")).toBe("required");
	});
	it("maps tool choice with name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "tool", name: "my-tool" })).toEqual({
			type: "function",
			function: { name: "my-tool" },
		});
	});
	it("maps function choice with function.name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "function", function: { name: "my-fn" } })).toEqual({
			type: "function",
			function: { name: "my-fn" },
		});
	});
	it("maps function choice with name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "function", name: "my-fn" } as never)).toEqual({
			type: "function",
			function: { name: "my-fn" },
		});
	});
	it("returns undefined for tool without name", () => {
		expect(mapToOpenAICompletionsToolChoice({ type: "tool", name: "" } as never)).toBeUndefined();
	});
});

describe("mapToOpenAIResponsesToolChoice", () => {
	it("returns undefined for undefined", () => {
		expect(mapToOpenAIResponsesToolChoice(undefined)).toBeUndefined();
	});
	it("maps any to required", () => {
		expect(mapToOpenAIResponsesToolChoice("any")).toBe("required");
	});
	it("maps auto", () => {
		expect(mapToOpenAIResponsesToolChoice("auto")).toBe("auto");
	});
	it("maps none", () => {
		expect(mapToOpenAIResponsesToolChoice("none")).toBe("none");
	});
	it("maps required", () => {
		expect(mapToOpenAIResponsesToolChoice("required")).toBe("required");
	});
	it("maps tool choice with name", () => {
		expect(mapToOpenAIResponsesToolChoice({ type: "tool", name: "my-tool" })).toEqual({
			type: "function",
			name: "my-tool",
		});
	});
	it("maps function choice with function.name", () => {
		expect(mapToOpenAIResponsesToolChoice({ type: "function", function: { name: "my-fn" } })).toEqual({
			type: "function",
			name: "my-fn",
		});
	});
	it("returns undefined for tool without name", () => {
		expect(mapToOpenAIResponsesToolChoice({ type: "tool", name: "" } as never)).toBeUndefined();
	});
});

describe("isForcedToolChoice", () => {
	it("returns false for undefined", () => {
		expect(isForcedToolChoice(undefined)).toBe(false);
	});
	it("returns false for auto", () => {
		expect(isForcedToolChoice("auto")).toBe(false);
	});
	it("returns false for none", () => {
		expect(isForcedToolChoice("none")).toBe(false);
	});
	it("returns true for required", () => {
		expect(isForcedToolChoice("required")).toBe(true);
	});
	it("returns true for any", () => {
		expect(isForcedToolChoice("any")).toBe(true);
	});
	it("returns true for object choice", () => {
		expect(isForcedToolChoice({ type: "function", function: { name: "x" } })).toBe(true);
	});
});

describe("assistantTextBlocks", () => {
	it("extracts text blocks from content", () => {
		const msg = makeMessage([
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "1", name: "tool", arguments: {} },
			{ type: "text", text: "world" },
		]);
		expect(assistantTextBlocks(msg)).toEqual(["hello", "world"]);
	});
	it("returns empty for no text blocks", () => {
		const msg = makeMessage([{ type: "toolCall", id: "1", name: "tool", arguments: {} }]);
		expect(assistantTextBlocks(msg)).toEqual([]);
	});
	it("returns empty for empty content", () => {
		expect(assistantTextBlocks(makeMessage([]))).toEqual([]);
	});
});

describe("assistantText", () => {
	it("joins text blocks with default separator", () => {
		const msg = makeMessage([
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		]);
		expect(assistantText(msg)).toBe("hello\nworld");
	});
	it("joins with custom separator", () => {
		const msg = makeMessage([
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		]);
		expect(assistantText(msg, " ")).toBe("hello world");
	});
	it("returns empty string for no text blocks", () => {
		expect(assistantText(makeMessage([]))).toBe("");
	});
	it("returns single text block", () => {
		const msg = makeMessage([{ type: "text", text: "only" } as TextContent]);
		expect(assistantText(msg)).toBe("only");
	});
});

describe("assistantTextBlocksFromUnknown", () => {
	it("extracts text blocks from array content", () => {
		const content = [{ type: "text", text: "hello" }, { type: "other" }, { type: "text", text: "world" }];
		expect(assistantTextBlocksFromUnknown(content)).toEqual(["hello", "world"]);
	});
	it("returns empty for non-array", () => {
		expect(assistantTextBlocksFromUnknown("string")).toEqual([]);
	});
	it("returns empty for null", () => {
		expect(assistantTextBlocksFromUnknown(null)).toEqual([]);
	});
	it("returns empty for undefined", () => {
		expect(assistantTextBlocksFromUnknown(undefined)).toEqual([]);
	});
	it("skips non-object entries", () => {
		expect(assistantTextBlocksFromUnknown([null, 42, "string", { type: "text", text: "ok" }])).toEqual(["ok"]);
	});
	it("skips entries with non-string text", () => {
		expect(assistantTextBlocksFromUnknown([{ type: "text", text: 123 }])).toEqual([]);
	});
	it("skips entries with wrong type", () => {
		expect(assistantTextBlocksFromUnknown([{ type: "image", text: "hello" }])).toEqual([]);
	});
});

describe("assistantTextFromUnknown", () => {
	it("joins text blocks with default separator", () => {
		const content = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(assistantTextFromUnknown(content)).toBe("a\nb");
	});
	it("joins with custom separator", () => {
		const content = [
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		];
		expect(assistantTextFromUnknown(content, " ")).toBe("a b");
	});
	it("returns empty string for non-array", () => {
		expect(assistantTextFromUnknown("string")).toBe("");
	});
	it("returns empty string for no text blocks", () => {
		expect(assistantTextFromUnknown([{ type: "other" }])).toBe("");
	});
});
