/**
 * Tests for proxy stream behavior when the server disconnects
 * without sending a terminal event (done/error).
 *
 * Contract: `streamProxy` MUST emit an error event and resolve
 * `stream.result()` when the SSE stream ends without a terminal
 * event — it must NOT silently complete with default stopReason='stop'.
 */
import { describe, expect, it } from "bun:test";
import type { ProxyAssistantMessageEvent } from "@veyyon/agent-core/proxy";
import { type ProxyMessageEventStream, streamProxy } from "@veyyon/agent-core/proxy";
import type { AssistantMessageEvent, Context, FetchImpl, Model, ToolCall } from "@veyyon/ai";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { buildModel } from "@veyyon/catalog/build";

const mockModel: Model = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai",
	provider: "test",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
});

const mockContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function buildSseBody(events: ProxyAssistantMessageEvent[]): ReadableStream<Uint8Array> {
	const parts: string[] = [];
	for (const event of events) {
		parts.push(`data: ${JSON.stringify(event)}\n\n`);
	}
	const text = parts.join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

async function collectEvents(stream: ProxyMessageEventStream, timeoutMs = 2000): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const iterator = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const { promise: timeoutPromise, resolve: timeoutResolve } =
			Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
		const timer = setTimeout(
			() => timeoutResolve({ value: undefined, done: true } as IteratorResult<AssistantMessageEvent>),
			timeoutMs,
		);
		const result = await Promise.race([iterator.next(), timeoutPromise]);
		clearTimeout(timer);
		if (result.done) break;
		events.push(result.value);
	}
	return events;
}

const baseUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("streamProxy — server disconnect without terminal event", () => {
	it("emits an error event when server disconnects after start with no terminal event", async () => {
		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});
		const collected = await collectEvents(stream);
		const errorEvent = collected.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent && errorEvent.type === "error") {
			expect(errorEvent.reason).toBe("error");
		}
	});

	it("resolves stream.result() with stopReason='error' when server disconnects mid-stream", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hel" },
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		// Consume iterator so the internal async function runs
		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "error")).toBe(true);

		// stream.result() MUST resolve (not hang) with an error message
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
	});

	it("handles client-initiated abort with stopReason='aborted'", async () => {
		const abortController = new AbortController();
		// Pre-abort before any data arrives
		abortController.abort();

		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			signal: abortController.signal,
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		// Should get an error event with reason 'aborted'
		const errorEvent = collected.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent && errorEvent.type === "error") {
			expect(errorEvent.reason).toBe("aborted");
		}

		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
	});

	it("preserves custom abort reason when client aborts mid-stream", async () => {
		const abortController = new AbortController();
		abortController.abort("user-interrupt");

		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			signal: abortController.signal,
			fetch: fetchMock,
		});

		await collectEvents(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		// Custom abort reason must be preserved in errorMessage, not overwritten
		// by the generic "Proxy stream ended without a terminal event" message
		expect(result.errorMessage).toBe("user-interrupt");
	});

	it("completes normally when server sends a 'done' event", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello" },
			{ type: "text_end", contentIndex: 0 },
			{
				type: "done",
				reason: "stop",
				usage: { ...baseUsage },
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "done")).toBe(true);

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.length).toBeGreaterThan(0);
	});

	it("completes with error event when server sends an 'error' terminal event", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hel" },
			{
				type: "error",
				reason: "error",
				errorMessage: "rate_limit_exceeded",
				usage: { ...baseUsage },
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "error")).toBe(true);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("rate_limit_exceeded");
	});

	it("does not leak partialJson when server disconnects mid-tool-call", async () => {
		// Stream sends toolcall_start + partial toolcall_delta, then disconnects
		// without toolcall_end, done, or error. The catch-block error path must
		// scrub partialJson from the content before pushing the error event.
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"comm' },
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "error")).toBe(true);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		const toolCall = result.content.find((c): c is ToolCall => c.type === "toolCall");
		expect(toolCall).toBeDefined();
		if (toolCall) {
			expect(getStreamingPartialJson(toolCall)).toBeUndefined();
		}
	});
});

describe("streamProxy — non-ok proxy responses", () => {
	it("surfaces the parsed error field from a non-ok JSON body", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response(JSON.stringify({ error: "quota exceeded" }), { status: 429 }));
		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});
		await collectEvents(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy error: quota exceeded");
	});

	it("falls back to status + statusText when the non-ok body is not JSON", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(new Response("gateway down", { status: 502, statusText: "Bad Gateway" }));
		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});
		await collectEvents(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Proxy error: 502 Bad Gateway");
	});
});

describe("streamProxy — thinking blocks and event-order guards", () => {
	it("accumulates a thinking block across start/delta/end into the final message", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "step one " },
			{ type: "thinking_delta", contentIndex: 0, delta: "step two" },
			{ type: "thinking_end", contentIndex: 0, contentSignature: "sig-123" },
			{ type: "done", reason: "stop", usage: { ...baseUsage } },
		];
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(buildSseBody(events), { status: 200 }));
		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});
		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "thinking_end")).toBe(true);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		const thinking = result.content.find(c => c.type === "thinking");
		expect(thinking).toBeDefined();
		if (thinking && thinking.type === "thinking") {
			expect(thinking.thinking).toBe("step one step two");
			expect(thinking.thinkingSignature).toBe("sig-123");
		}
	});

	// Each out-of-order event is processed inside streamProxy's try block, so its
	// throw becomes an error terminal event carrying the guard message.
	const outOfOrderCases: Array<{ name: string; events: ProxyAssistantMessageEvent[]; message: string }> = [
		{
			name: "text_delta before text_start",
			events: [{ type: "start" }, { type: "text_delta", contentIndex: 0, delta: "x" }],
			message: "Received text_delta for non-text content",
		},
		{
			name: "text_end before text_start",
			events: [{ type: "start" }, { type: "text_end", contentIndex: 0 }],
			message: "Received text_end for non-text content",
		},
		{
			name: "thinking_delta on a text block",
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "thinking_delta", contentIndex: 0, delta: "x" },
			],
			message: "Received thinking_delta for non-thinking content",
		},
		{
			name: "thinking_end on a text block",
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "thinking_end", contentIndex: 0 },
			],
			message: "Received thinking_end for non-thinking content",
		},
		{
			name: "toolcall_delta on a text block",
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "toolcall_delta", contentIndex: 0, delta: "{" },
			],
			message: "Received toolcall_delta for non-toolCall content",
		},
	];

	for (const { name, events, message } of outOfOrderCases) {
		it(`emits an error terminal event for ${name}`, async () => {
			const fetchMock: FetchImpl = () => Promise.resolve(new Response(buildSseBody(events), { status: 200 }));
			const stream = streamProxy(mockModel, mockContext, {
				proxyUrl: "http://localhost:0",
				authToken: "test",
				fetch: fetchMock,
			});
			await collectEvents(stream);
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe(message);
		});
	}

	it("cancels the live response body when the client aborts mid-stream", async () => {
		const ac = new AbortController();
		let bodyCancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// Emit one event then keep the stream open so the abort lands mid-read.
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));
		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			signal: ac.signal,
			fetch: fetchMock,
		});
		const collectPromise = collectEvents(stream);
		await new Promise(resolve => setTimeout(resolve, 20));
		ac.abort("mid-stream");
		await collectPromise;
		const result = await stream.result();
		// The abort handler cancels the in-flight body and the run ends as aborted.
		expect(bodyCancelled).toBe(true);
		expect(result.stopReason).toBe("aborted");
	});

	it("silently ignores a toolcall_end that lands on a non-toolCall block", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "hi" },
			{ type: "text_end", contentIndex: 0 },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "stop", usage: { ...baseUsage } },
		];
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(buildSseBody(events), { status: 200 }));
		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});
		const collected = await collectEvents(stream);
		// The mismatched toolcall_end produces no event, but the stream still completes.
		expect(collected.some(e => e.type === "toolcall_end")).toBe(false);
		expect(collected.some(e => e.type === "done")).toBe(true);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});
});
