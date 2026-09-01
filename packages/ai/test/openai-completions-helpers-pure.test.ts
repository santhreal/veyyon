import { describe, expect, it } from "bun:test";
import {
	DEEPSEEK_SPECIAL_TOKEN_REGEX,
	getTrailingPartialDeepseekToken,
	hasPositiveCacheReadTokenField,
	hasToolHistory,
	isOpenAICompletionsProgressChunk,
	normalizeStreamingContentText,
	serializeToolArguments,
	stripDeepseekSpecialTokens,
} from "../src/providers/openai-completions-helpers";
import type { Message } from "../src/types";

describe("hasPositiveCacheReadTokenField", () => {
	it("returns true for positive cached_tokens", () => {
		expect(hasPositiveCacheReadTokenField({ cached_tokens: 100 })).toBe(true);
	});
	it("returns true for positive prompt_cache_hit_tokens", () => {
		expect(hasPositiveCacheReadTokenField({ prompt_cache_hit_tokens: 50 })).toBe(true);
	});
	it("returns true for positive cached_tokens in prompt_tokens_details", () => {
		expect(hasPositiveCacheReadTokenField({ prompt_tokens_details: { cached_tokens: 200 } })).toBe(true);
	});
	it("returns false for zero cached_tokens", () => {
		expect(hasPositiveCacheReadTokenField({ cached_tokens: 0 })).toBe(false);
	});
	it("returns false for negative cached_tokens", () => {
		expect(hasPositiveCacheReadTokenField({ cached_tokens: -1 })).toBe(false);
	});
	it("returns false for missing fields", () => {
		expect(hasPositiveCacheReadTokenField({})).toBe(false);
	});
	it("returns false for null prompt_tokens_details", () => {
		expect(hasPositiveCacheReadTokenField({ prompt_tokens_details: null })).toBe(false);
	});
	it("returns false for zero in prompt_tokens_details", () => {
		expect(hasPositiveCacheReadTokenField({ prompt_tokens_details: { cached_tokens: 0 } })).toBe(false);
	});
});

describe("normalizeStreamingContentText", () => {
	it("returns string content as-is", () => {
		expect(normalizeStreamingContentText("hello")).toBe("hello");
	});
	it("concatenates string array parts", () => {
		expect(normalizeStreamingContentText(["hello", " ", "world"])).toBe("hello world");
	});
	it("extracts text from array of text objects", () => {
		expect(normalizeStreamingContentText([{ type: "text", text: "hello" }])).toBe("hello");
	});
	it("extracts text from object with undefined type", () => {
		expect(normalizeStreamingContentText({ text: "hello" })).toBe("hello");
	});
	it("extracts text from object with text type", () => {
		expect(normalizeStreamingContentText({ type: "text", text: "hello" })).toBe("hello");
	});
	it("returns empty string for non-text object type", () => {
		expect(normalizeStreamingContentText({ type: "image", text: "hello" })).toBe("");
	});
	it("returns empty string for null", () => {
		expect(normalizeStreamingContentText(null)).toBe("");
	});
	it("returns empty string for undefined", () => {
		expect(normalizeStreamingContentText(undefined)).toBe("");
	});
	it("returns empty string for number", () => {
		expect(normalizeStreamingContentText(42)).toBe("");
	});
	it("handles mixed array of strings and objects", () => {
		expect(normalizeStreamingContentText(["hello", { type: "text", text: "world" }])).toBe("helloworld");
	});
	it("skips non-text objects in array", () => {
		expect(normalizeStreamingContentText([{ type: "image", url: "x" }, { text: "hello" }])).toBe("hello");
	});
});

describe("serializeToolArguments", () => {
	it("serializes object to JSON string", () => {
		expect(serializeToolArguments({ key: "value" })).toBe('{"key":"value"}');
	});
	it("serializes empty object", () => {
		expect(serializeToolArguments({})).toBe("{}");
	});
	it("serializes valid JSON string", () => {
		expect(serializeToolArguments('{"key":"value"}')).toBe('{"key":"value"}');
	});
	it("returns {} for empty string", () => {
		expect(serializeToolArguments("")).toBe("{}");
	});
	it("returns {} for whitespace-only string", () => {
		expect(serializeToolArguments("   ")).toBe("{}");
	});
	it("returns {} for invalid JSON string", () => {
		expect(serializeToolArguments("invalid json")).toBe("{}");
	});
	it("returns {} for null", () => {
		expect(serializeToolArguments(null)).toBe("{}");
	});
	it("returns {} for undefined", () => {
		expect(serializeToolArguments(undefined)).toBe("{}");
	});
	it("returns {} for number", () => {
		expect(serializeToolArguments(42)).toBe("{}");
	});
	it("returns {} for array", () => {
		expect(serializeToolArguments([1, 2, 3])).toBe("{}");
	});
	it("serializes nested objects", () => {
		expect(serializeToolArguments({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
	});
});

describe("hasToolHistory", () => {
	it("returns false for empty messages", () => {
		expect(hasToolHistory([])).toBe(false);
	});
	it("returns true when toolResult message exists", () => {
		const messages = [{ role: "toolResult", toolCallId: "1", content: [] }] as unknown as Message[];
		expect(hasToolHistory(messages)).toBe(true);
	});
	it("returns true when assistant message has toolCall block", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "test", arguments: {} }] },
		] as unknown as Message[];
		expect(hasToolHistory(messages)).toBe(true);
	});
	it("returns false when no tool-related messages", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		] as unknown as Message[];
		expect(hasToolHistory(messages)).toBe(false);
	});
	it("returns true even if tool message is later in array", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "toolResult", toolCallId: "1", content: [] },
		] as unknown as Message[];
		expect(hasToolHistory(messages)).toBe(true);
	});
});

describe("isOpenAICompletionsProgressChunk", () => {
	it("returns false for null", () => {
		expect(isOpenAICompletionsProgressChunk(null)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(isOpenAICompletionsProgressChunk("string")).toBe(false);
	});
	it("returns false for empty object", () => {
		expect(isOpenAICompletionsProgressChunk({})).toBe(false);
	});
	it("returns true when usage is present", () => {
		expect(isOpenAICompletionsProgressChunk({ usage: {} })).toBe(true);
	});
	it("returns true when finish_reason is present", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ finish_reason: "stop" }] })).toBe(true);
	});
	it("returns true when choice has usage", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ usage: {} }] })).toBe(true);
	});
	it("returns true when delta has string content", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { content: "hello" } }] })).toBe(true);
	});
	it("returns true when delta has array content", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { content: ["hello"] } }] })).toBe(true);
	});
	it("returns true when delta has tool_calls", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { tool_calls: [{}] } }] })).toBe(true);
	});
	it("returns true when delta has reasoning", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { reasoning: "thinking" } }] })).toBe(true);
	});
	it("returns true when delta has reasoning_content", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { reasoning_content: "thinking" } }] })).toBe(true);
	});
	it("returns true when delta has reasoning_text", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { reasoning_text: "thinking" } }] })).toBe(true);
	});
	it("returns true when delta has refusal", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { refusal: "no" } }] })).toBe(true);
	});
	it("returns false when delta has empty content", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { content: "" } }] })).toBe(false);
	});
	it("returns false when delta has empty tool_calls", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { tool_calls: [] } }] })).toBe(false);
	});
	it("returns false when choices is empty array", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [] })).toBe(false);
	});
	it("returns false when choices is not array", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: "not array" })).toBe(false);
	});
});

describe("stripDeepseekSpecialTokens", () => {
	it("returns text unchanged when no special tokens", () => {
		expect(stripDeepseekSpecialTokens("hello world")).toBe("hello world");
	});
	it("strips <｜begin▁of▁sentence｜> tokens", () => {
		expect(stripDeepseekSpecialTokens("<｜begin▁of▁sentence｜>hello")).toBe("hello");
	});
	it("strips <|pipe|> style tokens", () => {
		expect(stripDeepseekSpecialTokens("<|im_start|>hello")).toBe("hello");
	});
	it("strips end tokens and trailing whitespace", () => {
		expect(stripDeepseekSpecialTokens("hello<｜end▁of▁sentence｜>  ")).toBe("hello");
	});
	it("strips start tokens and leading whitespace", () => {
		expect(stripDeepseekSpecialTokens("  <｜begin▁of▁sentence｜>hello")).toBe("hello");
	});
	it("handles empty string", () => {
		expect(stripDeepseekSpecialTokens("")).toBe("");
	});
	it("handles text with only special tokens", () => {
		expect(stripDeepseekSpecialTokens("<｜begin▁of▁sentence｜>")).toBe("");
	});
	it("strips multiple tokens", () => {
		expect(stripDeepseekSpecialTokens("<｜begin▁of▁sentence｜>hello<｜end▁of▁sentence｜>")).toBe("hello");
	});
});

describe("getTrailingPartialDeepseekToken", () => {
	it("returns empty string when no delimiter", () => {
		expect(getTrailingPartialDeepseekToken("hello world")).toBe("");
	});
	it("returns '<' when text ends with '<'", () => {
		expect(getTrailingPartialDeepseekToken("hello<")).toBe("<");
	});
	it("returns partial token after delimiter", () => {
		expect(getTrailingPartialDeepseekToken("hello<｜begin")).toBe("<｜begin");
	});
	it("returns partial token after pipe delimiter", () => {
		expect(getTrailingPartialDeepseekToken("hello<|im")).toBe("<|im");
	});
	it("returns empty string when token is complete with ｜>", () => {
		expect(getTrailingPartialDeepseekToken("hello<｜token｜>")).toBe("");
	});
	it("returns empty string when token is complete with |>", () => {
		expect(getTrailingPartialDeepseekToken("hello<|token|>")).toBe("");
	});
	it("returns empty string when partial is too long (>256 chars)", () => {
		const longPartial = `<｜${"a".repeat(260)}`;
		expect(getTrailingPartialDeepseekToken(longPartial)).toBe("");
	});
	it("handles empty string", () => {
		expect(getTrailingPartialDeepseekToken("")).toBe("");
	});
});

describe("DEEPSEEK_SPECIAL_TOKEN_REGEX", () => {
	it("matches full-width pipe tokens", () => {
		DEEPSEEK_SPECIAL_TOKEN_REGEX.lastIndex = 0;
		expect(DEEPSEEK_SPECIAL_TOKEN_REGEX.test("<｜token｜>")).toBe(true);
	});
	it("matches half-width pipe tokens", () => {
		DEEPSEEK_SPECIAL_TOKEN_REGEX.lastIndex = 0;
		expect(DEEPSEEK_SPECIAL_TOKEN_REGEX.test("<|token|>")).toBe(true);
	});
	it("does not match non-token text", () => {
		DEEPSEEK_SPECIAL_TOKEN_REGEX.lastIndex = 0;
		expect(DEEPSEEK_SPECIAL_TOKEN_REGEX.test("hello world")).toBe(false);
	});
});
