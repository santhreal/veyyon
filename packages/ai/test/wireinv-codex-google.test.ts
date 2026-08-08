import { describe, expect, it } from "bun:test";
import { streamSimple } from "@veyyon/ai/stream";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * WHY: same 2026-08 incident class as wireinv-anthropic-thinking — bundled
 * rows losing their thinking surface silently dropped the reasoning control
 * from the request. This file pins two more bundled encodings END TO END
 * (streamSimple → resolveReasoningSelection → provider encoder) with a
 * recording FetchImpl against the real bundled rows:
 *
 *   - openai-codex/gpt-5.5 (effort mode): every declared tier serializes as
 *     `reasoning.effort` with the codex summary/context companions, and
 *     `reasoning.encrypted_content` is always requested so the next turn can
 *     replay reasoning. disableReasoning omits the `reasoning` field ENTIRELY
 *     (the codex backend's documented off encoding — a `reasoning` object
 *     without effort is not a substitute).
 *   - google/gemini-2.5-pro (budget mode, requiresEffort): every declared tier
 *     serializes as `thinkingConfig.thinkingBudget` from the documented
 *     schedule, and disableReasoning CANNOT omit thinking — the row requires
 *     an effort, so off is the ladder floor budget, never budget 0 (the 2.5-pro
 *     endpoint rejects a disabled/zero budget).
 *   - A tier outside the row's ladder MUST throw naming the declared ladder,
 *     and fetch MUST NOT be called.
 */

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const codex = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
const gemini = getBundledModel<"google-generative-ai">("google", "gemini-2.5-pro");

/** Documented Gemini 2.5 thinking-budget schedule (stream.ts getGoogleBudget contract). Drift here MUST fail loudly. */
const GEMINI_25_BUDGET_WIRE: Record<Effort, number> = {
	[Effort.Minimal]: 128,
	[Effort.Low]: 2048,
	[Effort.Medium]: 8192,
	[Effort.High]: 16_384,
	[Effort.XHigh]: 32_768,
	[Effort.Max]: 32_768,
};

function codexSse(): Response {
	const frames = [
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		})}`,
	];
	return new Response(`${frames.join("\n\n")}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function googleSse(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** The codex token endpoint shape the transport parses the account id out of. */
function codexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

/** Drive the full selection + encode path and return the exact request body, plus how often fetch ran. */
async function captureBody(
	model: Model<"openai-codex-responses"> | Model<"google-generative-ai">,
	options: { reasoning?: Effort; disableReasoning?: boolean },
): Promise<{ body: Record<string, unknown>; fetchCalls: number }> {
	let body: Record<string, unknown> | undefined;
	let fetchCalls = 0;
	const fetchMock: FetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		fetchCalls += 1;
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return model.api === "google-generative-ai" ? googleSse() : codexSse();
	}) as FetchImpl;
	const isCodex = model.api === "openai-codex-responses";
	for await (const event of streamSimple(model as never, context, {
		apiKey: isCodex ? codexTestToken() : "k",
		fetch: fetchMock,
		reasoning: options.reasoning,
		disableReasoning: options.disableReasoning,
		// The bundled codex row prefers websockets; pin the HTTP/SSE transport so
		// the recording FetchImpl observes the body.
		preferWebsockets: false,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected a captured request");
	return { body, fetchCalls };
}

describe("bundled codex/google rows declare their thinking surface (models.dev drift fails here)", () => {
	it("openai-codex/gpt-5.5 is effort mode with the low/medium/high/xhigh ladder", () => {
		expect(codex).toBeDefined();
		expect(codex.reasoningOptions).toEqual({
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(codex.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	it("google/gemini-2.5-pro is budget mode with the high/max pair and requiresEffort", () => {
		expect(gemini).toBeDefined();
		expect(gemini.reasoningOptions).toEqual({ efforts: [Effort.High, Effort.Max] });
		expect(gemini.thinking).toEqual({ mode: "budget", efforts: [Effort.High, Effort.Max], requiresEffort: true });
	});
});

describe("codex wire fidelity (openai-codex/gpt-5.5)", () => {
	// Encoder lines under test: openai-codex/request-transformer.ts getReasoningConfig /
	// mapCodexWireEffort (requireSupportedEffort + effortMap) and the
	// `include.push("reasoning.encrypted_content")` replay enabler. One test per
	// tier: the codex transport costs ~1.5s per captured request, and per-tier
	// identity names the broken tier directly.
	for (const tier of codex.thinking?.efforts ?? []) {
		it(`serializes ${tier} as reasoning.effort with summary, context, and encrypted-replay include`, async () => {
			const { body } = await captureBody(codex, { reasoning: tier });
			expect(body.reasoning).toEqual({ effort: tier, summary: "detailed", context: "all_turns" });
			expect(body.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
			expect(body.include).toContain("reasoning.encrypted_content");
		});
	}

	// Encoder line under test: request-transformer.ts `delete body.reasoning`
	// when no effort is set — off is omission, and the summary stream option
	// goes with it.
	it("disableReasoning omits the reasoning field entirely", async () => {
		const { body } = await captureBody(codex, { disableReasoning: true });
		expect(body.reasoning).toBeUndefined();
		expect(body.stream_options).toBeUndefined();
	});
});

describe("google budget wire fidelity (google/gemini-2.5-pro)", () => {
	// Encoder lines under test: stream.ts getGoogleBudget (2.5 id schedule) and
	// google-shared.ts `cfg.thinkingBudget = options.thinking.budgetTokens`.
	it("serializes every declared tier as thinkingConfig.thinkingBudget from the schedule", async () => {
		for (const tier of gemini.thinking?.efforts ?? []) {
			const { body } = await captureBody(gemini, { reasoning: tier });
			const config = body.generationConfig as { thinkingConfig?: Record<string, unknown> };
			expect(config.thinkingConfig).toEqual({
				includeThoughts: true,
				thinkingBudget: GEMINI_25_BUDGET_WIRE[tier],
			});
		}
	});

	// Selection line under test: model-thinking.ts resolveReasoningSelection
	// `thinking.requiresEffort` floor branch — a model that cannot switch
	// thinking off gets its ladder floor, never a zero/omitted budget the
	// endpoint would reject.
	it("disableReasoning on a requiresEffort row pins the floor budget instead of zero", async () => {
		const floor = gemini.thinking?.efforts[0];
		expect(floor).toBe(Effort.High);
		const { body } = await captureBody(gemini, { disableReasoning: true });
		const config = body.generationConfig as { thinkingConfig?: Record<string, unknown> };
		expect(config.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: GEMINI_25_BUDGET_WIRE[floor as Effort],
		});
	});
});

describe("out-of-ladder tiers never reach the wire", () => {
	async function expectRejected(
		model: Model<"openai-codex-responses"> | Model<"google-generative-ai">,
		tier: Effort,
	): Promise<void> {
		let fetchCalls = 0;
		const fetchMock: FetchImpl = (async () => {
			fetchCalls += 1;
			return model.api === "google-generative-ai" ? googleSse() : codexSse();
		}) as FetchImpl;
		let caught: unknown;
		try {
			const stream = streamSimple(model as never, context, {
				apiKey: model.api === "openai-codex-responses" ? codexTestToken() : "k",
				fetch: fetchMock,
				preferWebsockets: false,
				reasoning: tier,
			});
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}
			await stream.result();
		} catch (error) {
			caught = error;
		}
		const ladder = (model.thinking?.efforts ?? []).join(", ");
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			`Thinking effort ${tier} is not supported by ${model.provider}/${model.id}. Supported efforts: ${ladder}`,
		);
		expect(fetchCalls).toBe(0);
	}

	it("openai-codex/gpt-5.5 rejects max (ladder tops out at xhigh)", async () => {
		await expectRejected(codex, Effort.Max);
	});

	it("google/gemini-2.5-pro rejects medium (ladder is high/max)", async () => {
		await expectRejected(gemini, Effort.Medium);
	});
});
