import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderSessionState,
} from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * WHY: a request to a signing Anthropic endpoint that replays a prior turn's
 * reasoning as demoted prose is refused by Anthropic's `reasoning_extraction`
 * safety classifier, which ends the stream with
 * `stop_reason: "refusal"` and surfaces as
 * `Refusal (reasoning_extraction): …`. The prose is the request's, not the
 * model's: a cross-model prior turn crossing a signing endpoint has its source
 * signature stripped, cannot be replayed natively, and was demoted to text.
 * Nothing observed the refusal, so every following turn replayed the same prose
 * and the failure recurred for the rest of the session.
 *
 * THE CLASS: any endpoint that enforces the classifier, reached by any request
 * carrying prior-turn reasoning that cannot be replayed under signature. The
 * transport learns the endpoint's behavior once, drops that reasoning, and
 * retries, so a refusal never reaches the caller as a turn error.
 *
 * WHAT THIS DOES NOT CATCH: a refusal whose category is not
 * `reasoning_extraction` (surfaced verbatim, by design), a refusal that arrives
 * after content already streamed (retrying would duplicate visible output, so
 * the error surfaces), and the native signed-replay path, which sends
 * signatures rather than prose and never reaches the classifier.
 */

const PRIOR_REASONING = "Check the README, weigh both options, then answer.";

const signingTarget: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5-1",
	name: "Claude Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

/**
 * A prior assistant turn from a different model, signed by that model, with a
 * later assistant turn after it. Only a NON-latest turn has its foreign
 * signature stripped — Anthropic's byte-for-byte rule forbids rewriting the
 * latest message — and stripping is what leaves the block unsigned and
 * therefore demoted to prose by the encoder.
 */
const crossModelPriorTurn: Context = {
	messages: [
		{ role: "user", content: "Summarize README", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: PRIOR_REASONING, thinkingSignature: "sig_foreign" },
				{ type: "text", text: "The README covers the CLI." },
			],
			api: "anthropic-messages",
			provider: "openrouter",
			model: "deepseek-reasoner",
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
		} satisfies AssistantMessage,
		{ role: "user", content: "Now in one line.", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "text", text: "A CLI reference." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5-1",
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
		} satisfies AssistantMessage,
		{ role: "user", content: "Translate to French.", timestamp: 0 },
	] satisfies Message[],
};

const USAGE = {
	input_tokens: 12,
	output_tokens: 4,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};

function eventStream(events: readonly unknown[], requestId: string) {
	const response = new Response(null, { status: 200, headers: { "request-id": requestId } });
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of events) {
						yield event;
					}
				})(),
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

/** The classifier blocks the answer, so the envelope carries no content block. */
function refusalRequest() {
	return eventStream(
		[
			{ type: "message_start", message: { id: "msg_refusal", usage: { ...USAGE, output_tokens: 0 } } },
			{
				type: "message_delta",
				delta: {
					stop_reason: "refusal",
					stop_details: {
						type: "refusal",
						category: "reasoning_extraction",
						explanation: "Output blocked by content filtering policy",
					},
				},
				usage: USAGE,
			},
			{ type: "message_stop" },
		],
		"req_refusal",
	);
}

function successRequest() {
	return eventStream(
		[
			{ type: "message_start", message: { id: "msg_ok", usage: { ...USAGE, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: USAGE },
			{ type: "message_stop" },
		],
		"req_ok",
	);
}

interface WireBlock {
	type: string;
	thinking?: string;
	text?: string;
	signature?: string;
}
interface WireMessage {
	role: string;
	content: WireBlock[] | string;
}

function priorAssistantBlocks(params: unknown): WireBlock[] {
	if (!params || typeof params !== "object" || !("messages" in params)) return [];
	const { messages } = params as { messages?: WireMessage[] };
	if (!Array.isArray(messages)) return [];
	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content === "string") continue;
		return message.content;
	}
	return [];
}

/** Every byte of the request, so reasoning cannot hide in another slot. */
function serialized(params: unknown): string {
	return JSON.stringify(params);
}

function readPriorReasoningReplayDisabled(map: Map<string, ProviderSessionState>): boolean | undefined {
	for (const [key, value] of map) {
		if (!key.startsWith("anthropic-messages")) continue;
		if (typeof value !== "object" || value === null) continue;
		if (!("priorReasoningReplayDisabled" in value)) continue;
		const flag = value.priorReasoningReplayDisabled;
		return typeof flag === "boolean" ? flag : undefined;
	}
	return undefined;
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<void> {
	for await (const _event of stream) {
		// The events themselves are asserted through the returned result.
	}
}

describe("a reasoning_extraction refusal stops replaying demoted reasoning", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("replays prior reasoning as prose until the endpoint refuses, then drops it and retries", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const captured: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			captured.push(params);
			return (attempt === 1 ? refusalRequest() : successRequest()) as never;
		});

		const stream = streamAnthropic(signingTarget, crossModelPriorTurn, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		await drain(stream);
		const result = await stream.result();

		// The refusal never reaches the caller: the turn completed on the retry.
		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();

		// Attempt 1 is the defect's input: the reasoning demoted to prose.
		const firstBlocks = priorAssistantBlocks(captured[0]);
		expect(firstBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(serialized(captured[0])).toContain(PRIOR_REASONING);

		// The retry carries the reasoning in no form at all.
		const retryBlocks = priorAssistantBlocks(captured[1]);
		expect(retryBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(serialized(captured[1])).not.toContain(PRIOR_REASONING);
		// The turn's own text survives; only the reasoning was dropped.
		expect(retryBlocks.some(block => block.text === "The README covers the CLI.")).toBe(true);

		expect(readPriorReasoningReplayDisabled(providerSessionState)).toBe(true);
	});

	it("stops replaying prior reasoning on later turns without spending another refusal", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const captured: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			captured.push(params);
			return (attempt === 1 ? refusalRequest() : successRequest()) as never;
		});

		await drain(streamAnthropic(signingTarget, crossModelPriorTurn, { apiKey: "sk-ant-test", providerSessionState }));

		const second = streamAnthropic(signingTarget, crossModelPriorTurn, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		await drain(second);
		const result = await second.result();

		// Learned state means the next turn's FIRST attempt is already clean.
		expect(attempt).toBe(3);
		expect(result.stopReason).toBe("stop");
		expect(serialized(captured[2])).not.toContain(PRIOR_REASONING);
	});

	it("surfaces the refusal and stops after one retry when the retry is refused too", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return refusalRequest() as never;
		});

		const stream = streamAnthropic(signingTarget, crossModelPriorTurn, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});

		// Terminates rather than retrying the refusal forever, and the operator
		// gets the endpoint's own explanation.
		await drain(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("reasoning_extraction");
		expect(attempt).toBe(2);
	});

	it("keeps replaying demoted reasoning when the endpoint never refuses", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const captured: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			captured.push(params);
			return successRequest() as never;
		});

		const stream = streamAnthropic(signingTarget, crossModelPriorTurn, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		await drain(stream);

		// Cross-vendor reasoning still survives a model switch (#3434, #3528):
		// the drop is a response to an observed refusal, not a new default.
		expect(attempt).toBe(1);
		expect(serialized(captured[0])).toContain(PRIOR_REASONING);
		expect(readPriorReasoningReplayDisabled(providerSessionState)).not.toBe(true);
	});

	it("leaves a refusal of another category untouched", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(() => {
			attempt += 1;
			return eventStream(
				[
					{ type: "message_start", message: { id: "msg_other", usage: { ...USAGE, output_tokens: 0 } } },
					{
						type: "message_delta",
						delta: {
							stop_reason: "refusal",
							stop_details: { type: "refusal", category: "csam", explanation: "Blocked" },
						},
						usage: USAGE,
					},
					{ type: "message_stop" },
				],
				"req_other",
			) as never;
		});

		const stream = streamAnthropic(signingTarget, crossModelPriorTurn, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});

		// No retry: the request payload is not the cause, so resending it would
		// only spend another request on the same answer.
		await drain(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("csam");
		expect(attempt).toBe(1);
		expect(readPriorReasoningReplayDisabled(providerSessionState)).not.toBe(true);
	});
});

/**
 * The endpoint the refusal was reported against is not one of the statically
 * recognised signing hosts: OpenCode Zen fronts Claude at
 * `opencode.ai/zen/v1/messages` under its own host, so `signingEndpoint` is
 * false there and a rule keyed on it never fires. The same holds for a proxy
 * learned from a live signing 400 (#4297), which clears
 * `replayUnsignedThinking` and never sets `signingEndpoint`. What produces the
 * prose the classifier reads is the demotion, so that is what the drop is keyed
 * on.
 */
describe("a gateway that demotes unsigned thinking without being a known signing host", () => {
	const zenTarget: Model<"anthropic-messages"> = buildModel({
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1 (OpenCode Zen)",
		api: "anthropic-messages",
		provider: "opencode-zen",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: { replayUnsignedThinking: false },
	});

	/** Already unsigned, which is the only block the encoder demotes. */
	const unsignedPriorTurn: Context = {
		messages: [
			{ role: "user", content: "Summarize README", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: PRIOR_REASONING, thinkingSignature: "" },
					{ type: "text", text: "The README covers the CLI." },
				],
				api: "anthropic-messages",
				provider: "opencode-zen",
				model: "minimax-m3",
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
			} satisfies AssistantMessage,
			{ role: "user", content: "Translate to French.", timestamp: 0 },
		] satisfies Message[],
	};

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops the demoted reasoning on retry even though the host is not a known signing endpoint", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const captured: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			captured.push(params);
			return (attempt === 1 ? refusalRequest() : successRequest()) as never;
		});

		const stream = streamAnthropic(zenTarget, unsignedPriorTurn, {
			apiKey: "sk-zen-test",
			providerSessionState,
		});
		await drain(stream);
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(serialized(captured[0])).toContain(PRIOR_REASONING);
		expect(serialized(captured[1])).not.toContain(PRIOR_REASONING);
		expect(readPriorReasoningReplayDisabled(providerSessionState)).toBe(true);
	});
});
