/**
 * WHY: an attempt whose output a retry throws away was still billed, and every
 * retry path used to throw the money away with the text.
 *
 * The class this closes: any place that abandons a provider attempt and keeps
 * going (a stream that died after `message_start`, a degenerate empty completion
 * that gets asked again, a thinking loop that gets aborted and re-sampled) must
 * report what that attempt spent. Under prompt caching the discarded attempt is
 * usually the expensive cache WRITE and the survivor is a cheap read, so the
 * error is not a rounding difference; and for a provider whose limit window is
 * measured locally from observed cost, a turn that under-reports its spend also
 * under-reports how much of the operator's quota is gone.
 *
 * The two questions stay separate and keep one owner each: the delivered token
 * fields answer "how big is the context" and never grow, `usage.discarded`
 * answers "what was paid for text nobody saw", and `cost.total` is the money.
 *
 * What this does NOT catch: Codex's own in-stream reset (`resetOutputState`) is
 * covered only by the shared owner it delegates to, because Codex writes
 * `output.usage` exclusively on a terminal `response.completed` event and every
 * reset path that could follow one is gated on empty content, which the
 * empty-completion wrapper intercepts first. Its carry is defensive: correct the
 * day Codex reports usage mid-stream, inert until then. A turn that ends by
 * throwing also carries nothing, because there is no message to carry it on.
 */

import { describe, expect, it, spyOn, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { create, toBinary } from "@bufbuild/protobuf";
import { clearCustomApis, registerCustomApi } from "@veyyon/ai/api-registry";
import * as AIError from "@veyyon/ai/error";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@veyyon/ai/providers/anthropic-client";
import { streamDevin } from "@veyyon/ai/providers/devin";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import {
	applyOpenAIResponsesServiceTierCost,
	populateResponsesUsageFromResponse,
} from "@veyyon/ai/providers/openai-shared";
import { completeSimple } from "@veyyon/ai/stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, Usage } from "@veyyon/ai/types";
import { withEmptyCompletionRetry } from "@veyyon/ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { withGeminiThinkingLoopGuard } from "@veyyon/ai/utils/thinking-loop";
import { buildModel } from "@veyyon/catalog/build";
import { GetChatMessageResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { ModelUsageStatsSchema } from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import {
	calculateCost,
	discardAttemptUsage,
	emptyCost,
	emptyUsage,
	inheritUsageCarryovers,
	recomputeCostTotal,
} from "@veyyon/catalog/models";

/** Priced so a discarded attempt shows up in dollars, not only in tokens. */
const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CONTEXT: Context = { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] };

type BilledField = "input" | "output" | "cacheRead" | "cacheWrite";

/**
 * Every token bucket a `Usage` bills for, read off the shape at run time rather
 * than typed out, so a new bucket lands in this suite instead of slipping past
 * it. `totalTokens` is a sum of the others, not a bucket of its own.
 */
const BILLED_TOKEN_FIELDS = Object.entries(emptyUsage())
	.filter(([key, value]) => typeof value === "number" && key !== "totalTokens")
	.map(([key]) => key as BilledField);

function usageOf(fields: Partial<Record<BilledField, number>> & { cost?: number }): Usage {
	const usage = emptyUsage();
	for (const field of BILLED_TOKEN_FIELDS) usage[field] = fields[field] ?? 0;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (fields.cost !== undefined) usage.cost.total = fields.cost;
	return usage;
}

/** Price of a usage's delivered tokens at MODEL's rates, in USD. */
function priceOf(fields: Partial<Record<BilledField, number>>): number {
	return calculateCost(MODEL, usageOf(fields)).total;
}

describe("discardAttemptUsage", () => {
	it("carries every billed token bucket a Usage has", () => {
		// The compile-time union and the run-time shape must be the same set: a new
		// numeric bucket on Usage reddens here until someone decides if it is billed.
		expect([...BILLED_TOKEN_FIELDS].sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);

		const discarded = usageOf({ input: 1, output: 2, cacheRead: 4, cacheWrite: 8 });
		const next = discardAttemptUsage(MODEL, discarded, emptyUsage());

		expect(next.discarded?.attempts).toBe(1);
		for (const field of BILLED_TOKEN_FIELDS) {
			expect(next.discarded?.[field]).toBe(discarded[field]);
		}
	});

	it("leaves the delivered token fields alone so the context meter is unchanged", () => {
		const survivor = usageOf({ input: 120, output: 30 });
		discardAttemptUsage(MODEL, usageOf({ input: 10_000, cacheWrite: 50_000 }), survivor);

		expect(survivor.input).toBe(120);
		expect(survivor.output).toBe(30);
		expect(survivor.cacheRead).toBe(0);
		expect(survivor.cacheWrite).toBe(0);
		expect(survivor.totalTokens).toBe(150);
	});

	it("prices an attempt that died before its provider priced it", () => {
		// Devin and the pre-content Anthropic failures both look like this: tokens
		// reported on the wire, cost never computed, attempt thrown away.
		const survivor = usageOf({ input: 12, output: 4 });
		calculateCost(MODEL, survivor);
		discardAttemptUsage(MODEL, usageOf({ input: 10_000, cacheWrite: 50_000 }), survivor);

		expect(survivor.discarded?.cost).toBeCloseTo(priceOf({ input: 10_000, cacheWrite: 50_000 }), 10);
		expect(survivor.cost.total).toBeCloseTo(priceOf({ input: 12, output: 4 }) + survivor.discarded!.cost, 10);
		// The buckets still describe the delivered tokens; the gap is the discard.
		expect(survivor.cost.input).toBeCloseTo((12 * 3) / 1_000_000, 12);
	});

	it("keeps the price an attempt already carried instead of recomputing it", () => {
		// A provider that applied a service-tier multiplier owns that number: the
		// discard must not re-derive a cheaper one from the token counts.
		const priced = usageOf({ input: 1_000, cost: 9.99 });
		const survivor = emptyUsage();
		discardAttemptUsage(MODEL, priced, survivor);

		expect(survivor.discarded?.cost).toBe(9.99);
		expect(survivor.cost.total).toBe(9.99);
	});

	it("survives a service-tier rescale of the delivered buckets", () => {
		// The Codex and OpenAI tier paths rescale the buckets after pricing and then
		// re-total. Re-totalling by hand is what used to erase the discarded spend.
		const survivor = usageOf({ input: 1_000, output: 500 });
		discardAttemptUsage(MODEL, usageOf({ input: 4_000 }), survivor);
		calculateCost(MODEL, survivor);
		const discardedCost = survivor.discarded?.cost ?? 0;

		survivor.cost.input *= 2;
		survivor.cost.output *= 2;
		survivor.cost.cacheRead *= 2;
		survivor.cost.cacheWrite *= 2;
		recomputeCostTotal(survivor);

		expect(discardedCost).toBeCloseTo(priceOf({ input: 4_000 }), 10);
		expect(survivor.cost.total).toBeCloseTo(2 * priceOf({ input: 1_000, output: 500 }) + discardedCost, 10);
	});

	it("accumulates a chain of discarded attempts through the usage that replaces each one", () => {
		// Three attempts, each thrown away by the next: the survivor owes for all of
		// them, and says how many there were.
		let current = emptyUsage();
		for (const input of [100, 200, 400]) {
			current = discardAttemptUsage(MODEL, usageOf({ input }), current);
		}

		expect(current.discarded?.attempts).toBe(3);
		expect(current.discarded?.input).toBe(700);
		expect(current.discarded?.cost).toBeCloseTo(priceOf({ input: 700 }), 10);
		expect(current.cost.total).toBeCloseTo(priceOf({ input: 700 }), 10);
	});

	it("adds nothing when the abandoned attempt billed nothing", () => {
		const survivor = usageOf({ input: 10 });
		discardAttemptUsage(MODEL, emptyUsage(), survivor);

		expect(survivor.discarded).toBeUndefined();
		expect(survivor.cost.total).toBe(0);
	});
});

type MockAnthropicEvent = Record<string, unknown>;

function anthropicMessageStart(inputTokens: number, cacheWriteTokens: number): MockAnthropicEvent {
	return {
		type: "message_start",
		message: {
			id: "msg_attempt",
			usage: {
				input_tokens: inputTokens,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: cacheWriteTokens,
			},
		},
	};
}

function anthropicSuccessEvents(): MockAnthropicEvent[] {
	return [
		anthropicMessageStart(12, 0),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

/** An Anthropic client whose first attempt bills a prompt and then dies. */
function clientDyingAfterMessageStart(billedInput: number, billedCacheWrite: number): AnthropicMessagesClientLike {
	let attempt = 0;
	const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
		attempt += 1;
		const failing = attempt === 1;
		const events = failing ? [anthropicMessageStart(billedInput, billedCacheWrite)] : anthropicSuccessEvents();
		const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
		return {
			async withResponse() {
				return {
					data: {
						async *[Symbol.asyncIterator]() {
							for (const event of events) yield event;
							if (failing) {
								// A connection that drops before the first content block: the
								// prompt is billed, nothing is replayable, the loop retries.
								throw new AIError.ProviderResponseError("stream ended without a terminal event", {
									provider: "anthropic",
									kind: "incomplete-stream",
								});
							}
						},
					},
					response,
					request_id: response.headers.get("request-id"),
					signal: requestOptions?.signal,
				};
			},
		} as never;
	}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
	return { messages: { create } } as AnthropicMessagesClientLike;
}

describe("a retried provider attempt", () => {
	it("bills the prompt of an Anthropic stream that died before its first content block", async () => {
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal: AbortSignal | undefined) => {});
		const result = await streamAnthropic(MODEL, CONTEXT, {
			client: clientDyingAfterMessageStart(10_000, 50_000),
			providerRetryWait,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		// The cache WRITE is the whole point: the retry reads the cache cheaply and
		// the attempt that paid to create it is the one that got thrown away.
		expect(result.usage.discarded).toEqual({
			attempts: 1,
			input: 10_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 50_000,
			cost: priceOf({ input: 10_000, cacheWrite: 50_000 }),
		});
		// The delivered message still describes only the attempt that survived.
		expect(result.usage.input).toBe(12);
		expect(result.usage.cacheWrite).toBe(0);
		expect(result.usage.cost.total).toBeCloseTo(
			priceOf({ input: 12, output: 4 }) + priceOf({ input: 10_000, cacheWrite: 50_000 }),
			10,
		);
	});
});

function assistantWith(usage: Usage, texts: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: texts.map(text => ({ type: "text" as const, text })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		timestamp: 1,
		stopReason: "stop",
		usage,
	};
}

function streamOf(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

describe("an empty completion that is asked again", () => {
	it("bills the prompt of every empty attempt on the message finally delivered", async () => {
		const emptyUsageBilled = () => usageOf({ input: 5_000, cacheWrite: 20_000 });
		let attempts = 0;
		const stream = withEmptyCompletionRetry(MODEL, CONTEXT, { providerRetryWait: async () => {} }, () => {
			attempts += 1;
			if (attempts === 1) {
				const empty = assistantWith(emptyUsageBilled());
				return streamOf([
					{ type: "start", partial: empty },
					{ type: "done", reason: "stop", message: empty },
				]);
			}
			const delivered = assistantWith(usageOf({ input: 20, output: 7 }), ["hello"]);
			calculateCost(MODEL, delivered.usage);
			return streamOf([
				{ type: "start", partial: delivered },
				{ type: "text_start", contentIndex: 0, partial: delivered },
				{ type: "text_delta", contentIndex: 0, delta: "hello", partial: delivered },
				{ type: "text_end", contentIndex: 0, content: "hello", partial: delivered },
				{ type: "done", reason: "stop", message: delivered },
			]);
		});

		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
		expect(result.usage.discarded?.attempts).toBe(1);
		expect(result.usage.discarded?.input).toBe(5_000);
		expect(result.usage.discarded?.cacheWrite).toBe(20_000);
		expect(result.usage.cost.total).toBeCloseTo(
			priceOf({ input: 20, output: 7 }) + priceOf({ input: 5_000, cacheWrite: 20_000 }),
			10,
		);
	});
});

const GEMINI: Model<"google-generative-ai"> = buildModel({
	id: "gemini-2.5-pro",
	name: "Gemini 2.5 Pro",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.625 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

/**
 * A degenerate near-duplicate reasoning loop: the same paragraph intent with
 * cosmetic wording drift, blank-line separated (the gemini-3.5-flash shape the
 * detector was built for).
 */
function nearDuplicateLoop(paragraphs: number): string {
	const variants = [
		"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
		"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
		"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
	];
	const out: string[] = [];
	for (let i = 0; i < paragraphs; i++) {
		out.push(`**Confirming Safety ${i}**\n\n${variants[i % variants.length]}`);
	}
	return out.join("\n\n\n");
}

describe("an aborted thinking loop", () => {
	it("reports the tokens it sampled before the guard tore the stream down", async () => {
		const sampled = emptyUsage();
		sampled.output = 8_000;
		sampled.input = 1_200;
		sampled.totalTokens = 9_200;
		calculateCost(GEMINI, sampled);
		const partial = assistantWith(sampled);

		const guarded = withGeminiThinkingLoopGuard(GEMINI, undefined, () => {
			const inner = new AssistantMessageEventStream();
			for (const event of [
				{ type: "start" as const, partial },
				{ type: "thinking_start" as const, contentIndex: 0, partial },
				{ type: "thinking_delta" as const, contentIndex: 0, delta: nearDuplicateLoop(12), partial },
			]) {
				inner.push(event);
			}
			return inner;
		});

		const result = await guarded.result();

		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		// A loop bills for every repeated token it sampled. The stall replaces the
		// attempt, so the stall is what has to carry the bill.
		expect(result.usage.discarded?.attempts).toBe(1);
		expect(result.usage.discarded?.output).toBe(8_000);
		expect(result.usage.discarded?.input).toBe(1_200);
		expect(result.usage.cost.total).toBeCloseTo(calculateCost(GEMINI, { ...sampled, cost: emptyCost() }).total, 10);
	});
});

/** Gemini SSE chunk, top-level `candidates` shape. */
function geminiChunk(text: string, usageMetadata: Record<string, number>): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata,
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const GEMINI_SSE: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.625 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

describe("a Gemini turn that answered with nothing", () => {
	it("bills the prompt and the thinking of the empty attempt that got asked again", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1
				? // Thought for 900 tokens, answered with an empty text part: every one of
					// those tokens is billed and none of them reach the operator.
					geminiChunk("", { promptTokenCount: 30_000, candidatesTokenCount: 0, thoughtsTokenCount: 900 })
				: geminiChunk("Hello!", { promptTokenCount: 30_000, candidatesTokenCount: 5, thoughtsTokenCount: 0 });
		};

		const stream = streamGoogle(GEMINI_SSE, CONTEXT, { apiKey: "k", fetch: fetchMock });
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(result.usage.discarded?.attempts).toBe(1);
		expect(result.usage.discarded?.input).toBe(30_000);
		expect(result.usage.discarded?.output).toBe(900);
		expect(result.usage.input).toBe(30_000);
		expect(result.usage.cost.total).toBeGreaterThan(result.usage.cost.input + result.usage.cost.output);
	});
});

const OPENAI: Model<"openai-responses"> = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

describe("a service-tier surcharge", () => {
	it("rescales the delivered tokens without dropping the discarded attempt", () => {
		const usage = usageOf({ input: 1_000, output: 100 });
		discardAttemptUsage(OPENAI, usageOf({ input: 8_000 }), usage);
		calculateCost(OPENAI, usage);
		const discardedCost = usage.discarded?.cost ?? 0;
		const deliveredCost = usage.cost.input + usage.cost.output;

		applyOpenAIResponsesServiceTierCost(OPENAI, usage, "priority", "priority");

		expect(discardedCost).toBeGreaterThan(0);
		// Whatever the multiplier is, the discarded spend is still in the total.
		expect(usage.cost.total).toBeGreaterThan(deliveredCost + discardedCost);
		expect(usage.cost.total - (usage.cost.input + usage.cost.output)).toBeCloseTo(discardedCost, 10);
	});
});

const LOOP_API = "test-discarded-loop";

const LOOPING: Model<Api> = buildModel({
	id: "gemini-3.5-flash",
	name: "Looping Gemini",
	api: LOOP_API,
	provider: "openrouter",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.625 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

const COOK_API = "test-discarded-cook";

const COOKING: Model<Api> = buildModel({
	id: "gemini-3.5-pro",
	name: "Cooking Gemini",
	api: COOK_API,
	provider: "openrouter",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.625 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

describe("a re-sampled thinking loop", () => {
	it("carries the abandoned sample onto the answer the re-sample delivers", async () => {
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let attempts = 0;
		registerCustomApi(LOOP_API, (model, _context, _options) => {
			attempts += 1;
			const looping = attempts === 1;
			const usage = usageOf(looping ? { input: 1_200, output: 8_000 } : { input: 1_200, output: 20 });
			calculateCost(model, usage);
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 1,
				stopReason: "stop",
				usage,
			};
			const inner = new AssistantMessageEventStream();
			inner.push({ type: "start", partial });
			if (looping) {
				// Streams the loop and never terminates: the guard aborts it.
				inner.push({ type: "thinking_start", contentIndex: 0, partial });
				inner.push({ type: "thinking_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial });
				return inner;
			}
			partial.content = [{ type: "text", text: "done" }];
			inner.push({ type: "text_start", contentIndex: 0, partial });
			inner.push({ type: "text_delta", contentIndex: 0, delta: "done", partial });
			inner.push({ type: "text_end", contentIndex: 0, content: "done", partial });
			inner.push({ type: "done", reason: "stop", message: partial });
			return inner;
		});

		try {
			const result = await completeSimple(LOOPING, CONTEXT);

			expect(attempts).toBe(2);
			expect(result.stopReason).toBe("stop");
			expect(result.usage.discarded?.attempts).toBe(1);
			expect(result.usage.discarded?.output).toBe(8_000);
			expect(result.usage.cost.total).toBeCloseTo(
				calculateCost(LOOPING, usageOf({ input: 1_200, output: 20 })).total +
					calculateCost(LOOPING, usageOf({ input: 1_200, output: 8_000 })).total,
				10,
			);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});
});

describe("inheritUsageCarryovers", () => {
	it("carries a wholesale replacement's discarded bucket and premium-request counter", () => {
		const previous = usageOf({ input: 10 });
		discardAttemptUsage(MODEL, usageOf({ input: 7_000 }), previous);
		previous.premiumRequests = 3;
		const next = usageOf({ input: 40 });

		expect(inheritUsageCarryovers(previous, next)).toBe(next);
		expect(next.discarded).toBe(previous.discarded);
		expect(next.premiumRequests).toBe(3);
	});

	it("lets the replacement's own premium-request count win, since it is the newer report", () => {
		const previous = usageOf({ input: 10 });
		previous.premiumRequests = 3;
		const next = usageOf({ input: 40 });
		next.premiumRequests = 5;

		inheritUsageCarryovers(previous, next);

		expect(next.premiumRequests).toBe(5);
		expect(next.discarded).toBeUndefined();
	});
});

describe("a Responses turn whose accounting arrives in one wire field", () => {
	it("keeps the discarded attempt and the premium-request count across the rebuild", () => {
		const message = assistantWith(usageOf({ input: 5 }));
		discardAttemptUsage(OPENAI, usageOf({ input: 9_000, cacheWrite: 1_000 }), message.usage);
		message.usage.premiumRequests = 2;
		const carried = message.usage.discarded;

		populateResponsesUsageFromResponse(message, {
			input_tokens: 120,
			output_tokens: 30,
			total_tokens: 150,
			input_tokens_details: { cached_tokens: 0 },
		});

		expect(message.usage.input).toBe(120);
		expect(message.usage.discarded).toEqual(carried);
		expect(message.usage.premiumRequests).toBe(2);
	});
});

const GEMINI_CLI: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 1.625 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

/** `{ response: { candidates } }` envelope, the Cloud Code Assist shape. */
function ccaResponse(text: string, usageMetadata: Record<string, number>): Response {
	const chunk = {
		response: {
			candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
			usageMetadata,
		},
	};
	const response = new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
	// Cloud Code Assist re-fetches `response.url` on retry; a synthetic Response defaults it to "".
	Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
	return response;
}

describe("a Cloud Code Assist turn that answered with nothing", () => {
	it("carries the empty attempt's spend through the retry and through the next usage report", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1
				? ccaResponse("", { promptTokenCount: 24_000, candidatesTokenCount: 0, thoughtsTokenCount: 600 })
				: ccaResponse("Hi.", { promptTokenCount: 24_000, candidatesTokenCount: 4, thoughtsTokenCount: 0 });
		};

		const result = await streamGoogleGeminiCli(GEMINI_CLI, CONTEXT, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		}).result();

		expect(calls).toBe(2);
		expect(result.usage.discarded?.attempts).toBe(1);
		expect(result.usage.discarded?.input).toBe(24_000);
		expect(result.usage.discarded?.output).toBe(600);
		expect(result.usage.input).toBe(24_000);
		expect(result.usage.cost.total).toBeGreaterThan(result.usage.cost.input + result.usage.cost.output);
	});
});

const DEVIN: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

/** One length-prefixed Connect frame. `flag` 0 is a message, 2 ends the stream. */
function connectFrame(flag: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	new DataView(out.buffer).setUint32(1, payload.length, false);
	out[0] = flag;
	out.set(payload, 5);
	return out;
}

function devinFrames(...frames: Uint8Array[]): Response {
	let total = 0;
	for (const frame of frames) total += frame.length;
	const body = new Uint8Array(total);
	let at = 0;
	for (const frame of frames) {
		body.set(frame, at);
		at += frame.length;
	}
	return new Response(body, { status: 200 });
}

function devinUsageFrame(inputTokens: number, cacheWriteTokens: number): Uint8Array {
	const message = create(GetChatMessageResponseSchema, {
		usage: create(ModelUsageStatsSchema, {
			inputTokens: BigInt(inputTokens),
			outputTokens: 0n,
			cacheReadTokens: 0n,
			cacheWriteTokens: BigInt(cacheWriteTokens),
		}),
	});
	return connectFrame(0, toBinary(GetChatMessageResponseSchema, message));
}

function devinTextFrame(text: string, outputTokens: number): Uint8Array {
	const message = create(GetChatMessageResponseSchema, {
		deltaText: text,
		usage: create(ModelUsageStatsSchema, {
			inputTokens: 40n,
			outputTokens: BigInt(outputTokens),
			cacheReadTokens: 0n,
			cacheWriteTokens: 0n,
		}),
	});
	return connectFrame(0, toBinary(GetChatMessageResponseSchema, message));
}

function devinTrailerFrame(code: string, message: string): Uint8Array {
	return connectFrame(2, new TextEncoder().encode(JSON.stringify({ error: { code, message } })));
}

describe("a Devin turn re-run from the start", () => {
	it("bills the abandoned attempt's prompt onto the message the re-run delivers", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		let turns = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) return new Response(authPayload);
			turns += 1;
			return turns === 1
				? // Reported 30 000 prompt tokens and a 12 000-token cache write, then the
					// server said it was unavailable before a single output token: the whole
					// turn is re-run and every one of those tokens is already billed.
					devinFrames(devinUsageFrame(30_000, 12_000), devinTrailerFrame("unavailable", "temporarily down"))
				: devinFrames(devinTextFrame("Hello.", 6));
		}) as typeof fetch;

		const result = await streamDevin(DEVIN, CONTEXT, {
			apiKey: "token",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(turns).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.usage.discarded?.attempts).toBe(1);
		expect(result.usage.discarded?.input).toBe(30_000);
		expect(result.usage.discarded?.cacheWrite).toBe(12_000);
		expect(result.usage.input).toBe(40);
		expect(result.usage.cost.total).toBeGreaterThan(result.usage.cost.input + result.usage.cost.output);
	});
});

const CODEX: Model<"openai-codex-responses"> = buildModel({
	id: "gpt-5-codex",
	name: "GPT-5 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	preferWebsockets: false,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
});

function codexSse(...events: Record<string, unknown>[]): Response {
	const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function codexCompleted(inputTokens: number, outputTokens: number): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			status: "completed",
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				total_tokens: inputTokens + outputTokens,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
}

// Codex answers with a priced, content-free response, so the empty-completion
// wrapper is what asks again. The row is here because the wrapper's carry has to
// hold through a real provider's terminal accounting, not only through a fake.
describe("a Codex response that billed 50 000 tokens and said nothing", () => {
	it("keeps that spend on the answer the second request delivers", async () => {
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1
				? codexSse(codexCompleted(50_000, 0))
				: codexSse(
						{
							type: "response.output_item.done",
							item: {
								type: "message",
								id: "msg_1",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Hi." }],
							},
						},
						codexCompleted(17, 4),
					);
		};

		try {
			const result = await streamOpenAICodexResponses(CODEX, CONTEXT, {
				apiKey: "aaa.bbb.ccc",
				fetch: fetchMock,
			}).result();

			expect(calls).toBe(2);
			expect(result.usage.discarded?.attempts).toBe(1);
			expect(result.usage.discarded?.input).toBe(50_000);
			expect(result.usage.input).toBe(17);
			expect(result.usage.cost.total).toBeGreaterThan(result.usage.cost.input + result.usage.cost.output);
		} finally {
			waitSpy.mockRestore();
		}
	});
});

describe("a thinking loop that never stops looping", () => {
	it("carries every abandoned sample onto the answer the unguarded pass finally cooks", async () => {
		const waitSpy = spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let guarded = 0;
		registerCustomApi(COOK_API, (model, _context, options) => {
			const unguarded = options?.loopGuard?.enabled === false;
			if (!unguarded) guarded += 1;
			const usage = usageOf(unguarded ? { input: 900, output: 30 } : { input: 900, output: 5_000 });
			calculateCost(model, usage);
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 1,
				stopReason: "stop",
				usage,
			};
			const inner = new AssistantMessageEventStream();
			inner.push({ type: "start", partial });
			inner.push({ type: "thinking_start", contentIndex: 0, partial });
			inner.push({ type: "thinking_delta", contentIndex: 0, delta: nearDuplicateLoop(12), partial });
			if (!unguarded) return inner;
			// Guard off: the loop is allowed to finish, which is what "cook" means.
			partial.content = [{ type: "thinking", thinking: "looped" }];
			inner.push({ type: "thinking_end", contentIndex: 0, content: "looped", partial });
			inner.push({ type: "done", reason: "stop", message: partial });
			return inner;
		});

		try {
			const result = await completeSimple(COOKING, CONTEXT);

			// Three guarded samples were abandoned before the unguarded pass ran.
			expect(guarded).toBe(3);
			expect(result.stopReason).toBe("stop");
			expect(result.usage.discarded?.attempts).toBe(3);
			expect(result.usage.discarded?.output).toBe(15_000);
			expect(result.usage.output).toBe(30);
		} finally {
			waitSpy.mockRestore();
			clearCustomApis();
		}
	});
});
