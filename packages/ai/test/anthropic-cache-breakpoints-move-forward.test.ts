import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { AssistantMessage, Context, Message, Model, ModelSpec, ToolResultMessage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * What a collapsed Anthropic turn costs, and why these are the assertions.
 *
 * A turn that fails to match its own previous prefix does not bill as `input`.
 * It bills as `cacheWrite`, at roughly 13.9x the `cacheRead` price, for the
 * whole prompt. Across 82,374 recorded `anthropic-messages` turns the excess
 * `cacheWrite` over adjacent pairs is 66.3M tokens, and the worst shape is a
 * turn that re-writes 814,866 tokens 20 seconds after the previous turn read
 * 844,515 of the same bytes.
 *
 * Two request-shape properties decide whether that happens, and neither was
 * pinned anywhere before this file. `applyPromptCaching` places its message
 * breakpoints by offset from the END of `params.messages`
 * (`packages/ai/src/providers/anthropic.ts:3207`), so the marked positions
 * advance as the conversation grows:
 *
 *   1. Every marker a turn places sits strictly after every marker the
 *      previous turn placed. A marker that moved backwards, or an earlier
 *      message that gained one, would ask the provider to cache a prefix it
 *      already holds and re-write everything past it.
 *   2. The bytes under the previous turn's deepest marker are unchanged in
 *      this turn's request. Anthropic matches prefixes byte for byte, so any
 *      rewrite of already-sent content forfeits the whole cached prefix.
 *
 * Property 2 is why thinking blocks stay in the replayed prefix. Stripping
 * them shrinks the prompt, and it has been tried, but it rewrites bytes the
 * provider already cached and so pays the write price for everything after
 * the edit rather than saving the read price on the thinking itself.
 *
 * `cache_control` is stripped before comparing prefixes because it is a
 * directive rather than content: the markers legitimately move every turn,
 * and the steady state of the recorded data (a turn reading its predecessor's
 * full prompt while both turns carry markers in different places) is only
 * possible if the provider excludes them from the match.
 */

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);

type CacheControl = { type: "ephemeral"; ttl?: "1h" };
type WireBlock = { type?: string; cache_control?: CacheControl } & Record<string, unknown>;
type WireMessage = { role?: string; content?: string | WireBlock[] };
type AnthropicPayload = { system?: WireBlock[]; messages?: WireMessage[] };

/** Marker coordinate inside `payload.messages`. */
type MessageMarker = { message: number; block: number };

function capturePayload(context: Context, isOAuth: boolean): Promise<AnthropicPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<AnthropicPayload>();
	streamAnthropic(MODEL, context, {
		apiKey: "sk-ant-test",
		isOAuth,
		signal: controller.signal,
		onPayload: payload => resolve(payload as AnthropicPayload),
	});
	return promise;
}

function assistantTurn(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `reasoning for step ${index}`, thinkingSignature: `sig_${index}` },
			{ type: "toolCall", id: `toolu_${index}`, name: "read", arguments: { path: `file-${index}.ts` } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: index * 2,
	};
}

function toolResultTurn(index: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `toolu_${index}`,
		toolName: "read",
		content: [{ type: "text", text: `contents of file-${index}.ts` }],
		isError: false,
		timestamp: index * 2 + 1,
	};
}

/**
 * The message list each turn of an agentic loop sends: one user message, then
 * an (assistant tool call, tool result) pair per completed step. This is the
 * growth pattern the recorded corpus shows for 80.3% of healthy adjacent
 * pairs — two messages appended per turn.
 */
function conversationAfter(steps: number): Message[] {
	const messages: Message[] = [{ role: "user", content: "Audit the cache placement", timestamp: 0 }];
	for (let index = 1; index <= steps; index++) {
		messages.push(assistantTurn(index), toolResultTurn(index));
	}
	return messages;
}

function messageMarkers(payload: AnthropicPayload): MessageMarker[] {
	const markers: MessageMarker[] = [];
	payload.messages?.forEach((message, messageIndex) => {
		if (!Array.isArray(message.content)) return;
		message.content.forEach((block, blockIndex) => {
			if (block.cache_control) markers.push({ message: messageIndex, block: blockIndex });
		});
	});
	return markers;
}

function totalMarkers(payload: AnthropicPayload): number {
	const system = (payload.system ?? []).filter(block => block.cache_control).length;
	return system + messageMarkers(payload).length;
}

/** Request content with every `cache_control` directive removed. */
function contentWithoutMarkers(messages: WireMessage[]): string {
	return JSON.stringify(
		messages.map(message => {
			if (!Array.isArray(message.content)) return message;
			return {
				...message,
				content: message.content.map(block => {
					const { cache_control: _dropped, ...rest } = block;
					return rest;
				}),
			};
		}),
	);
}

async function turnPayloads(steps: number[], isOAuth: boolean): Promise<AnthropicPayload[]> {
	const payloads: AnthropicPayload[] = [];
	for (const count of steps) {
		payloads.push(
			await capturePayload(
				{
					systemPrompt: ["stable harness", "project context", "changing handle table"],
					messages: conversationAfter(count),
				},
				isOAuth,
			),
		);
	}
	return payloads;
}

describe("Anthropic cache breakpoints as a conversation grows", () => {
	for (const [layoutName, isOAuth, markedMessagesPerTurn] of [
		["API-key layout", false, 2],
		["Claude Code layout", true, 1],
	] as const) {
		/**
		 * A breakpoint that lands on or before a position the previous turn
		 * already marked re-caches a prefix the provider is holding and bills the
		 * remainder as a write.
		 *
		 * How many messages each layout marks is part of the same budget. The
		 * API-key layout spends two of the four slots on system anchors and two on
		 * trailing messages; the Claude Code layout marks only the final message
		 * and leaves the fourth slot unspent, because the marker count is
		 * wire-visible and that layout exists to mirror the client it cloaks
		 * (`packages/ai/src/providers/anthropic.ts:3188-3207`).
		 */
		it(`${layoutName}: marks ${markedMessagesPerTurn} trailing message(s), always further forward`, async () => {
			const payloads = await turnPayloads([1, 2, 3, 4, 5], isOAuth);

			for (const payload of payloads) {
				const marked = new Set(messageMarkers(payload).map(marker => marker.message));
				expect(marked.size).toBe(markedMessagesPerTurn);
			}

			for (let turn = 1; turn < payloads.length; turn++) {
				const deepestPrevious = Math.max(...messageMarkers(payloads[turn - 1]).map(m => m.message));
				const shallowestCurrent = Math.min(...messageMarkers(payloads[turn]).map(m => m.message));

				expect({ turn, advanced: shallowestCurrent > deepestPrevious }).toEqual({ turn, advanced: true });
			}
		});

		/**
		 * Anthropic matches a cached prefix byte for byte. Everything up to and
		 * including the previous turn's deepest marker must arrive unchanged, or
		 * the entire cached prefix is forfeit and re-written at write price.
		 */
		it(`${layoutName}: the previously cached prefix arrives byte-identical`, async () => {
			const payloads = await turnPayloads([1, 2, 3, 4, 5], isOAuth);

			for (let turn = 1; turn < payloads.length; turn++) {
				const previousMessages = payloads[turn - 1].messages ?? [];
				const currentMessages = payloads[turn].messages ?? [];
				const cachedThrough = Math.max(...messageMarkers(payloads[turn - 1]).map(marker => marker.message));

				expect(contentWithoutMarkers(currentMessages.slice(0, cachedThrough + 1))).toBe(
					contentWithoutMarkers(previousMessages.slice(0, cachedThrough + 1)),
				);
			}
		});
	}

	/**
	 * Thinking blocks are the largest replayed content in a reasoning session
	 * and the recurring temptation to drop. They sit inside the cached prefix,
	 * so removing one rewrites cached bytes: the saving is the read price of the
	 * thinking, the cost is the write price of everything after it.
	 */
	it("keeps every replayed thinking block inside the cached prefix", async () => {
		const payloads = await turnPayloads([2, 3], false);
		const [earlier, later] = payloads;
		const cachedThrough = Math.max(...messageMarkers(earlier).map(marker => marker.message));

		const thinkingInPrefix = (payload: AnthropicPayload): unknown[] =>
			(payload.messages ?? [])
				.slice(0, cachedThrough + 1)
				.flatMap(message => (Array.isArray(message.content) ? message.content : []))
				.filter(block => block.type === "thinking");

		expect(thinkingInPrefix(earlier)).toEqual([
			{ type: "thinking", thinking: "reasoning for step 1", signature: "sig_1" },
			{ type: "thinking", thinking: "reasoning for step 2", signature: "sig_2" },
		]);
		expect(thinkingInPrefix(later)).toEqual(thinkingInPrefix(earlier));
	});

	/**
	 * Anthropic rejects a request carrying more than four `cache_control`
	 * markers, and the budget is spent in a fixed order: the trailing system
	 * block, the stable system prefix, then the trailing messages. The API-key
	 * layout fills all four; the Claude Code layout deliberately leaves the
	 * fourth unspent. Both totals must hold at every conversation length, since
	 * a conversation that grew past the budget and started dropping or
	 * relocating anchors is exactly the shape that re-writes a cached prefix.
	 */
	it("spends the same breakpoint budget however long the conversation gets", async () => {
		for (const [isOAuth, expected] of [
			[false, 4],
			[true, 3],
		] as const) {
			const payloads = await turnPayloads([1, 2, 5, 20], isOAuth);
			expect(payloads.map(totalMarkers)).toEqual([expected, expected, expected, expected]);
		}
	});
});
