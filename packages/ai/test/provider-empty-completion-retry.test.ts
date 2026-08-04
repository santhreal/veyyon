/**
 * Adapter-level proofs that Azure Responses and Codex use the canonical
 * empty-completion retry policy while retaining the successful retry output.
 */
import { describe, expect, it } from "bun:test";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const CONTEXT: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
};

const AZURE_MODEL: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const CODEX_MODEL: Model<"openai-codex-responses"> = buildModel({
	id: "gpt-5.4-mini",
	name: "GPT-5.4 Mini",
	api: "openai-codex-responses",
	provider: "codex-proxy",
	baseUrl: "http://127.0.0.1:2455/backend-api/codex",
	reasoning: true,
	preferWebsockets: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
});

function createSseResponse(events: unknown[]): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function emptyCompletion(): Response {
	return createSseResponse([
		{
			type: "response.completed",
			response: {
				id: "resp_empty",
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 0,
					total_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

function contentCompletion(text: string): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_success" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_success", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_success",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_success",
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 2,
					total_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	]);
}

describe("provider empty-completion retry integration", () => {
	/** Azure discards a terminal empty completion and returns the next response. */
	it("retries Azure Responses empty completions", async () => {
		let requests = 0;
		const waits: number[] = [];
		const fetchMock: FetchImpl = async () => {
			requests++;
			return requests === 1 ? emptyCompletion() : contentCompletion("azure success");
		};

		const result = await streamAzureOpenAIResponses(AZURE_MODEL, CONTEXT, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async delayMs => void waits.push(delayMs),
		}).result();

		expect(requests).toBe(2);
		expect(waits).toEqual([500]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("azure success");
	});

	/** Codex discards a terminal empty completion and returns the next response. */
	it("retries Codex Responses empty completions", async () => {
		let requests = 0;
		const waits: number[] = [];
		const fetchMock: FetchImpl = async () => {
			requests++;
			return requests === 1 ? emptyCompletion() : contentCompletion("codex success");
		};

		const result = await streamOpenAICodexResponses(CODEX_MODEL, CONTEXT, {
			apiKey: "opaque-proxy-key",
			fetch: fetchMock,
			providerRetryWait: async delayMs => void waits.push(delayMs),
		}).result();

		expect(requests).toBe(2);
		expect(waits).toEqual([500]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("codex success");
	});
});
