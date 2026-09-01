import { describe, expect, it } from "bun:test";
import type { Api, Message, Model } from "@veyyon/ai";
import type { ResolvedAnthropicCompat } from "@veyyon/catalog/types";
import {
	buildCacheAlignedCompactionContext,
	type CacheAlignedEligibility,
	canUseCacheAlignedCompaction,
	estimateCacheAlignedRequestTokens,
	hasUnansweredToolCall,
	modelServesPrefixCacheHits,
} from "../src/compaction/cache-aligned-context";

function makeModel(api: string, supportsCache = false): Model<Api> {
	return {
		api,
		compat: { supportsLongCacheRetention: supportsCache } as ResolvedAnthropicCompat,
	} as unknown as Model<Api>;
}

function makeAssistantMessage(toolCalls: Array<{ id: string; name: string }>): Message {
	return {
		role: "assistant",
		content: toolCalls.map(tc => ({ type: "toolCall", id: tc.id, name: tc.name, arguments: {} })),
	} as Message;
}

function makeToolResultMessage(toolCallId: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		content: [],
	} as Message;
}

function makeUserMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as Message;
}

describe("modelServesPrefixCacheHits", () => {
	it("returns true for anthropic-messages with cache support", () => {
		expect(modelServesPrefixCacheHits(makeModel("anthropic-messages", true))).toBe(true);
	});
	it("returns false for anthropic-messages without cache support", () => {
		expect(modelServesPrefixCacheHits(makeModel("anthropic-messages", false))).toBe(false);
	});
	it("returns false for non-anthropic api", () => {
		expect(modelServesPrefixCacheHits(makeModel("openai", true))).toBe(false);
	});
	it("returns false for unknown api", () => {
		expect(modelServesPrefixCacheHits(makeModel("unknown", true))).toBe(false);
	});
});

describe("hasUnansweredToolCall", () => {
	it("returns false for empty messages", () => {
		expect(hasUnansweredToolCall([])).toBe(false);
	});
	it("returns false when all tool calls have results", () => {
		const messages: Message[] = [makeAssistantMessage([{ id: "c1", name: "read" }]), makeToolResultMessage("c1")];
		expect(hasUnansweredToolCall(messages)).toBe(false);
	});
	it("returns true when tool call has no result", () => {
		const messages: Message[] = [makeAssistantMessage([{ id: "c1", name: "read" }])];
		expect(hasUnansweredToolCall(messages)).toBe(true);
	});
	it("returns true when one of multiple tool calls is unanswered", () => {
		const messages: Message[] = [
			makeAssistantMessage([
				{ id: "c1", name: "read" },
				{ id: "c2", name: "write" },
			]),
			makeToolResultMessage("c1"),
		];
		expect(hasUnansweredToolCall(messages)).toBe(true);
	});
	it("returns false for user messages only", () => {
		const messages: Message[] = [makeUserMessage("hello")];
		expect(hasUnansweredToolCall(messages)).toBe(false);
	});
	it("handles interleaved assistant and tool results", () => {
		const messages: Message[] = [
			makeAssistantMessage([{ id: "c1", name: "read" }]),
			makeToolResultMessage("c1"),
			makeAssistantMessage([{ id: "c2", name: "read" }]),
			makeToolResultMessage("c2"),
		];
		expect(hasUnansweredToolCall(messages)).toBe(false);
	});
	it("handles duplicate tool call ids", () => {
		const messages: Message[] = [
			makeAssistantMessage([{ id: "c1", name: "read" }]),
			makeToolResultMessage("c1"),
			makeAssistantMessage([{ id: "c1", name: "read" }]),
		];
		expect(hasUnansweredToolCall(messages)).toBe(true);
	});
});

describe("canUseCacheAlignedCompaction", () => {
	const validModel = makeModel("anthropic-messages", true);
	const validPrompt = ["system prompt"];
	const validMessages: Message[] = [makeUserMessage("hello")];

	it("returns true when all conditions met", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: validPrompt,
			sessionMessages: validMessages,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(true);
	});
	it("returns false when model does not serve prefix cache", () => {
		const input: CacheAlignedEligibility = {
			model: makeModel("openai", true),
			sessionSystemPrompt: validPrompt,
			sessionMessages: validMessages,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns false when system prompt is undefined", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: undefined,
			sessionMessages: validMessages,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns false when system prompt is empty array", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: [],
			sessionMessages: validMessages,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns false when all system prompt blocks are empty strings", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: ["", ""],
			sessionMessages: validMessages,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns false when messages are undefined", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: validPrompt,
			sessionMessages: undefined,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns false when messages are empty", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: validPrompt,
			sessionMessages: [],
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns false when there are unanswered tool calls", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: validPrompt,
			sessionMessages: [makeAssistantMessage([{ id: "c1", name: "read" }])],
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(false);
	});
	it("returns true when system prompt has at least one non-empty block", () => {
		const input: CacheAlignedEligibility = {
			model: validModel,
			sessionSystemPrompt: ["", "actual prompt"],
			sessionMessages: validMessages,
		};
		expect(canUseCacheAlignedCompaction(input)).toBe(true);
	});
});

describe("buildCacheAlignedCompactionContext", () => {
	it("builds context with messages and instruction", () => {
		const ctx = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [makeUserMessage("hello")],
			instruction: "compact this",
		});
		expect(ctx.systemPrompt).toEqual(["system"]);
		expect(ctx.messages).toHaveLength(2);
	});
	it("appends instruction as user message", () => {
		const ctx = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "compact this",
		});
		const lastMessage = ctx.messages[ctx.messages.length - 1];
		expect(lastMessage.role).toBe("user");
	});
	it("applies sanitize function to instruction", () => {
		const ctx = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "compact this",
			sanitize: (text: string) => text.toUpperCase(),
		});
		const lastMessage = ctx.messages[ctx.messages.length - 1] as Extract<
			(typeof ctx.messages)[number],
			{ role: "user" }
		>;
		const textBlock = lastMessage.content[0] as { type: string; text: string };
		expect(textBlock.text).toBe("COMPACT THIS");
	});
	it("uses provided timestamp", () => {
		const ctx = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "compact",
			timestamp: 12345,
		});
		const lastMessage = ctx.messages[ctx.messages.length - 1] as Extract<
			(typeof ctx.messages)[number],
			{ role: "user" }
		>;
		expect(lastMessage.timestamp).toBe(12345);
	});
	it("passes tools through", () => {
		const tools = [{ name: "read" }] as unknown as import("@veyyon/ai").Tool[];
		const ctx = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "compact",
			tools,
		});
		expect(ctx.tools).toBe(tools);
	});
});

describe("estimateCacheAlignedRequestTokens", () => {
	it("returns positive count for non-empty input", () => {
		const tokens = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["system prompt"],
			sessionMessages: [makeUserMessage("hello world")],
			instruction: "compact this",
		});
		expect(tokens).toBeGreaterThan(0);
	});
	it("returns count for empty messages", () => {
		const tokens = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["system"],
			sessionMessages: [],
			instruction: "compact",
		});
		expect(tokens).toBeGreaterThan(0);
	});
	it("returns count for empty system prompt", () => {
		const tokens = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: [],
			sessionMessages: [],
			instruction: "compact",
		});
		expect(tokens).toBeGreaterThan(0);
	});
	it("increases with more messages", () => {
		const small = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["system"],
			sessionMessages: [makeUserMessage("a")],
			instruction: "compact",
		});
		const large = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: ["system"],
			sessionMessages: [makeUserMessage("a"), makeUserMessage("b"), makeUserMessage("c")],
			instruction: "compact",
		});
		expect(large).toBeGreaterThan(small);
	});
});
