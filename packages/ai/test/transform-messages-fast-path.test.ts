import { describe, expect, it } from "bun:test";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type { Api, AssistantMessage, Message, Model, ModelSpec, UserMessage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * WHY: `transformMessages` runs on every turn. Before the fast-path, the
 * `.map()` over messages rebuilt every assistant message with
 * `{ ...assistantMsg, content: transformedContent }` even when no content
 * block needed transformation — allocating a new object and a new content
 * array per assistant message per turn. The fast-path returns the message
 * by reference when same-model + non-Anthropic target + no thinking/fallback
 * blocks, since every block type (text, toolCall, redactedThinking) passes
 * through the flatMap unchanged in that case.
 *
 * This suite closes the class by asserting reference identity for the
 * fast-path case and reference inequality for every case that must still
 * transform. A regression that removes the fast-path or widens it
 * incorrectly will fail on the identity assertions.
 *
 * Does not catch: transformations inside the flatMap that produce a
 * different object but equivalent content — those are covered by the
 * thinking-dialect and dedup suites.
 */

function makeModel<T extends Api>(api: T, provider: string, id: string): Model<T> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	} as ModelSpec<T>);
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistantTextTurn(provider: string, api: Api, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello!" }],
		api,
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistantToolCallTurn(provider: string, api: Api, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Let me check." },
			{ type: "toolCall", id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
		],
		api,
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function assistantThinkingTurn(provider: string, api: Api, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Reasoning here.", thinkingSignature: "sig-123" },
			{ type: "text", text: "The answer is 42." },
		],
		api,
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("transformMessages same-model non-Anthropic fast-path", () => {
	it("returns text-only assistant message by reference for same-model non-Anthropic target", () => {
		const model = makeModel("openai-completions", "openai", "gpt-4o");
		const msg = assistantTextTurn("openai", "openai-completions", "gpt-4o");
		const input: Message[] = [user("hi"), msg];

		const result = transformMessages(input, model);

		// The assistant message must be the exact same object — no allocation.
		expect(result[1]).toBe(msg);
	});

	it("returns toolCall assistant message by reference for same-model non-Anthropic target", () => {
		const model = makeModel("openai-completions", "openai", "gpt-4o");
		const msg = assistantToolCallTurn("openai", "openai-completions", "gpt-4o");
		const input: Message[] = [user("weather?"), msg];

		const result = transformMessages(input, model);

		expect(result[1]).toBe(msg);
	});

	it("returns redactedThinking assistant message by reference for same-model non-Anthropic target", () => {
		const model = makeModel("openai-completions", "openai", "gpt-4o");
		const msg: AssistantMessage = {
			...assistantTextTurn("openai", "openai-completions", "gpt-4o"),
			content: [
				{ type: "redactedThinking", data: "redacted-data" },
				{ type: "text", text: "Done." },
			],
		};
		const input: Message[] = [user("hi"), msg];

		const result = transformMessages(input, model);

		expect(result[1]).toBe(msg);
	});

	it("does NOT use fast-path when thinking blocks are present (same-model non-Anthropic)", () => {
		const model = makeModel("openai-completions", "openai", "gpt-4o");
		const msg = assistantThinkingTurn("openai", "openai-completions", "gpt-4o");
		const input: Message[] = [user("hi"), msg];

		const result = transformMessages(input, model);

		// Thinking blocks trigger the full transform path — new object.
		expect(result[1]).not.toBe(msg);
		// Content is preserved (same-model keeps thinking with signature).
		const assistant = result[1] as AssistantMessage;
		expect(assistant.content[0]?.type).toBe("thinking");
	});

	it("does NOT use fast-path for Anthropic target even with no thinking blocks", () => {
		const model = makeModel("anthropic-messages", "anthropic", "claude-opus-4-8");
		const msg = assistantTextTurn("anthropic", "anthropic-messages", "claude-opus-4-8");
		const input: Message[] = [user("hi"), msg];

		const result = transformMessages(input, model);

		// Anthropic target always goes through the full transform.
		expect(result[1]).not.toBe(msg);
	});

	it("does NOT use fast-path for cross-model even with no thinking blocks", () => {
		const target = makeModel("openai-completions", "openai", "gpt-4o");
		const msg = assistantTextTurn("anthropic", "anthropic-messages", "claude-opus-4-8");
		const input: Message[] = [user("hi"), msg];

		const result = transformMessages(input, target);

		// Cross-model: text blocks get rebuilt ({ type: "text", text: block.text }).
		expect(result[1]).not.toBe(msg);
	});

	it("returns user messages by reference regardless of target", () => {
		const model = makeModel("openai-completions", "openai", "gpt-4o");
		const u = user("hello");
		const input: Message[] = [u, assistantTextTurn("openai", "openai-completions", "gpt-4o")];

		const result = transformMessages(input, model);

		expect(result[0]).toBe(u);
	});

	it("preserves content equality when fast-path is taken", () => {
		const model = makeModel("openai-completions", "openai", "gpt-4o");
		const msg = assistantToolCallTurn("openai", "openai-completions", "gpt-4o");
		const input: Message[] = [user("weather?"), msg];

		const result = transformMessages(input, model);

		const assistant = result[1] as AssistantMessage;
		expect(assistant.content).toEqual(msg.content);
		expect(assistant.content[1]).toBe(msg.content[1]);
	});
});
