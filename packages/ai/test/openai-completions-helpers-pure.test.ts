import { describe, expect, it } from "bun:test";
import {
	DEEPSEEK_OPEN_DELIMS,
	DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX,
	DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX,
	DEEPSEEK_SPECIAL_TOKEN_REGEX,
	getTrailingPartialDeepseekToken,
	hasPositiveCacheReadTokenField,
	hasToolHistory,
	isOpenAICompletionsProgressChunk,
	mergeStreamingArgumentObjects,
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
		expect(hasPositiveCacheReadTokenField({ prompt_tokens_details: { cached_tokens: 10 } })).toBe(true);
	});
	it("returns false for zero cached_tokens", () => {
		expect(hasPositiveCacheReadTokenField({ cached_tokens: 0 })).toBe(false);
	});
	it("returns false for undefined fields", () => {
		expect(hasPositiveCacheReadTokenField({})).toBe(false);
	});
	it("returns false for null prompt_tokens_details", () => {
		expect(hasPositiveCacheReadTokenField({ prompt_tokens_details: null })).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(hasPositiveCacheReadTokenField("string" as unknown as object)).toBe(false);
	});
});

describe("normalizeStreamingContentText", () => {
	it("returns string content directly", () => {
		expect(normalizeStreamingContentText("hello")).toBe("hello");
	});
	it("concatenates string array", () => {
		expect(normalizeStreamingContentText(["a", "b", "c"])).toBe("abc");
	});
	it("extracts text from array of objects", () => {
		expect(normalizeStreamingContentText([{ type: "text", text: "hello" }])).toBe("hello");
	});
	it("extracts text from object with undefined type", () => {
		expect(normalizeStreamingContentText({ text: "hello" })).toBe("hello");
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
	it("ignores non-text type objects", () => {
		expect(normalizeStreamingContentText([{ type: "image", text: "hello" }])).toBe("");
	});
	it("handles mixed array", () => {
		expect(normalizeStreamingContentText(["a", { type: "text", text: "b" }, 42])).toBe("ab");
	});
});

describe("serializeToolArguments", () => {
	it("serializes object to JSON", () => {
		expect(serializeToolArguments({ a: 1 })).toBe('{"a":1}');
	});
	it("serializes valid JSON string", () => {
		expect(serializeToolArguments('{"a":1}')).toBe('{"a":1}');
	});
	it("returns {} for empty string", () => {
		expect(serializeToolArguments("")).toBe("{}");
	});
	it("returns {} for whitespace-only string", () => {
		expect(serializeToolArguments("   ")).toBe("{}");
	});
	it("returns {} for invalid JSON string", () => {
		expect(serializeToolArguments("not json")).toBe("{}");
	});
	it("returns {} for undefined", () => {
		expect(serializeToolArguments(undefined)).toBe("{}");
	});
	it("returns {} for null", () => {
		expect(serializeToolArguments(null)).toBe("{}");
	});
	it("returns {} for number", () => {
		expect(serializeToolArguments(42)).toBe("{}");
	});
	it("returns {} for array", () => {
		expect(serializeToolArguments([1, 2])).toBe("{}");
	});
});

describe("hasToolHistory", () => {
	it("returns false for empty messages", () => {
		expect(hasToolHistory([])).toBe(false);
	});
	it("returns true for toolResult message", () => {
		const messages: Message[] = [{ role: "toolResult", toolCallId: "1", content: [] }];
		expect(hasToolHistory(messages)).toBe(true);
	});
	it("returns true for assistant with toolCall", () => {
		const messages: Message[] = [
			{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "test", input: {} }] },
		] as Message[];
		expect(hasToolHistory(messages)).toBe(true);
	});
	it("returns false for assistant with only text", () => {
		const messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "hello" }] }] as Message[];
		expect(hasToolHistory(messages)).toBe(false);
	});
	it("returns false for user-only messages", () => {
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as Message[];
		expect(hasToolHistory(messages)).toBe(false);
	});
});

describe("isOpenAICompletionsProgressChunk", () => {
	it("returns false for null", () => {
		expect(isOpenAICompletionsProgressChunk(null)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(isOpenAICompletionsProgressChunk("string")).toBe(false);
	});
	it("returns true for chunk with usage", () => {
		expect(isOpenAICompletionsProgressChunk({ usage: { prompt_tokens: 10 } })).toBe(true);
	});
	it("returns true for chunk with finish_reason", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ finish_reason: "stop" }] })).toBe(true);
	});
	it("returns true for chunk with content string", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { content: "hello" } }] })).toBe(true);
	});
	it("returns true for chunk with tool_calls", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { tool_calls: [{ id: "1" }] } }] })).toBe(true);
	});
	it("returns true for chunk with reasoning", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { reasoning: "thinking" } }] })).toBe(true);
	});
	it("returns true for chunk with reasoning_content", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { reasoning_content: "thinking" } }] })).toBe(true);
	});
	it("returns true for chunk with refusal", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { refusal: "no" } }] })).toBe(true);
	});
	it("returns false for chunk with empty choices", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [] })).toBe(false);
	});
	it("returns false for chunk with empty content", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{ delta: { content: "" } }] })).toBe(false);
	});
	it("returns false for chunk with no delta", () => {
		expect(isOpenAICompletionsProgressChunk({ choices: [{}] })).toBe(false);
	});
	it("returns false for empty object", () => {
		expect(isOpenAICompletionsProgressChunk({})).toBe(false);
	});
});

describe("mergeStreamingArgumentObjects", () => {
	it("returns fragment when prev is undefined", () => {
		expect(mergeStreamingArgumentObjects(undefined, { a: 1 })).toEqual({ a: 1 });
	});
	it("merges prev and fragment", () => {
		expect(mergeStreamingArgumentObjects({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
	});
	it("overrides prev keys with fragment keys", () => {
		expect(mergeStreamingArgumentObjects({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
	});
	it("ignores __proto__ key", () => {
		expect(mergeStreamingArgumentObjects({ __proto__: 1 }, { a: 1 })).toEqual({ a: 1 });
	});
	it("ignores constructor key", () => {
		expect(mergeStreamingArgumentObjects({ constructor: 1 }, { a: 1 })).toEqual({ a: 1 });
	});
	it("ignores prototype key", () => {
		expect(mergeStreamingArgumentObjects({ prototype: 1 }, { a: 1 })).toEqual({ a: 1 });
	});
	it("deep merges arrays for same key", () => {
		const result = mergeStreamingArgumentObjects({ items: [1, 2] }, { items: [3] });
		expect(result.items).toEqual([1, 2, 3]);
	});
});

describe("DEEPSEEK_SPECIAL_TOKEN_REGEX", () => {
	it("matches <｜begin▁of▁sentence｜>", () => {
		expect("<｜begin▁of▁sentence｜>".match(DEEPSEEK_SPECIAL_TOKEN_REGEX) !== null).toBe(true);
	});
	it("matches <|token|>", () => {
		expect("<|token|>".match(DEEPSEEK_SPECIAL_TOKEN_REGEX) !== null).toBe(true);
	});
	it("does not match regular text", () => {
		expect(DEEPSEEK_SPECIAL_TOKEN_REGEX.test("hello world")).toBe(false);
	});
});

describe("DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX", () => {
	it("matches token at start of string", () => {
		expect(DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test("<｜token｜>hello")).toBe(true);
	});
	it("does not match token in middle", () => {
		expect(DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test("hello<｜token｜>")).toBe(false);
	});
});

describe("DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX", () => {
	it("matches token at end of string", () => {
		expect(DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test("hello<｜token｜>")).toBe(true);
	});
	it("does not match token at start", () => {
		expect(DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test("<｜token｜>hello")).toBe(false);
	});
});

describe("DEEPSEEK_OPEN_DELIMS", () => {
	it("contains <｜", () => {
		expect(DEEPSEEK_OPEN_DELIMS).toContain("<｜");
	});
	it("contains <|", () => {
		expect(DEEPSEEK_OPEN_DELIMS).toContain("<|");
	});
});

describe("stripDeepseekSpecialTokens", () => {
	it("removes special tokens from text", () => {
		expect(stripDeepseekSpecialTokens("hello<｜token｜>world")).toBe("helloworld");
	});
	it("removes special tokens and leading whitespace when token at start", () => {
		expect(stripDeepseekSpecialTokens("  <｜token｜>hello")).toBe("hello");
	});
	it("removes special tokens and trailing whitespace when token at end", () => {
		expect(stripDeepseekSpecialTokens("hello<｜token｜>  ")).toBe("hello");
	});
	it("returns text unchanged when no special tokens", () => {
		expect(stripDeepseekSpecialTokens("hello world")).toBe("hello world");
	});
	it("handles empty string", () => {
		expect(stripDeepseekSpecialTokens("")).toBe("");
	});
});

describe("getTrailingPartialDeepseekToken", () => {
	it("returns empty string when no delimiter found", () => {
		expect(getTrailingPartialDeepseekToken("hello world")).toBe("");
	});
	it("returns '<' when text ends with '<'", () => {
		expect(getTrailingPartialDeepseekToken("hello<")).toBe("<");
	});
	it("returns partial token from last delimiter", () => {
		expect(getTrailingPartialDeepseekToken("hello<｜token")).toBe("<｜token");
	});
	it("returns empty string when complete token found", () => {
		expect(getTrailingPartialDeepseekToken("hello<｜token｜>")).toBe("");
	});
	it("returns empty string for very long tail", () => {
		const longTail = "<｜" + "a".repeat(300);
		expect(getTrailingPartialDeepseekToken(longTail)).toBe("");
	});
});
