import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamGoogleGenAI } from "@veyyon/ai/providers/google-shared";
import { streamGoogleVertex } from "@veyyon/ai/providers/google-vertex";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

// A Gemini turn that finishes with `finishReason: STOP` but carries only an empty text part —
// the well-known "empty response" failure. Delivered as-is, the agent receives a blank message
// and silently halts, so the provider must retry instead of surfacing it.

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, totalTokenCount: 15 },
	};
}

/** `{ response: { candidates } }` envelope (Cloud Code Assist: google-gemini-cli / antigravity). */
function ccaChunk(text: string): Record<string, unknown> {
	return { response: genaiChunk(text) };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, starts: events.filter(e => e.type === "start").length };
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Vertex)",
	api: "google-vertex",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

describe("Google empty-response retry (public + Vertex path)", () => {
	it("retries a STOP-with-empty-text response and delivers the real follow-up content", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1 ? sse(genaiChunk("")) : sse(genaiChunk("Hello!"));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2); // one empty attempt + one successful retry
		expect(starts).toBe(1); // exactly one start across the retry — no duplicate partials
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		void events;
	});

	it("surfaces an error after exhausting retries when every attempt is empty", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const result = await stream.result();

		expect(calls).toBe(3); // MAX_EMPTY_STREAM_RETRIES (2) + 1 initial attempt
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("empty response");
	});

	/**
	 * Regression: empty-response retries used to hide every physical HTTP response from
	 * `onResponse`, making request ids and rate-limit headers disappear even though the
	 * same final payload was dispatched twice. The payload hook must finish before the
	 * first fetch, and each response must be announced before its SSE frame is observed.
	 */
	it("announces each empty-response attempt in exact payload, response, and SSE order", async () => {
		const order: string[] = [];
		const bodies: unknown[] = [];
		let calls = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			calls += 1;
			order.push(`fetch:${calls}`);
			bodies.push(JSON.parse(String(init?.body)));
			const response = sse(genaiChunk(calls === 1 ? "" : "Done"));
			response.headers.set("x-request-id", `request-${calls}`);
			return response;
		};

		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: fetchMock,
			onPayload: async payload => {
				order.push("payload");
				return {
					...(payload as Record<string, unknown>),
					contents: [{ role: "user", parts: [{ text: "hooked request" }] }],
				};
			},
			onResponse: response => {
				order.push(`response:${response.requestId}`);
			},
			onSseEvent: () => {
				order.push(`sse:${calls}`);
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(order).toEqual([
			"payload",
			"fetch:1",
			"response:request-1",
			"sse:1",
			"fetch:2",
			"response:request-2",
			"sse:2",
		]);
		expect(bodies).toEqual([
			{ contents: [{ role: "user", parts: [{ text: "hooked request" }] }] },
			{ contents: [{ role: "user", parts: [{ text: "hooked request" }] }] },
		]);
	});

	/**
	 * Regression: the regional-to-global Vertex fallback is two physical attempts.
	 * Both responses must reach `onResponse`, including the retry-triggering 404,
	 * and each callback must precede observation of the successful SSE frame.
	 */
	it("announces both regional fallback responses before streaming the global response", async () => {
		const order: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			order.push(`fetch:${url}`);
			if (url === "https://regional.example/stream") {
				return new Response('{"error":{"message":"not regional"}}', {
					status: 404,
					headers: { "x-request-id": "regional-request" },
				});
			}
			const response = sse(genaiChunk("global"));
			response.headers.set("x-request-id", "global-request");
			return response;
		};
		const stream = streamGoogleGenAI({
			model: genaiModel,
			api: "google-generative-ai",
			options: {
				fetch: fetchMock,
				onResponse: response => {
					order.push(`response:${response.status}:${response.requestId}`);
				},
				onSseEvent: () => {
					order.push("sse");
				},
			},
			prepare: () => ({
				params: { model: "gemini-2.5-pro", contents: [{ role: "user", parts: [{ text: "hi" }] }] },
				url: "https://regional.example/stream",
				fallbackUrl: "https://global.example/stream",
				headers: {},
			}),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(order).toEqual([
			"fetch:https://regional.example/stream",
			"response:404:regional-request",
			"fetch:https://global.example/stream",
			"response:200:global-request",
			"sse",
		]);
	});

	/**
	 * Regression: response-hook failures occur after headers but before any body
	 * consumption. They must win over a superficially successful SSE body, fire once,
	 * and prevent raw SSE callbacks from reporting data that was never consumed.
	 */
	it("stops before SSE consumption when the response hook rejects", async () => {
		const order: string[] = [];
		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: async () => {
				order.push("fetch");
				return sse(genaiChunk("must not stream"));
			},
			onResponse: async () => {
				order.push("response");
				throw new Error("response observer rejected");
			},
			onSseEvent: () => {
				order.push("sse");
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("response observer rejected");
		expect(order).toEqual(["fetch", "response"]);
	});

	it("filters out empty text parts at stream end but preserves terminal thought signatures", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{ content: { parts: [{ text: "", thoughtSignature: "terminal-sig" }] }, finishReason: "STOP" },
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const { events } = await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "terminal-sig",
		});

		const textStartEvents = events.filter(e => e.type === "text_start");
		expect(textStartEvents).toHaveLength(1);
		expect(textStartEvents[0].contentIndex).toBe(0);

		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		expect(textDeltaEvents).toHaveLength(1);
		expect(textDeltaEvents[0].delta).toBe("Hello");

		const textEndEvents = events.filter(e => e.type === "text_end");
		expect(textEndEvents).toHaveLength(1);
		expect(textEndEvents[0].content).toBe("Hello");
	});

	it("does not coalesce function-call thought signatures into the preceding Vertex text block", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
									thoughtSignature: "function-call-sig",
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});
});

describe("Google empty-response retry (Cloud Code Assist path)", () => {
	it("retries a STOP-with-empty-text response (the reported gemini-3-flash hang)", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			// Cloud Code Assist re-fetches `response.url` on retry; synthetic Responses default it to "".
			const response = calls === 1 ? sse(ccaChunk("")) : sse(ccaChunk("Done."));
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2);
		expect(starts).toBe(1); // the empty attempt must not leave a dangling duplicate start
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Done.");
		void events;
	});

	it("does not coalesce function-call thought signatures into the preceding text block", async () => {
		const chunks = [
			{ response: { candidates: [{ content: { parts: [{ text: "Done" }] } }] } },
			{
				response: {
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
										thoughtSignature: "function-call-sig",
									},
								],
							},
							finishReason: "STOP",
						},
					],
				},
			},
		];

		const fetchMock: FetchImpl = async () => {
			const response = sse(...chunks);
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Done" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});

	it("does not retry if finishReason is SAFETY and bubbles up the error", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			const response = sse({
				response: {
					candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
				},
			});
			Object.defineProperty(response, "url", { value: "https://example.com/v1internal:streamGenerateContent" });
			return response;
		};

		const stream = streamGoogleGeminiCli(cliModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: fetchMock,
		});

		await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Generation failed with finish reason: SAFETY");
		expect(calls).toBe(1);
	});
});
