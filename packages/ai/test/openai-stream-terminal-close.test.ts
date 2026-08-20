/**
 * WHY: an OpenAI-compatible stream can end in three materially different ways:
 * an explicit `finish_reason`, a final accounting frame after a structurally
 * complete tool batch, or a transport truncation. Conflating the latter two
 * either strands valid tool calls behind retries or executes partial calls.
 *
 * This suite keeps the boundary closed in both directions: terminal usage may
 * stand in for an omitted finish reason only for complete tool calls; `[DONE]`,
 * text, incomplete JSON, and usage attached to either remain non-terminal.
 * It also covers providers that deliver a real terminal frame but never close
 * the connection.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const responsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

/** SSE response that delivers `events` and then holds the connection open forever. */
function createNeverClosingSseResponse(events: unknown[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				const data = typeof event === "string" ? event : JSON.stringify(event);
				controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			}
			// Intentionally never controller.close(): the server keeps the
			// socket open after the terminal frame.
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createNeverClosingFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createNeverClosingSseResponse(events);
	}
	return mockFetch as typeof fetch;
}
/** SSE response that reaches transport EOF immediately after `events`. */
function createClosingSseResponse(events: unknown[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				const data = typeof event === "string" ? event : JSON.stringify(event);
				controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createClosingFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createClosingSseResponse(events);
	}
	return mockFetch as typeof fetch;
}

async function collectClosingCompletion(events: unknown[]): Promise<{
	events: AssistantMessageEvent[];
	result: AssistantMessage;
}> {
	const stream = streamOpenAICompletions(completionsModel, baseContext(), {
		apiKey: "test-key",
		fetch: createClosingFetch(events),
	});
	const emitted: AssistantMessageEvent[] = [];
	for await (const event of stream) emitted.push(event);
	return { events: emitted, result: await stream.result() };
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-terminal",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("openai-completions terminal finish reason", () => {
	/**
	 * The transport-level `[DONE]` sentinel is not an authoritative model
	 * completion when no choice ever supplied a finish reason.
	 */
	it("rejects DONE followed by EOF without a finish_reason", async () => {
		const { events, result } = await collectClosingCompletion([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant" } }] }),
			"[DONE]",
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain("closed before a terminal finish reason");
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	/**
	 * Text received before EOF remains attached to the error for diagnostics,
	 * but cannot become a successful truncated assistant response.
	 */
	it("rejects EOF after a partial text delta and preserves the text", async () => {
		const { events, result } = await collectClosingCompletion([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial answer" } }] }),
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "Partial answer" }]);
		expect(result.errorMessage).toContain("closed before a terminal finish reason");
	});

	/**
	 * A truncated JSON argument delta must stay diagnostic partial state; EOF
	 * cannot repair it into a successful tool-use completion.
	 */
	it("rejects EOF after partial tool arguments without completing tool use", async () => {
		const partialArguments = '{"city":"Par';
		const { events, result } = await collectClosingCompletion([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_weather",
									type: "function",
									function: { name: "weather", arguments: partialArguments },
								},
							],
						},
					},
				],
			}),
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(events.some(event => event.type === "toolcall_delta" && event.delta === partialArguments)).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual(
			expect.objectContaining({
				type: "toolCall",
				id: "call_weather",
				name: "weather",
				arguments: { city: "Par" },
			}),
		);
		expect(result.errorMessage).toContain("closed before a terminal finish reason");
	});

	it("accepts trailing usage as terminal for a structurally complete tool batch", async () => {
		const { events, result } = await collectClosingCompletion([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_inspect",
									type: "function",
									function: { name: "inspect", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			completionChunk({
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"package.json"}' } }] },
						finish_reason: null,
					},
				],
			}),
			completionChunk({
				choices: [],
				usage: { prompt_tokens: 541, completion_tokens: 91, total_tokens: 632 },
			}),
		]);

		expect(events.at(-1)?.type).toBe("done");
		expect(events.some(event => event.type === "error")).toBe(false);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "call_inspect",
				name: "inspect",
				arguments: { path: "package.json" },
			}),
		]);
		expect(result.usage.input).toBe(541);
		expect(result.usage.output).toBe(91);
	});

	it("rejects trailing usage when tool arguments are incomplete", async () => {
		const { events, result } = await collectClosingCompletion([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_inspect",
									type: "function",
									function: { name: "inspect", arguments: '{"path":"package' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			completionChunk({
				choices: [],
				usage: { prompt_tokens: 541, completion_tokens: 91, total_tokens: 632 },
			}),
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("closed before a terminal finish reason");
	});

	it("rejects trailing usage after text without a finish reason", async () => {
		const { events, result } = await collectClosingCompletion([
			completionChunk({
				choices: [{ index: 0, delta: { content: "Partial answer" }, finish_reason: null }],
			}),
			completionChunk({
				choices: [],
				usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
			}),
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "Partial answer" }]);
	});

	/**
	 * A normal tool terminal frame remains authoritative even when the HTTP
	 * body closes immediately afterward.
	 */
	it("keeps a tool_calls finish_reason as a successful tool-use completion", async () => {
		const { events, result } = await collectClosingCompletion([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_weather",
									type: "function",
									function: { name: "weather", arguments: '{"city":"Paris"}' },
								},
							],
						},
					},
				],
			}),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
		]);

		expect(events.at(-1)?.type).toBe("done");
		expect(events.some(event => event.type === "error")).toBe(false);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual(
			expect.objectContaining({
				type: "toolCall",
				id: "call_weather",
				name: "weather",
				arguments: { city: "Paris" },
			}),
		);
		expect(result.errorMessage).toBeUndefined();
	});
});

describe("terminal frame without connection close", () => {
	it("openai-completions: breaks immediately once finish_reason and usage arrived", async () => {
		const fetchMock = createNeverClosingFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			completionChunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
		]);

		const startedAt = Date.now();
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(5);
		// Immediate break path: must finish well inside the 2.5s post-finish
		// grace window (the pre-fix behavior was a 120s idle-watchdog error).
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	}, 10_000);

	it("openai-completions: ignores zero cache placeholder until trailing positive cache details arrive", async () => {
		const fetchMock = createNeverClosingFetch([
			completionChunk({
				choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			}),
			completionChunk({
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 4 },
				},
			}),
		]);

		const startedAt = Date.now();
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(6);
		expect(result.usage.cacheRead).toBe(4);
		expect(result.usage.output).toBe(5);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	}, 10_000);

	it("openai-completions: ends cleanly via the grace window when no usage chunk ever arrives", async () => {
		const fetchMock = createNeverClosingFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	}, 10_000);

	it("openai-responses: breaks immediately on response.completed", async () => {
		const fetchMock = createNeverClosingFetch([
			{ type: "response.created", response: { id: "resp_terminal" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 0,
				item_id: "msg_1",
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "Hello" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_terminal",
					status: "completed",
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				},
			},
		]);

		const startedAt = Date.now();
		const result = await streamOpenAIResponses(responsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: "Hello" }) as unknown as (typeof result.content)[number],
		]);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(5);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	}, 10_000);
});
