// Anthropic citation coverage: `citations_delta` events land on
// TextContent.annotations verbatim, and replayed assistant history passes
// Anthropic-shaped citations back on the wire while filtering foreign shapes.
import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@veyyon/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@veyyon/pi-ai/providers/anthropic-client";
import { encodeResponse, encodeStream, parseRequest } from "@veyyon/pi-ai/providers/anthropic-messages-server";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, TextAnnotation } from "@veyyon/pi-ai/types";
import { AssistantMessageEventStream } from "@veyyon/pi-ai/utils/event-stream";
import { buildModel } from "@veyyon/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const webCitation: TextAnnotation = {
	type: "web_search_result_location",
	url: "https://example.test/source",
	title: "Example Source",
	cited_text: "cited",
	encrypted_index: "abc123",
};

type MockAnthropicEvent = Record<string, unknown>;

function createMockRequest(events: MockAnthropicEvent[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function citedTextEvents(): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_cited",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Cited claim" } },
		{ type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: webCitation } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic citations_delta ingest", () => {
	it("lands streamed citations on TextContent.annotations verbatim", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(citedTextEvents()) as never,
		);

		const context: Context = { messages: [{ role: "user", content: "cite it", timestamp: Date.now() }] };
		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _event of stream) {
			// drain
		}
		const result = await stream.result();

		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: "Cited claim", annotations: [webCitation] }),
		]);
	});
});

describe("anthropic citation replay", () => {
	it("passes Anthropic-shaped citations back on history text blocks and filters foreign shapes", async () => {
		let captured: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(((params: Record<string, unknown>) => {
			captured = params;
			return createMockRequest(citedTextEvents());
		}) as never);

		const foreignCitation: TextAnnotation = {
			type: "url_citation",
			url: "https://example.test/openai",
			title: "OpenAI-shaped",
			start_index: 0,
			end_index: 5,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "cite it", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Cited claim", annotations: [webCitation, foreignCitation] },
						{ type: "text", text: "Plain trailing text" },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "again", timestamp: Date.now() },
			],
		};

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _event of stream) {
			// drain
		}
		await stream.result();

		const messages = captured?.messages as Array<{ role: string; content: unknown }>;
		const assistant = messages.find(m => m.role === "assistant")!;
		const blocks = assistant.content as Array<Record<string, unknown>>;
		const cited = blocks.find(b => b.type === "text" && b.text === "Cited claim")!;
		expect(cited.citations).toEqual([webCitation]);
		const plain = blocks.find(b => b.type === "text" && b.text === "Plain trailing text")!;
		expect("citations" in plain).toBe(false);
	});
});

function makeAssistant(annotations?: TextAnnotation[]): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "Cited claim", ...(annotations ? { annotations } : {}) }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	};
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	const out: Array<Record<string, unknown>> = [];
	for (const chunk of buf.split("\n\n")) {
		const dataLine = chunk.split("\n").find(line => line.startsWith("data: "));
		if (dataLine) out.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
	}
	return out;
}

describe("anthropic-messages server citation round trip", () => {
	it("encodeResponse carries citations on annotated text blocks and omits them otherwise", () => {
		const encoded = encodeResponse(makeAssistant([webCitation]), "m");
		const content = encoded.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({ type: "text", text: "Cited claim", citations: [webCitation] });

		const plain = encodeResponse(makeAssistant(), "m");
		expect((plain.content as Array<Record<string, unknown>>)[0]).toEqual({ type: "text", text: "Cited claim" });
	});

	it("encodeStream emits citations_delta before the block closes", async () => {
		const message = makeAssistant([webCitation]);
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: { ...message, content: [] } },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "Cited claim", partial: message },
			{ type: "text_end", contentIndex: 0, content: "Cited claim", partial: message },
			{ type: "done", reason: "stop", message },
		];
		const s = new AssistantMessageEventStream();
		queueMicrotask(() => {
			for (const ev of events) s.push(ev);
			s.end();
		});

		const frames = await collectSse(encodeStream(s, "m"));
		const citationFrame = frames.find(
			f => (f.delta as Record<string, unknown> | undefined)?.type === "citations_delta",
		);
		expect(citationFrame).toBeDefined();
		expect((citationFrame!.delta as Record<string, unknown>).citation).toEqual(webCitation);
		const idxCitation = frames.indexOf(citationFrame!);
		const idxStop = frames.findIndex(f => f.type === "content_block_stop");
		expect(idxCitation).toBeLessThan(idxStop);
	});

	it("parseRequest keeps history citations as annotations", () => {
		const parsed = parseRequest({
			model: "claude-sonnet-4-5",
			max_tokens: 512,
			messages: [
				{ role: "user", content: "cite it" },
				{ role: "assistant", content: [{ type: "text", text: "Cited claim", citations: [webCitation] }] },
				{ role: "user", content: "again" },
			],
		});
		const assistant = parsed.context.messages.find(m => m.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("expected assistant message");
		const text = assistant.content.find(part => part.type === "text");
		if (text?.type !== "text") throw new Error("expected text content");
		expect(text.annotations).toEqual([webCitation]);
	});
});
