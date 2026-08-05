import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type AzureOpenAIResponsesOptions,
	streamAzureOpenAIResponses,
} from "@veyyon/ai/providers/azure-openai-responses";
import type { Context, FetchImpl, Model, ModelSpec, Tool } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const azureModel: Model<"azure-openai-responses"> = buildModel({
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

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createSseResponse(events: unknown[]): Response {
	const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createAssistantMessage(text: string, textSignature?: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text, ...(textSignature ? { textSignature } : {}) }],
		api: "azure-openai-responses" as const,
		provider: "azure" as const,
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function captureAzurePayload(
	context: Context,
	model: Model<"azure-openai-responses"> = azureModel,
	options: Partial<AzureOpenAIResponsesOptions> = {},
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(model, context, {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		...options,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("azure openai responses streaming", () => {
	it("serializes each system prompt as an Azure Responses system input item for non-reasoning models", async () => {
		const payload = await captureAzurePayload({
			systemPrompt: ["First instruction", "", "Second instruction"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		});

		expect(payload.input).toEqual([
			{ role: "system", content: "First instruction" },
			{ role: "system", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("sends an async onPayload replacement body", async () => {
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return createSseResponse([
				{
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
				},
			]);
		});

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock as unknown as typeof fetch,
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				onPayload: async payload => ({
					...(payload as Record<string, unknown>),
					input: [{ role: "user", content: [{ type: "input_text", text: "replacement" }] }],
				}),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "replacement" }] }]);
	});

	/** Regression: every retry must rebuild the hook-mutated body, while response/SSE observers retain wire order. */
	it("rebuilds each physical retry and isolates diagnostic callback failures", async () => {
		const order: string[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		let payloadAttempt = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			order.push(`fetch:${String(body.attempt)}`);
			if (bodies.length === 1) {
				return new Response("temporary", { status: 503, headers: { "retry-after": "0" } });
			}
			return createSseResponse([
				// A completed turn must carry visible content: a bare `response.completed`
				// is the empty-completion failure the provider retries, and this test
				// counts transport retries, not that policy.
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_retry",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "hello", annotations: [] }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_retry",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		};

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock,
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				onPayload: payload => {
					payloadAttempt += 1;
					order.push(`payload:${payloadAttempt}`);
					return { ...(payload as Record<string, unknown>), attempt: payloadAttempt };
				},
				onResponse: response => {
					order.push(`response:${response.status}`);
				},
				onSseEvent: () => {
					order.push("sse");
					throw new Error("diagnostic observer failure");
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(bodies.map(body => body.attempt)).toEqual([1, 2]);
		expect(order).toEqual(["payload:1", "fetch:1", "payload:2", "fetch:2", "response:200", "sse", "sse"]);
	});

	/** Regression: an already-aborted request remains fetch-free but still exposes its one inspectable payload. */
	it("prepares exactly one payload for an already-aborted request", async () => {
		const fetchMock = vi.fn(async () => createSseResponse([]));
		const onPayload = vi.fn((payload: unknown) => payload);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock as FetchImpl,
				signal: createAbortedSignal(),
				onPayload,
			},
		).result();

		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("aborted");
	});

	/** Regression: payload-hook rejection is a local failure and must never be retried as a transport attempt. */
	it("does not fetch or notify response observers when the payload hook fails", async () => {
		const fetchMock = vi.fn(async () => createSseResponse([]));
		const onResponse = vi.fn();

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: fetchMock as FetchImpl,
				onPayload: () => {
					throw new Error("payload exploded");
				},
				onResponse,
			},
		).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(onResponse).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("payload exploded");
	});

	/** Regression: malformed SSE remains a provider error even though its diagnostic observer cannot change the outcome. */
	it("reports malformed SSE after notifying response and raw-event callbacks once", async () => {
		const order: string[] = [];
		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				fetch: async () =>
					new Response("data: {malformed}\n\n", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
				onResponse: () => {
					order.push("response");
				},
				onSseEvent: () => {
					order.push("sse");
					throw new Error("ignored observer failure");
				},
			},
		).result();

		expect(order).toEqual(["response", "sse"]);
		expect(result.stopReason).toBe("error");
	});

	it("uses developer role for Azure Responses reasoning model system prompts", async () => {
		const reasoningModel: Model<"azure-openai-responses"> = buildModel({
			...azureModel,
			reasoning: true,
			compat: azureModel.compatConfig,
		} as ModelSpec<"azure-openai-responses">);
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Reasoning instruction", "Second instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			reasoningModel,
		);

		expect(payload.input).toEqual([
			{ role: "developer", content: "Reasoning instruction" },
			{ role: "developer", content: "Second instruction" },
			{ role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		]);
	});

	it("keeps Azure Responses prompt_cache_key separate from Anthropic cache controls", async () => {
		const payload = await captureAzurePayload(
			{
				systemPrompt: ["Cache-stable instruction"],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			azureModel,
			{ sessionId: "azure-session" },
		);

		expect(payload.prompt_cache_key).toBe("azure-session");
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.cache_control).toBeUndefined();
	});

	it("rewrites oneOf tool schemas to anyOf for Azure Responses", async () => {
		const tool: Tool = {
			name: "choose",
			description: "choose a branch",
			parameters: {
				type: "object",
				properties: {
					item: {
						oneOf: [
							{
								type: "object",
								properties: { kind: { const: "a" }, value: { type: "string" } },
								required: ["kind", "value"],
								additionalProperties: false,
							},
							{
								type: "object",
								properties: { kind: { const: "b" }, count: { type: "integer" } },
								required: ["kind", "count"],
								additionalProperties: false,
							},
						],
					},
				},
				required: ["item"],
			},
		};

		const payload = await captureAzurePayload({
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			tools: [tool],
		});

		const tools = payload.tools as Array<{ parameters: { properties: { item: Record<string, unknown> } } }>;
		expect(tools[0].parameters.properties.item.oneOf).toBeUndefined();
		expect(Array.isArray(tools[0].parameters.properties.item.anyOf)).toBe(true);
	});

	it("surfaces nested response.failed provider errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						error: { code: "server_error", message: "backend exploded" },
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded");
	});

	it("surfaces response.failed incomplete reasons", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.failed",
					response: {
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete: max_output_tokens");
	});

	it("surfaces response.completed failed status_details errors", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			createSseResponse([
				{
					type: "response.completed",
					response: {
						status: "failed",
						status_details: {
							error: { code: "server_error", message: "backend exploded late" },
						},
					},
				},
			]),
		);

		const result = await streamAzureOpenAIResponses(
			azureModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{ apiKey: "test-key", azureBaseUrl: azureModel.baseUrl, azureApiVersion: "v1", fetch: fetchMock },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error: backend exploded late");
	});
	it("preserves assistant message phase when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage(
					"Commentary answer",
					JSON.stringify({ v: 1, id: "msg_commentary", phase: "final_answer" }),
				),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Commentary answer", annotations: [] }],
				status: "completed",
				id: "msg_commentary",
				phase: "final_answer",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps legacy plain-string text signatures when rebuilding fallback replay history", async () => {
		const payload = await captureAzurePayload({
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				createAssistantMessage("Legacy answer", "msg_legacy"),
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Legacy answer", annotations: [] }],
				status: "completed",
				id: "msg_legacy",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});
});
