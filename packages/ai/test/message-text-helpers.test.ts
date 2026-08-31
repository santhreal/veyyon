import { describe, expect, it } from "bun:test";
import {
	assistantText,
	assistantTextBlocks,
	assistantTextBlocksFromUnknown,
	assistantTextFromUnknown,
} from "../src/utils/message-text";

describe("assistantTextBlocks", () => {
	it("returns text from text blocks", () => {
		expect(
			assistantTextBlocks({
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
			}),
		).toEqual(["hello", "world"]);
	});

	it("filters out non-text blocks", () => {
		expect(
			assistantTextBlocks({
				content: [
					{ type: "text", text: "hello" },
					{ type: "thinking", text: "thinking..." } as never,
					{ type: "text", text: "world" },
				],
			}),
		).toEqual(["hello", "world"]);
	});

	it("returns empty array for empty content", () => {
		expect(assistantTextBlocks({ content: [] })).toEqual([]);
	});

	it("returns empty array for content with no text blocks", () => {
		expect(assistantTextBlocks({ content: [{ type: "thinking", text: "hmm" } as never] })).toEqual([]);
	});
});

describe("assistantText", () => {
	it("joins text blocks with newline separator by default", () => {
		expect(
			assistantText({
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
			}),
		).toBe("hello\nworld");
	});

	it("joins with custom separator", () => {
		expect(
			assistantText(
				{
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
				" ",
			),
		).toBe("a b");
	});

	it("returns empty string for empty content", () => {
		expect(assistantText({ content: [] })).toBe("");
	});

	it("returns single text block without separator", () => {
		expect(assistantText({ content: [{ type: "text", text: "only" }] })).toBe("only");
	});

	it("returns empty string when no text blocks", () => {
		expect(assistantText({ content: [{ type: "thinking", text: "hmm" } as never] })).toBe("");
	});
});

describe("assistantTextBlocksFromUnknown", () => {
	it("returns text blocks from valid content array", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
			]),
		).toEqual(["hello", "world"]);
	});

	it("returns empty array for non-array input", () => {
		expect(assistantTextBlocksFromUnknown("string")).toEqual([]);
		expect(assistantTextBlocksFromUnknown(42)).toEqual([]);
		expect(assistantTextBlocksFromUnknown(null)).toEqual([]);
		expect(assistantTextBlocksFromUnknown(undefined)).toEqual([]);
		expect(assistantTextBlocksFromUnknown({})).toEqual([]);
	});

	it("returns empty array for empty array input", () => {
		expect(assistantTextBlocksFromUnknown([])).toEqual([]);
	});

	it("skips null and non-object blocks", () => {
		expect(assistantTextBlocksFromUnknown([null, 42, "string", { type: "text", text: "hello" }])).toEqual(["hello"]);
	});

	it("skips blocks without type: text", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "hello" },
			]),
		).toEqual(["hello"]);
	});

	it("skips blocks where text is not a string", () => {
		expect(
			assistantTextBlocksFromUnknown([
				{ type: "text", text: 123 },
				{ type: "text", text: "hello" },
			]),
		).toEqual(["hello"]);
	});

	it("skips blocks without type property", () => {
		expect(assistantTextBlocksFromUnknown([{ text: "no type" }, { type: "text", text: "hello" }])).toEqual(["hello"]);
	});

	it("skips blocks without text property", () => {
		expect(assistantTextBlocksFromUnknown([{ type: "text" }, { type: "text", text: "hello" }])).toEqual(["hello"]);
	});
});

describe("assistantTextFromUnknown", () => {
	it("joins text blocks with newline separator by default", () => {
		expect(
			assistantTextFromUnknown([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});

	it("joins with custom separator", () => {
		expect(
			assistantTextFromUnknown(
				[
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
				" | ",
			),
		).toBe("a | b");
	});

	it("returns empty string for non-array input", () => {
		expect(assistantTextFromUnknown(null)).toBe("");
		expect(assistantTextFromUnknown("string")).toBe("");
	});

	it("returns empty string for empty array", () => {
		expect(assistantTextFromUnknown([])).toBe("");
	});

	it("returns single text block", () => {
		expect(assistantTextFromUnknown([{ type: "text", text: "only" }])).toBe("only");
	});

	it("returns empty string when no valid text blocks", () => {
		expect(assistantTextFromUnknown([{ type: "thinking", text: "hmm" }])).toBe("");
	});
});
