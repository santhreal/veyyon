/**
 * WHY: "did this turn produce anything worth delivering?" must have ONE owner.
 *
 * `emptyLengthFinishIsContextError` is set for exactly one provider — `ollama`
 * (see `buildOpenAICompat` in @veyyon/catalog) — so an Ollama model reaches this
 * normalization down either of two streams: natively through `ollama-chat`, or
 * through `openai-completions` when the catalog resolves it to the OpenAI-compatible
 * endpoint. Both must classify a length-capped turn identically; the endpoint a
 * model happens to resolve to is not something a user can see or reason about.
 *
 * The regression this guards: `ollama.ts` kept a private `hasVisibleAssistantContent`
 * beside the exported one in `utils/empty-completion-retry.ts`, and the two drifted —
 * the private copy counted a thinking block as visible content. A reasoning model that
 * burned its whole context window on thinking therefore returned a silent, contentless
 * `length` turn on `ollama-chat` while `openai-completions` correctly surfaced the
 * actionable "raise num_ctx" error for the very same response.
 */
import { describe, expect, it } from "bun:test";
import { streamOllama } from "@veyyon/ai/providers/ollama";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const CONTEXT_WINDOW_ERROR =
	"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.";

/** A reasoning Ollama model on whichever endpoint the catalog resolved it to. */
function ollamaReasoningModel<A extends "ollama-chat" | "openai-completions">(api: A): Model<A> {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api,
		provider: "ollama",
		baseUrl: "http://localhost:11434/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
	}) as Model<A>;
}

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Continue the task.", timestamp: 0 }] };
}

describe("an Ollama length finish is classified by one owner", () => {
	// The native NDJSON stream: thinking arrives on `message.thinking`, and the
	// turn is cut off by the context window (`done_reason: "length"`) having
	// emitted no text and no tool call.
	it("reports a thinking-only length finish as a context-window error on ollama-chat", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(
					`${JSON.stringify({
						message: { thinking: "weighing the options at length", content: "" },
						done: true,
						done_reason: "length",
						prompt_eval_count: 4000,
						eval_count: 96,
					})}\n`,
					{ status: 200 },
				),
			);

		const result = await streamOllama(ollamaReasoningModel("ollama-chat"), baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(CONTEXT_WINDOW_ERROR);
	});

	// The OpenAI-compatible stream for the same backend: thinking arrives on
	// `delta.reasoning_content`, and `finish_reason: "length"` closes the turn.
	it("reports a thinking-only length finish as a context-window error on openai-completions", async () => {
		const chunks = [
			{ choices: [{ index: 0, delta: { reasoning_content: "weighing the options at length" } }] },
			{
				choices: [{ index: 0, delta: {}, finish_reason: "length" }],
				usage: { prompt_tokens: 4000, completion_tokens: 96, total_tokens: 4096 },
			},
		];
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				new Response(`${chunks.map(c => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

		const result = await streamOpenAICompletions(ollamaReasoningModel("openai-completions"), baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(CONTEXT_WINDOW_ERROR);
	});

	// Content the agent loop can actually act on keeps the plain `length` stop on
	// both surfaces — the error above is specific to a turn that delivered nothing.
	it("keeps a length finish that produced visible text on both surfaces", async () => {
		const ndjson: FetchImpl = () =>
			Promise.resolve(
				new Response(
					`${JSON.stringify({
						message: { thinking: "brief", content: "partial answer" },
						done: true,
						done_reason: "length",
						prompt_eval_count: 4000,
						eval_count: 96,
					})}\n`,
					{ status: 200 },
				),
			);
		const native = await streamOllama(ollamaReasoningModel("ollama-chat"), baseContext(), {
			apiKey: "test-key",
			fetch: ndjson,
		}).result();
		expect(native.stopReason).toBe("length");
		expect(native.errorMessage).toBeUndefined();

		const chunks = [
			{ choices: [{ index: 0, delta: { content: "partial answer" } }] },
			{
				choices: [{ index: 0, delta: {}, finish_reason: "length" }],
				usage: { prompt_tokens: 4000, completion_tokens: 96, total_tokens: 4096 },
			},
		];
		const sse: FetchImpl = () =>
			Promise.resolve(
				new Response(`${chunks.map(c => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
		const compat = await streamOpenAICompletions(ollamaReasoningModel("openai-completions"), baseContext(), {
			apiKey: "test-key",
			fetch: sse,
		}).result();
		expect(compat.stopReason).toBe("length");
		expect(compat.errorMessage).toBeUndefined();
	});
});
