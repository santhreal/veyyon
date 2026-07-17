// Round-trip coverage for output_text annotations (web-search citations):
// provider ingest (response.output_text.annotation.added → TextContent.annotations),
// server egress (text_end → annotation.added + annotated content parts), and
// server request-parse (replayed assistant history keeps its annotations).
import { describe, expect, it } from "bun:test";
import { encodeStream, parseRequest } from "@veyyon/pi-ai/providers/openai-responses-server";
import type { ResponseStreamEvent } from "@veyyon/pi-ai/providers/openai-responses-wire";
import { processResponsesStream } from "@veyyon/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model, TextAnnotation } from "@veyyon/pi-ai/types";
import { AssistantMessageEventStream } from "@veyyon/pi-ai/utils/event-stream";
import { buildModel } from "@veyyon/pi-catalog/build";

const citation: TextAnnotation = {
	type: "url_citation",
	start_index: 0,
	end_index: 5,
	title: "Example",
	url: "https://example.test/cited",
};

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-test",
		api: "openai-responses",
		usage: zeroUsage(),
		stopReason: "stop",
	};
}

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	return out;
}

interface SseFrame {
	event: string;
	data: Record<string, unknown> | string;
}

function parseSse(raw: string): SseFrame[] {
	const frames: SseFrame[] = [];
	for (const chunk of raw.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice("event: ".length);
			else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
		}
		if (dataLine === "[DONE]") {
			frames.push({ event: event || "done_sentinel", data: "[DONE]" });
		} else if (dataLine) {
			frames.push({ event, data: JSON.parse(dataLine) as Record<string, unknown> });
		}
	}
	return frames;
}

describe("provider ingest: annotation.added lands on TextContent.annotations", () => {
	it("captures streamed annotations on the text block", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
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
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "Cited claim" },
				{
					type: "response.output_text.annotation.added",
					output_index: 0,
					item_id: "msg_1",
					content_index: 0,
					annotation_index: 0,
					annotation: citation,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Cited claim", annotations: [citation] }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toEqual([
			expect.objectContaining({ type: "text", text: "Cited claim", annotations: [citation] }),
		]);
	});

	it("adopts annotations from output_item.done when the incremental events were dropped", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "Cited claim" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Cited claim", annotations: [citation] }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const text = output.content[0];
		expect(text).toEqual(expect.objectContaining({ type: "text", annotations: [citation] }));
	});
});

describe("server egress: encodeStream surfaces annotations", () => {
	it("emits response.output_text.annotation.added and annotated content parts", async () => {
		const stream = new AssistantMessageEventStream();
		const annotated: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "Cited claim", annotations: [citation] }],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...annotated, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: annotated });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Cited claim", partial: annotated });
			stream.push({ type: "text_end", contentIndex: 0, content: "Cited claim", partial: annotated });
			stream.push({ type: "done", reason: "stop", message: annotated });
		});

		const frames = parseSse(await collectStream(encodeStream(stream, "gpt-5-requested")));
		const names = frames.map(f => f.event);

		const idxAnnotation = names.indexOf("response.output_text.annotation.added");
		const idxTextDone = names.indexOf("response.output_text.done");
		expect(idxAnnotation).toBeGreaterThanOrEqual(0);
		expect(idxAnnotation).toBeLessThan(idxTextDone);
		const annotationFrame = frames[idxAnnotation]!.data as Record<string, unknown>;
		expect(annotationFrame.annotation).toEqual(citation);
		expect(annotationFrame.annotation_index).toBe(0);

		const partDone = frames.find(f => f.event === "response.content_part.done")!.data as Record<string, unknown>;
		expect((partDone.part as Record<string, unknown>).annotations).toEqual([citation]);

		const itemDone = frames.find(
			f =>
				f.event === "response.output_item.done" &&
				((f.data as Record<string, unknown>).item as Record<string, unknown>)?.type === "message",
		)!.data as Record<string, unknown>;
		const content = (itemDone.item as { content: Array<Record<string, unknown>> }).content;
		expect(content[0]!.annotations).toEqual([citation]);
	});

	it("emits no annotation events for unannotated text", async () => {
		const stream = new AssistantMessageEventStream();
		const plain: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "Plain" }],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...plain, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: plain });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Plain", partial: plain });
			stream.push({ type: "text_end", contentIndex: 0, content: "Plain", partial: plain });
			stream.push({ type: "done", reason: "stop", message: plain });
		});

		const frames = parseSse(await collectStream(encodeStream(stream, "gpt-5-requested")));
		expect(frames.some(f => f.event === "response.output_text.annotation.added")).toBe(false);
	});
});

describe("server parseRequest: replayed history keeps annotations", () => {
	it("carries assistant output_text annotations onto the parsed TextContent", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			stream: true,
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "cite something" }] },
				{
					type: "message",
					role: "assistant",
					status: "completed",
					id: "msg_prev",
					content: [{ type: "output_text", text: "Cited claim", annotations: [citation] }],
				},
				{ type: "message", role: "user", content: [{ type: "input_text", text: "and again" }] },
			],
		});

		const assistant = parsed.context.messages.find(m => m.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("expected assistant message");
		const text = assistant.content.find(part => part.type === "text");
		if (text?.type !== "text") throw new Error("expected text content");
		expect(text.text).toBe("Cited claim");
		expect(text.annotations).toEqual([citation]);
	});
});
