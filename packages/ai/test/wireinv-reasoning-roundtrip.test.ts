import { afterEach, describe, expect, it, vi } from "bun:test";
import { AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import { streamSimple } from "@veyyon/ai/stream";
import type { AssistantMessage, Context, FetchImpl } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * WHY: reasoning replay is the other half of the wire contract — a provider
 * that issues signed/encrypted thinking requires the NEXT request to carry
 * that material back verbatim, or the reasoning chain is silently dropped
 * (context loss the operator cannot see) or the request 400s (Anthropic's
 * all-or-none signature rule). DeepSeek's tool-call reasoning_content replay
 * is already pinned in deepseek-reasoning-content.test.ts; this file pins the
 * two UNCOVERED replay contracts end to end (stream the response, take the
 * assistant message from the done event, replay it through the real encoder,
 * inspect the captured request):
 *
 *   - Anthropic (bundled claude-sonnet-4-5, signing endpoint): a thinking
 *     block streamed with a `signature_delta` MUST replay as
 *     `{ type: "thinking", thinking, signature }` with the signature
 *     byte-identical — stripped or emptied signatures 400 the next turn.
 *   - OpenAI Responses (bundled openai/gpt-5.5): the request asks for
 *     `reasoning.encrypted_content`, and the returned reasoning item MUST
 *     replay into the next request's `input` with its summary and
 *     `encrypted_content` verbatim — the only way stateless (store: false)
 *     multi-turn reasoning survives.
 */

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const sonnet = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");
const gpt55 = getBundledModel<"openai-responses">("openai", "gpt-5.5");

afterEach(() => vi.restoreAllMocks());

describe("Anthropic signed thinking replays verbatim into the next request", () => {
	const anthropicSseEvents = [
		{
			type: "message_start",
			message: {
				id: "msg_1",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "weighing the evidence" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_WfS0l" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
		{ type: "content_block_stop", index: 1 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];

	it("replays the streamed signature byte-identical on the follow-up request", async () => {
		// Encoder lines under test: anthropic.ts signature_delta accumulation
		// (`block.thinkingSignature += event.delta.signature`) and the signed
		// replay branch in convertAnthropicMessages
		// (`blocks.push({ type: "thinking", thinking, signature })`).
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() =>
				({
					async withResponse() {
						return {
							data: (async function* () {
								for (const event of anthropicSseEvents) yield event;
							})(),
							response: new Response(null, { status: 200, headers: { "request-id": "req_mock" } }),
							request_id: "req_mock",
						};
					},
				}) as never,
		);

		let assistant: AssistantMessage | undefined;
		for await (const event of streamSimple(sonnet, context, { apiKey: "sk-ant-test", reasoning: Effort.High })) {
			if (event.type === "done") assistant = event.message;
			if (event.type === "error") break;
		}
		// Pick the contract fields: blocks also carry the internal streaming
		// Symbol(provider.block.index) marker, which is not part of the contract.
		expect(
			assistant?.content.map(block =>
				block.type === "thinking"
					? { type: block.type, thinking: block.thinking, thinkingSignature: block.thinkingSignature }
					: { type: block.type, text: (block as { text?: string }).text },
			),
		).toEqual([
			{ type: "thinking", thinking: "weighing the evidence", thinkingSignature: "sig_WfS0l" },
			{ type: "text", text: "answer" },
		]);

		// Second turn: capture the exact request params via onPayload + aborted send.
		const replayContext: Context = {
			messages: [
				...context.messages,
				assistant as AssistantMessage,
				{ role: "user", content: "next", timestamp: 2 },
			],
		};
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		const controller = new AbortController();
		controller.abort();
		const second = streamSimple(sonnet, replayContext, {
			apiKey: "sk-ant-test",
			reasoning: Effort.High,
			signal: controller.signal,
			onPayload: payload => resolve(payload as Record<string, unknown>),
		});
		second.result().then(
			() => reject(new Error("the request stream ended without emitting a payload")),
			(error: unknown) => reject(error),
		);
		const body = await promise;

		const messages = body.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0]).toEqual({ role: "user", content: "hi" });
		const assistantBlocks = messages[1]?.content as Array<Record<string, unknown>>;
		// The signed thinking block replays BEFORE the text, signature untouched.
		expect(assistantBlocks[0]).toEqual({
			type: "thinking",
			thinking: "weighing the evidence",
			signature: "sig_WfS0l",
		});
		expect(assistantBlocks[1]).toMatchObject({ type: "text", text: "answer" });
	});
});

describe("OpenAI Responses encrypted reasoning replays verbatim into the next request", () => {
	function responsesSseWithReasoning(): Response {
		const frames = [
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "reasoning",
					id: "rs_1",
					summary: [{ type: "summary_text", text: "weighed the options" }],
					encrypted_content: "enc_payload_9f",
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "answer" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		];
		return new Response(`${frames.join("\n\n")}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("requests encrypted reasoning, then replays the item's summary and encrypted_content untouched", async () => {
		// Encoder lines under test: openai-shared.ts applyResponsesCompatPolicy
		// (`include.push("reasoning.encrypted_content")`), openai-responses.ts
		// providerPayload capture (`createOpenAIResponsesHistoryPayload`), and the
		// native-history replay in buildResponsesInput with
		// sanitizeOpenAIResponsesAssistantHistoryItemsForReplay preserving
		// summary + encrypted_content.
		let firstBody: Record<string, unknown> | undefined;
		const firstFetch: FetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			firstBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return responsesSseWithReasoning();
		}) as FetchImpl;

		let assistant: AssistantMessage | undefined;
		for await (const event of streamSimple(gpt55, context, {
			apiKey: "k",
			fetch: firstFetch,
			reasoning: Effort.High,
		})) {
			if (event.type === "done") assistant = event.message;
			if (event.type === "error") break;
		}
		if (!firstBody) throw new Error("Expected a captured first Responses request");
		// The replay contract starts here: without this include the response
		// carries no replayable reasoning material at all.
		expect(firstBody.include).toContain("reasoning.encrypted_content");
		expect(assistant).toBeDefined();

		let secondBody: Record<string, unknown> | undefined;
		const secondFetch: FetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			secondBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return responsesSseWithReasoning();
		}) as FetchImpl;
		const replayContext: Context = {
			messages: [
				...context.messages,
				assistant as AssistantMessage,
				{ role: "user", content: "next", timestamp: 2 },
			],
		};
		for await (const event of streamSimple(gpt55, replayContext, {
			apiKey: "k",
			fetch: secondFetch,
			reasoning: Effort.High,
		})) {
			if (event.type === "done" || event.type === "error") break;
		}
		if (!secondBody) throw new Error("Expected a captured second Responses request");

		const input = secondBody.input as Array<Record<string, unknown>>;
		// Order: original user turn, the replayed reasoning item, the assistant
		// message, the new user turn. The reasoning item keeps summary and
		// encrypted_content byte-identical (the replay sanitizer drops only the
		// server-side item id).
		expect(input).toHaveLength(4);
		expect(input[1]).toEqual({
			type: "reasoning",
			summary: [{ type: "summary_text", text: "weighed the options" }],
			encrypted_content: "enc_payload_9f",
		});
		expect(input[2]).toMatchObject({ type: "message", role: "assistant" });
	});
});
