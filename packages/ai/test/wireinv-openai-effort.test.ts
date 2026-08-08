import { describe, expect, it } from "bun:test";
import { streamSimple } from "@veyyon/ai/stream";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * WHY: same 2026-08 incident class as wireinv-anthropic-thinking — bundled
 * rows losing their thinking surface meant chat-completions requests went out
 * with a missing or wrong `reasoning_effort`, and hosts rejected or silently
 * mis-served them. This file pins the OpenAI chat-completions wire encoding
 * END TO END (streamSimple → resolveReasoningSelection → chat compat policy)
 * with a recording FetchImpl against the real bundled rows:
 *
 *   - fireworks/glm-5.2: every declared tier serializes as the literal
 *     `reasoning_effort` value (Fireworks exposes a real `max` top tier).
 *   - deepseek/deepseek-v4-pro: the literal `reasoning_effort` PLUS the
 *     catalog-baked `extraBody` thinking toggle `{ thinking: { type: "enabled" } }`.
 *   - disableReasoning on both: the hosts cannot be told to stop reasoning
 *     (`reasoningDisableMode: "lowest-effort"`), so the documented encoding is
 *     the LADDER FLOOR tier — never omission, never a fabricated "off" value.
 *   - A no-surface reasoner (reasoning: true, no declared thinking dial) MUST
 *     emit no reasoning field at all — plain, disabled, and even when an
 *     effort is requested (the "uncontrolled" contract: the model manages
 *     reasoning internally; fabricating a field would be a silent wrong value).
 *   - A tier outside the row's ladder MUST throw naming the declared ladder,
 *     and fetch MUST NOT be called.
 *
 * Ladders come off the bundled row and are also pinned against the expected
 * declaration, so models.dev drift fails loudly with a diff.
 */

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const glm = getBundledModel<"openai-completions">("fireworks", "glm-5.2");
const deepseek = getBundledModel<"openai-completions">("deepseek", "deepseek-v4-pro");
const noSurface = getBundledModel<"openai-completions">("aimlapi", "deepseek-v4-pro");

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface ChatCapture {
	body: Record<string, unknown>;
	fetchCalls: number;
}

/** Drive the full selection + encode path and return the exact request body the host would receive. */
async function captureChatBody(
	model: Model<"openai-completions">,
	options: { reasoning?: Effort; disableReasoning?: boolean },
): Promise<ChatCapture> {
	let body: Record<string, unknown> | undefined;
	let fetchCalls = 0;
	const fetchMock: FetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		fetchCalls += 1;
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	}) as FetchImpl;
	for await (const event of streamSimple(model, context, {
		apiKey: "k",
		fetch: fetchMock,
		reasoning: options.reasoning,
		disableReasoning: options.disableReasoning,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected a captured chat-completions request");
	return { body, fetchCalls };
}

describe("bundled chat-completions rows declare their thinking surface (models.dev drift fails here)", () => {
	it("fireworks/glm-5.2 is effort mode with the high/max pair", () => {
		expect(glm).toBeDefined();
		expect(glm.reasoningOptions).toEqual({ efforts: [Effort.High, Effort.Max] });
		expect(glm.thinking).toEqual({ mode: "effort", efforts: [Effort.High, Effort.Max] });
	});

	it("deepseek/deepseek-v4-pro is effort mode with the high/max pair and the baked thinking toggle", () => {
		expect(deepseek).toBeDefined();
		expect(deepseek.reasoningOptions).toEqual({ efforts: [Effort.High, Effort.Max] });
		expect(deepseek.thinking).toEqual({ mode: "effort", efforts: [Effort.High, Effort.Max] });
		expect(deepseek.compat.extraBody).toEqual({ thinking: { type: "enabled" } });
	});

	it("aimlapi/deepseek-v4-pro reasons but declares no controllable dial (the no-surface case)", () => {
		expect(noSurface).toBeDefined();
		expect(noSurface.reasoning).toBe(true);
		expect(noSurface.thinking).toBeUndefined();
	});
});

describe("effort-mode wire fidelity", () => {
	// Encoder lines under test: openai-shared.ts mapOpenAIReasoningEffort and
	// `params.reasoning_effort = reasoning.wireEffort` in applyChatCompletionsCompatPolicy.
	it("fireworks/glm-5.2 sends every declared tier as the literal reasoning_effort", async () => {
		for (const tier of glm.thinking?.efforts ?? []) {
			const { body } = await captureChatBody(glm, { reasoning: tier });
			// Wire tier comes from the row's own effortMap (identity when unmapped).
			expect(body.reasoning_effort).toBe(glm.thinking?.effortMap?.[tier] ?? tier);
		}
	});

	it("deepseek/deepseek-v4-pro sends the literal reasoning_effort plus the baked thinking toggle", async () => {
		for (const tier of deepseek.thinking?.efforts ?? []) {
			const { body } = await captureChatBody(deepseek, { reasoning: tier });
			expect(body.reasoning_effort).toBe(deepseek.thinking?.effortMap?.[tier] ?? tier);
			// Encoder line under test: openai-completions.ts applyOpenAIExtraBody(compat.extraBody).
			expect(body.thinking).toEqual({ type: "enabled" });
		}
	});
});

describe("disableReasoning on lowest-effort hosts pins the ladder floor", () => {
	// Encoder lines under test: openai-shared.ts resolveOpenAICompatPolicy
	// `lowest-effort` floor pin (`wireEffort = mapOpenAIReasoningEffort(model, compat, minEffort)`)
	// and the caller-disable branch in applyChatCompletionsCompatPolicy. Both
	// hosts resolve `reasoningDisableMode: "lowest-effort"` and their ladders
	// bottom out at high, so off is encoded as the floor tier — never omission.
	it("fireworks/glm-5.2 disable sends the floor tier, not omission", async () => {
		const floor = glm.thinking?.efforts[0];
		expect(floor).toBe(Effort.High);
		const { body } = await captureChatBody(glm, { disableReasoning: true });
		expect(body.reasoning_effort).toBe(floor);
	});

	it("deepseek/deepseek-v4-pro disable keeps the baked toggle and pins the floor tier", async () => {
		const floor = deepseek.thinking?.efforts[0];
		expect(floor).toBe(Effort.High);
		const { body } = await captureChatBody(deepseek, { disableReasoning: true });
		expect(body.reasoning_effort).toBe(floor);
		expect(body.thinking).toEqual({ type: "enabled" });
	});
});

describe("no-surface reasoner never emits a reasoning field", () => {
	// Selection contract under test: model-thinking.ts resolveReasoningSelection
	// "uncontrolled" state — the model reasons internally and exposes no dial, so
	// the wire must carry no reasoning knob in any intent (plain, off, requested).
	const REASONING_KEYS = ["reasoning_effort", "reasoning", "thinking", "enable_thinking"] as const;

	it("plain request carries no reasoning field", async () => {
		const { body } = await captureChatBody(noSurface, {});
		for (const key of REASONING_KEYS) expect(body[key]).toBeUndefined();
	});

	it("disableReasoning carries no reasoning field (documented omission)", async () => {
		const { body } = await captureChatBody(noSurface, { disableReasoning: true });
		for (const key of REASONING_KEYS) expect(body[key]).toBeUndefined();
	});

	it("a requested effort is not fabricated onto the wire either", async () => {
		const { body } = await captureChatBody(noSurface, { reasoning: Effort.High });
		for (const key of REASONING_KEYS) expect(body[key]).toBeUndefined();
	});
});

describe("out-of-ladder tiers never reach the wire", () => {
	// Selection line under test: model-thinking.ts requireSupportedEffort —
	// reject with the row's declared ladder, and do not spend a request on it.
	async function expectRejected(model: Model<"openai-completions">, tier: Effort): Promise<void> {
		let fetchCalls = 0;
		const fetchMock: FetchImpl = (async () => {
			fetchCalls += 1;
			return chatSse();
		}) as FetchImpl;
		let caught: unknown;
		try {
			const stream = streamSimple(model, context, { apiKey: "k", fetch: fetchMock, reasoning: tier });
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

	it("fireworks/glm-5.2 rejects low (ladder is high/max)", async () => {
		await expectRejected(glm, Effort.Low);
	});

	it("deepseek/deepseek-v4-pro rejects medium (ladder is high/max)", async () => {
		await expectRejected(deepseek, Effort.Medium);
	});
});
