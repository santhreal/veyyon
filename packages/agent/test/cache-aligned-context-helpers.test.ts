import { describe, expect, it } from "bun:test";
import type { Message } from "@veyyon/ai";
import {
	buildCacheAlignedCompactionContext,
	canUseCacheAlignedCompaction,
	estimateCacheAlignedRequestTokens,
	hasUnansweredToolCall,
	modelServesPrefixCacheHits,
} from "../src/compaction/cache-aligned-context";

function makeModel(api: string, supportsLongCacheRetention = false): never {
	return { api, compat: { supportsLongCacheRetention } } as never;
}

function makeUserMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as Message;
}

function makeAssistantMessage(content: Message["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages" as never,
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: { input: 0, output: 0 } as never,
		stopReason: "stop",
		timestamp: 0,
	} as Message;
}

function makeToolResultMessage(toolCallId: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
	} as Message;
}

describe("modelServesPrefixCacheHits", () => {
	it("returns true for anthropic-messages with supportsLongCacheRetention", () => {
		expect(modelServesPrefixCacheHits(makeModel("anthropic-messages", true))).toBe(true);
	});

	it("returns false for anthropic-messages without supportsLongCacheRetention", () => {
		expect(modelServesPrefixCacheHits(makeModel("anthropic-messages", false))).toBe(false);
	});

	it("returns false for non-anthropic-messages API", () => {
		expect(modelServesPrefixCacheHits(makeModel("openai-chat", true))).toBe(false);
	});

	it("returns false for unknown API", () => {
		expect(modelServesPrefixCacheHits(makeModel("unknown", true))).toBe(false);
	});
});

describe("hasUnansweredToolCall", () => {
	it("returns false for empty messages", () => {
		expect(hasUnansweredToolCall([])).toBe(false);
	});

	it("returns false for user-only messages", () => {
		expect(hasUnansweredToolCall([makeUserMessage("hi")])).toBe(false);
	});

	it("returns true for assistant with toolCall and no result", () => {
		const msg = makeAssistantMessage([{ type: "toolCall", id: "tc1", name: "read", input: {} } as never]);
		expect(hasUnansweredToolCall([msg])).toBe(true);
	});

	it("returns false for assistant with toolCall followed by result", () => {
		const msg = makeAssistantMessage([{ type: "toolCall", id: "tc1", name: "read", input: {} } as never]);
		expect(hasUnansweredToolCall([msg, makeToolResultMessage("tc1")])).toBe(false);
	});

	it("returns true when only some tool calls are answered", () => {
		const msg = makeAssistantMessage([
			{ type: "toolCall", id: "tc1", name: "read", input: {} } as never,
			{ type: "toolCall", id: "tc2", name: "write", input: {} } as never,
		]);
		expect(hasUnansweredToolCall([msg, makeToolResultMessage("tc1")])).toBe(true);
	});

	it("returns false for assistant with text-only content", () => {
		const msg = makeAssistantMessage([{ type: "text", text: "hi" } as never]);
		expect(hasUnansweredToolCall([msg])).toBe(false);
	});

	it("handles multiple assistant messages with mixed results", () => {
		const msg1 = makeAssistantMessage([{ type: "toolCall", id: "tc1", name: "read", input: {} } as never]);
		const msg2 = makeAssistantMessage([{ type: "toolCall", id: "tc2", name: "write", input: {} } as never]);
		expect(hasUnansweredToolCall([msg1, makeToolResultMessage("tc1"), msg2, makeToolResultMessage("tc2")])).toBe(
			false,
		);
	});

	it("returns true when result comes before the tool call", () => {
		// result without a preceding toolCall - pending set is empty, then toolCall adds
		const msg = makeAssistantMessage([{ type: "toolCall", id: "tc1", name: "read", input: {} } as never]);
		expect(hasUnansweredToolCall([makeToolResultMessage("tc1"), msg])).toBe(true);
	});
});

describe("canUseCacheAlignedCompaction", () => {
	it("returns false when model does not serve prefix cache hits", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("openai-chat", true),
				sessionSystemPrompt: ["system"],
				sessionMessages: [makeUserMessage("hi")],
			}),
		).toBe(false);
	});

	it("returns false for undefined system prompt", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: undefined,
				sessionMessages: [makeUserMessage("hi")],
			}),
		).toBe(false);
	});

	it("returns false for empty system prompt array", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: [],
				sessionMessages: [makeUserMessage("hi")],
			}),
		).toBe(false);
	});

	it("returns false for all-empty-string system prompt", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: ["", ""],
				sessionMessages: [makeUserMessage("hi")],
			}),
		).toBe(false);
	});

	it("returns false for undefined session messages", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: ["system"],
				sessionMessages: undefined,
			}),
		).toBe(false);
	});

	it("returns false for empty session messages", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: ["system"],
				sessionMessages: [],
			}),
		).toBe(false);
	});

	it("returns false when there are unanswered tool calls", () => {
		const msg = makeAssistantMessage([{ type: "toolCall", id: "tc1", name: "read", input: {} } as never]);
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: ["system"],
				sessionMessages: [msg],
			}),
		).toBe(false);
	});

	it("returns true when all conditions are met", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: ["system"],
				sessionMessages: [makeUserMessage("hi")],
			}),
		).toBe(true);
	});

	it("returns true with at least one non-empty system prompt block", () => {
		expect(
			canUseCacheAlignedCompaction({
				model: makeModel("anthropic-messages", true),
				sessionSystemPrompt: ["", "system"],
				sessionMessages: [makeUserMessage("hi")],
			}),
		).toBe(true);
	});
});

describe("buildCacheAlignedCompactionContext", () => {
	it("builds context with system prompt, messages, and instruction", () => {
		const result = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [makeUserMessage("hi")],
			instruction: "Summarize",
			timestamp: 1000,
		});
		expect(result.systemPrompt).toEqual(["system"]);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1].role).toBe("user");
	});

	it("applies sanitize function to instruction", () => {
		const result = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "raw",
			sanitize: (text: string) => `clean:${text}`,
			timestamp: 0,
		});
		const lastMsg = result.messages[0] as { content: { type: string; text: string }[] };
		expect(lastMsg.content[0].text).toBe("clean:raw");
	});

	it("uses Date.now() when timestamp is undefined", () => {
		const before = Date.now();
		const result = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "test",
		});
		const after = Date.now();
		const lastMsg = result.messages[0] as { timestamp: number };
		expect(lastMsg.timestamp).toBeGreaterThanOrEqual(before);
		expect(lastMsg.timestamp).toBeLessThanOrEqual(after);
	});

	it("passes tools through when provided", () => {
		const tools = [{ name: "read" }] as never;
		const result = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "test",
			tools,
			timestamp: 0,
		});
		expect(result.tools).toBe(tools);
	});

	it("preserves session messages before the instruction", () => {
		const userMsg = makeUserMessage("hello");
		const result = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [userMsg],
			instruction: "summarize",
			timestamp: 0,
		});
		expect(result.messages[0]).toBe(userMsg);
		expect(result.messages).toHaveLength(2);
	});
});

describe("estimateCacheAlignedRequestTokens", () => {
	it("returns positive number for non-empty input", () => {
		const result = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["system prompt"],
			sessionMessages: [makeUserMessage("hello world")],
			instruction: "summarize this",
		});
		expect(result).toBeGreaterThan(0);
	});

	it("returns positive number for minimal input", () => {
		const result = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["s"],
			sessionMessages: [],
			instruction: "i",
		});
		expect(result).toBeGreaterThan(0);
	});

	it("increases with more content", () => {
		const small = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["s"],
			sessionMessages: [],
			instruction: "i",
		});
		const large = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["s".repeat(1000)],
			sessionMessages: [makeUserMessage("x".repeat(1000))],
			instruction: "i".repeat(100),
		});
		expect(large).toBeGreaterThan(small);
	});
});
