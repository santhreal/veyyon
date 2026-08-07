import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";

// GLM-5.2 reasoning-effort dialects diverge per host (verified against live
// endpoints): a direct GLM host (Fireworks) exposes a real `max` top tier and
// keeps its distinct lower tiers (with the `minimal -> none` host quirk),
// whereas OpenRouter rejects `max` (HTTP 400) and treats `xhigh` as its own
// max tier. The catalog bakes the right ladder/`thinking.effortMap`; these
// tests pin the resulting wire value so a future change can't silently 400
// either host.
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

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

function responsesSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function captureChatEffort(model: Model<"openai-completions">, reasoning: Effort): Promise<unknown> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	for await (const event of streamOpenAICompletions(model, context, { apiKey: "k", fetch: fetchMock, reasoning })) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured chat-completions request");
	return body.reasoning_effort;
}

/** The refusal reaches the caller as a terminal error event, never a request. */
async function captureChatError(model: Model<"openai-completions">, reasoning: Effort): Promise<string> {
	const fetchMock: FetchImpl = vi.fn(async () => {
		throw new Error("the refused effort must never reach the wire");
	});
	for await (const event of streamOpenAICompletions(model, context, { apiKey: "k", fetch: fetchMock, reasoning })) {
		if (event.type === "error") return event.error.errorMessage ?? "";
		if (event.type === "done") break;
	}
	throw new Error("Expected a terminal error event");
}

async function captureResponsesEffort(model: Model<"openrouter">, reasoning: Effort): Promise<unknown> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return responsesSse();
	});
	// OpenRouter is a pseudo-API driven through the Responses surface (stream.ts
	// defaults `api: "openrouter"` to streamOpenAIResponses).
	const responsesModel = model as unknown as Model<"openai-responses">;
	for await (const event of streamOpenAIResponses(responsesModel, context, {
		apiKey: "k",
		fetch: fetchMock,
		reasoning,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured Responses request");
	const reasoningParam = body.reasoning;
	return reasoningParam && typeof reasoningParam === "object" && "effort" in reasoningParam
		? reasoningParam.effort
		: undefined;
}

// Both rows come from the shipped catalog: the ladder is each host's own
// declaration, so a spec assembled here would prove nothing about what the
// endpoint accepts.
const fireworks = getBundledModel("fireworks", "glm-5.2") as Model<"openai-completions">;
const openRouter = getBundledModel("openrouter", "z-ai/glm-5.2") as unknown as Model<"openrouter">;

describe("GLM-5.2 reasoning effort wire mapping", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends reasoning_effort:max for the real max tier on a direct GLM host (Fireworks)", async () => {
		expect(await captureChatEffort(fireworks, Effort.Max)).toBe("max");
		expect(await captureChatEffort(fireworks, Effort.High)).toBe("high");
	});

	it("refuses tiers Fireworks never declared rather than mapping them onto the wire", async () => {
		// Fireworks declares high and max for GLM-5.2 and nothing below. The old
		// behaviour invented minimal/low/medium and leaned on a `minimal -> none`
		// host quirk to keep the invented floor from 400ing; asking for a tier
		// the host never published now fails in-process instead.
		for (const effort of [Effort.Minimal, Effort.Low, Effort.Medium]) {
			expect(await captureChatError(fireworks, effort)).toContain("Supported efforts: high, max");
		}
	});

	it("sends the literal xhigh tier to OpenRouter (which rejects max) via the Responses surface", async () => {
		expect(await captureResponsesEffort(openRouter, Effort.XHigh)).toBe("xhigh");
	});
});
