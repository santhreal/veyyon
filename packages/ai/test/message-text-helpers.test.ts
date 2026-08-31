import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../src/types";
import {
	assistantText,
	assistantTextBlocks,
	assistantTextBlocksFromUnknown,
	assistantTextFromUnknown,
} from "../src/utils/message-text";

function msg(content: AssistantMessage["content"]): Pick<AssistantMessage, "content"> {
	return { content };
}

describe("assistantTextBlocks", () => {
	it("returns text from text blocks", () => {
		expect(
			assistantTextBlocks(
				msg([
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				]),
			),
		).toEqual(["hello", "world"]);
	});
	it("filters out non-text blocks", () => {
		expect(
			assistantTextBlocks(
				msg([
					{ type: "thinking", thinking: "thoughts" },
					{ type: "text", text: "response" },
					{ type: "toolCall", id: "1", name: "read", arguments: "{}" },
				]),
			),
		).toEqual(["response"]);
	});
	it("returns empty array for empty content", () => {
		expect(assistantTextBlocks(msg([]))).toEqual([]);
	});
	it("returns empty array for no text blocks", () => {
		expect(assistantTextBlocks(msg([{ type: "thinking", thinking: "thoughts" }]))).toEqual([]);
	});
});

describe("assistantText", () => {
	it("joins text blocks with default separator", () => {
		expect(
			assistantText(
				msg([
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				]),
			),
		).toBe("hello\nworld");
	});
	it("joins with custom separator", () => {
		expect(
			assistantText(
				msg([
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				]),
				" ",
			),
		).toBe("hello world");
	});
	it("returns empty string for no text blocks", () => {
		expect(assistantText(msg([]))).toBe("");
	});
	it("returns single text block content", () => {
		expect(assistantText(msg([{ type: "text", text: "only" }]))).toBe("only");
	});
});

describe("assistantTextBlocksFromUnknown", () => {
	it("returns empty array for non-array", () => {
		expect(assistantTextBlocksFromUnknown("string")).toEqual([]);
		expect(assistantTextBlocksFromUnknown(42)).toEqual([]);
		expect(assistantTextBlocksFromUnknown(null)).toEqual([]);
		expect(assistantTextBlocksFromUnknown(undefined)).toEqual([]);
		expect(assistantTextBlocksFromUnknown({})).toEqual([]);
	});
	it("returns empty array for empty array", () => {
		expect(assistantTextBlocksFromUnknown([])).toEqual([]);
	});
	it("extracts text from valid blocks", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		).toEqual(["hello", "world"]);
	});
	it("skips null and non-object blocks", () => {
		expect(assistantTextBlocksFromUnknown([null, 42, "string", { type: "text", text: "valid" }])).toEqual(["valid"]);
	});
	it("skips blocks with wrong type", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "thinking", thinking: "thoughts" },
				{ type: "text", text: "valid" },
			]),
		).toEqual(["valid"]);
	});
	it("skips blocks with non-string text", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "text", text: 42 },
				{ type: "text", text: "valid" },
			]),
		).toEqual(["valid"]);
	});
	it("skips blocks without type property", () => {
		expect(assistantTextBlocksFromUnknown([{ text: "no type" }, { type: "text", text: "valid" }])).toEqual(["valid"]);
	});
});

describe("assistantTextFromUnknown", () => {
	it("joins text blocks with default separator", () => {
		expect(
			assistantTextFromUnknown([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		).toBe("hello\nworld");
	});
	it("joins with custom separator", () => {
		expect(
			assistantTextFromUnknown(
				[
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
				" | ",
			),
		).toBe("hello | world");
	});
	it("returns empty string for non-array", () => {
		expect(assistantTextFromUnknown("string")).toBe("");
	});
	it("returns empty string for empty array", () => {
		expect(assistantTextFromUnknown([])).toBe("");
	});
});
