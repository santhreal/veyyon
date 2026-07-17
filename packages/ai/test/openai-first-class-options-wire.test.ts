import { describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, Tool } from "@veyyon/pi-ai/types";
import { buildModel } from "@veyyon/pi-catalog/build";

// Wire coverage for the first-class OpenAI request options (seed, logit_bias,
// response_format, parallel_tool_calls, safety_identifier) that the auth
// gateway forwards through StreamOptions instead of dropping.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const lookupTool = {
	name: "lookup",
	description: "look something up",
	parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
} as unknown as Tool;

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

function chatModel(): Model<"openai-completions"> {
	return buildModel({
		id: "first-class-chat",
		name: "First Class Chat",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://chat.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function responsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "first-class-responses",
		name: "First Class Responses",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

async function captureChatBody(ctx: Context, options: Record<string, unknown>): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	for await (const event of streamOpenAICompletions(chatModel(), ctx, {
		apiKey: "k",
		fetch: fetchMock,
		...options,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	expect(body).toBeDefined();
	return body!;
}

async function captureResponsesBody(ctx: Context, options: Record<string, unknown>): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return responsesSse();
	});
	for await (const event of streamOpenAIResponses(responsesModel(), ctx, {
		apiKey: "k",
		fetch: fetchMock,
		...options,
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	expect(body).toBeDefined();
	return body!;
}

describe("first-class OpenAI options reach the chat-completions wire", () => {
	it("sends seed, logit_bias, response_format and safety_identifier verbatim", async () => {
		const body = await captureChatBody(context, {
			seed: 42,
			logitBias: { "1234": -100 },
			responseFormat: { type: "json_object" },
			user: "end-user-7",
		});
		expect(body.seed).toBe(42);
		expect(body.logit_bias).toEqual({ "1234": -100 });
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.safety_identifier).toBe("end-user-7");
	});

	it("sends parallel_tool_calls only when the request offers tools", async () => {
		const withTools = await captureChatBody({ ...context, tools: [lookupTool] }, { parallelToolCalls: false });
		expect(withTools.parallel_tool_calls).toBe(false);

		const withoutTools = await captureChatBody(context, { parallelToolCalls: false });
		expect(withoutTools.parallel_tool_calls).toBeUndefined();
	});

	it("omits all five fields when the options are absent", async () => {
		const body = await captureChatBody({ ...context, tools: [lookupTool] }, {});
		expect(body.seed).toBeUndefined();
		expect(body.logit_bias).toBeUndefined();
		expect(body.response_format).toBeUndefined();
		expect(body.safety_identifier).toBeUndefined();
		expect(body.parallel_tool_calls).toBeUndefined();
	});
});

describe("first-class OpenAI options on the Responses wire", () => {
	it("sends parallel_tool_calls (with tools) and safety_identifier; drops chat-only fields", async () => {
		const body = await captureResponsesBody(
			{ ...context, tools: [lookupTool] },
			{
				parallelToolCalls: false,
				user: "end-user-7",
				seed: 42,
				logitBias: { "1234": -100 },
				responseFormat: { type: "json_object" },
			},
		);
		expect(body.parallel_tool_calls).toBe(false);
		expect(body.safety_identifier).toBe("end-user-7");
		// The Responses API has no seed/logit_bias/response_format fields.
		expect(body.seed).toBeUndefined();
		expect(body.logit_bias).toBeUndefined();
		expect(body.response_format).toBeUndefined();
	});

	it("omits parallel_tool_calls on tool-less requests", async () => {
		const body = await captureResponsesBody(context, { parallelToolCalls: true, user: "end-user-7" });
		expect(body.parallel_tool_calls).toBeUndefined();
		expect(body.safety_identifier).toBe("end-user-7");
	});
});
