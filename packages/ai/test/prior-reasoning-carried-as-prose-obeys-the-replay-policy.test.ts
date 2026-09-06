import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	DemotedReasoningSource,
	Message,
	Model,
	ProviderSessionState,
} from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * WHY: a user-interrupted turn's unfinished reasoning is carried to the next
 * request as prose in a hidden text message rather than as a thinking block,
 * because an unsigned block cannot be replayed under signature. That message
 * bypassed the unsigned-thinking replay policy entirely: a same-model replay on
 * a signing Anthropic endpoint, which drops an unsigned block up front, still
 * sent the prose; and the `reasoning_extraction` refusal retry, which clears
 * `replayDemotedPriorReasoning`, rebuilt the request from the same messages and
 * re-sent the same bytes. Claude Fable refused the retry, the refusal surfaced
 * as the turn's error, and every later turn of the session — which still held
 * the message — refused the same way.
 *
 * THE CLASS: prior-turn reasoning that reaches the provider in any slot other
 * than an assistant thinking block. A text message declares its origin through
 * `demotedReasoningSource`, and `transformMessages` applies to it the same drop
 * rules the assistant branch applies to an unsigned thinking block, before any
 * provider-specific encoding.
 *
 * WHAT THIS DOES NOT CATCH: a text message that carries reasoning without the
 * tag (the negative control below shows it reaching the wire, which is the
 * pre-fix behavior; a new producer of such a message has to tag it), and
 * Bedrock-hosted Claude, whose Converse wire exposes no refusal category to
 * learn from.
 */

const INTERRUPTED_REASONING = "I was weighing the two migration paths and had settled on the second.";

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

/** An anthropic-messages reasoning endpoint that replays unsigned thinking natively and fronts no classifier. */
const nativeReplayTarget: Model<"anthropic-messages"> = buildModel({
	id: "glm-4.6",
	name: "GLM 4.6",
	api: "anthropic-messages",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const USAGE = {
	input_tokens: 12,
	output_tokens: 4,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
};

function assistantTurn(model: Model, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	} satisfies AssistantMessage;
}

/**
 * The shape the session produces after a user interrupt: the aborted turn with
 * its run already stripped, then the hidden continuity message carrying the run
 * as prose, then the user's next prompt.
 */
function interruptedContext(
	source: DemotedReasoningSource | undefined,
	interruptedModel: Model = signingTarget,
): Context {
	const continuity: Message = {
		role: "developer",
		content: [
			{
				type: "text",
				text: `Your previous turn was interrupted while you were thinking.\n${INTERRUPTED_REASONING}`,
			},
		],
		attribution: "agent",
		timestamp: 0,
		...(source ? { demotedReasoningSource: source } : {}),
	};
	return {
		messages: [
			{ role: "user", content: "Plan the migration.", timestamp: 0 },
			assistantTurn(interruptedModel, [{ type: "text", text: "[Interrupted by user]" }], "aborted"),
			continuity,
			{ role: "user", content: "Go on.", timestamp: 0 },
		],
	};
}

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
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Continuing." } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: USAGE },
			{ type: "message_stop" },
		],
		"req_ok",
	);
}

/** Every byte of the request, so reasoning cannot hide in another slot. */
function serialized(params: unknown): string {
	return JSON.stringify(params);
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<void> {
	for await (const _event of stream) {
		// The events themselves are asserted through the returned result.
	}
}

/** Refuse while the prose is on the wire, answer once it is gone: the refusal count is the cost the session paid. */
function endpointThatRefusesTheProse(captured: unknown[]): { attempts: () => number } {
	let attempts = 0;
	vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
		attempts += 1;
		captured.push(params);
		return (serialized(params).includes(INTERRUPTED_REASONING) ? refusalRequest() : successRequest()) as never;
	});
	return { attempts: () => attempts };
}

describe("prior reasoning carried as prose obeys the unsigned-thinking replay policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never sends a same-model run to a signing endpoint, so no refusal is spent", async () => {
		const captured: unknown[] = [];
		const endpoint = endpointThatRefusesTheProse(captured);

		const stream = streamAnthropic(
			signingTarget,
			interruptedContext({ provider: signingTarget.provider, model: signingTarget.id }),
			{ apiKey: "sk-ant-test", providerSessionState: new Map<string, ProviderSessionState>() },
		);
		await drain(stream);
		const result = await stream.result();

		expect(endpoint.attempts()).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(serialized(captured[0])).not.toContain(INTERRUPTED_REASONING);
		// Only the continuity message went; the aborted turn and the prompts stay.
		expect(serialized(captured[0])).toContain("[Interrupted by user]");
		expect(serialized(captured[0])).toContain("Go on.");
	});

	it("replays a cross-model run until the endpoint refuses, then the retry drops it and the session stays clean", async () => {
		const captured: unknown[] = [];
		const endpoint = endpointThatRefusesTheProse(captured);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const context = interruptedContext({ provider: "openrouter", model: "deepseek-reasoner" });

		const first = streamAnthropic(signingTarget, context, { apiKey: "sk-ant-test", providerSessionState });
		await drain(first);
		const firstResult = await first.result();

		// One refusal, then the retry without the prose completes the turn.
		expect(endpoint.attempts()).toBe(2);
		expect(firstResult.stopReason).toBe("stop");
		expect(firstResult.errorMessage).toBeUndefined();
		expect(serialized(captured[0])).toContain(INTERRUPTED_REASONING);
		expect(serialized(captured[1])).not.toContain(INTERRUPTED_REASONING);

		// The message is still in history on the next turn; the learned flag drops it before the first attempt.
		const second = streamAnthropic(signingTarget, context, { apiKey: "sk-ant-test", providerSessionState });
		await drain(second);
		expect((await second.result()).stopReason).toBe("stop");
		expect(endpoint.attempts()).toBe(3);
		expect(serialized(captured[2])).not.toContain(INTERRUPTED_REASONING);
	});

	it("treats a run of unknown origin as cross-model: replayed until refused, then dropped", async () => {
		const captured: unknown[] = [];
		const endpoint = endpointThatRefusesTheProse(captured);

		const stream = streamAnthropic(signingTarget, interruptedContext({}), {
			apiKey: "sk-ant-test",
			providerSessionState: new Map<string, ProviderSessionState>(),
		});
		await drain(stream);

		expect(endpoint.attempts()).toBe(2);
		expect((await stream.result()).stopReason).toBe("stop");
		expect(serialized(captured[1])).not.toContain(INTERRUPTED_REASONING);
	});

	it("keeps the run for an endpoint that replays unsigned thinking natively and fronts no classifier", () => {
		const transformed = transformMessages(
			interruptedContext({ provider: nativeReplayTarget.provider, model: nativeReplayTarget.id }, nativeReplayTarget)
				.messages,
			nativeReplayTarget,
		);

		expect(serialized(transformed)).toContain(INTERRUPTED_REASONING);
	});

	it("keeps the run for a target that is not anthropic-messages", () => {
		const openaiTarget: Model = buildModel({
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});

		const transformed = transformMessages(
			interruptedContext({ provider: openaiTarget.provider, model: openaiTarget.id }, openaiTarget).messages,
			openaiTarget,
		);

		expect(serialized(transformed)).toContain(INTERRUPTED_REASONING);
	});

	it("negative control: the same bytes without the tag reach the wire, and the retry cannot remove them", async () => {
		const captured: unknown[] = [];
		const endpoint = endpointThatRefusesTheProse(captured);

		const stream = streamAnthropic(signingTarget, interruptedContext(undefined), {
			apiKey: "sk-ant-test",
			providerSessionState: new Map<string, ProviderSessionState>(),
		});
		await drain(stream);
		const result = await stream.result();

		// Bounded: one retry, then the refusal surfaces. This is the pre-fix
		// behavior for an untagged carrier, pinned so a producer that forgets the
		// tag is a visible defect rather than a silent one.
		expect(endpoint.attempts()).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("reasoning_extraction");
		expect(serialized(captured[1])).toContain(INTERRUPTED_REASONING);
	});
});
