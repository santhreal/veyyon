// Regression test for the contentIndex caching optimization in
// processResponsesStream. The function previously called
// output.content.indexOf(block) on every delta event to compute the
// contentIndex for emitted stream events. This O(n) scan is now replaced
// by a cached contentIndex field on StreamingItem, set at block creation
// time via output.content.push(block) - 1.
//
// WHY: The contentIndex in every emitted stream event (text_start,
// text_delta, thinking_start, thinking_delta, toolcall_start,
// toolcall_end, etc.) must match the actual index of the corresponding
// block in output.content. A stale or incorrect cache would emit events
// with wrong indices, breaking downstream consumers that use the index
// to locate the block.
//
// WHAT THIS CATCHES: Any change that breaks the 1:1 correspondence between
// the cached contentIndex and the actual array position of the block —
// whether by inserting blocks out of order, failing to set the cache on
// block creation, or corrupting the cache on item close.
//
// WHAT THIS DOES NOT CATCH: The fallback path at output_item.done for
// reasoning blocks found via output.content.find (lossy proxy recovery),
// which still uses indexOf. That path is exercised by the lost-added
// recovery tests in openai-responses-stream-terminal.test.ts.
import { describe, expect, test } from "bun:test";
import type { ResponseStreamEvent } from "@veyyon/ai/providers/openai-responses-wire";
import { processResponsesStream } from "@veyyon/ai/providers/openai-shared";
import type { AssistantMessage, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "Test",
		id: "test-1",
		provider: "test",
		baseUrl: "http://127.0.0.1:8080/v1",
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
		provider: "test",
		model: "test-1",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

type EmittedEvent = { type?: string; contentIndex?: number } & Record<string, unknown>;

function makeStreamCapture(): { stream: never; events: EmittedEvent[] } {
	const events: EmittedEvent[] = [];
	const stream = {
		push: (e: unknown) => events.push(e as EmittedEvent),
		end: () => {},
	};
	return { stream: stream as never, events };
}

describe("processResponsesStream: contentIndex correctness", () => {
	test("text block: start and delta events carry the correct contentIndex", async () => {
		const output = makeOutput();
		const { stream, events } = makeStreamCapture();

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg-1", delta: "Hello" },
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg-1", delta: " world" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg-1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello world" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 2 },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const textStart = events.find(e => e.type === "text_start");
		const textDeltas = events.filter(e => e.type === "text_delta" || e.type === "message_delta");
		const textEnd = events.find(e => e.type === "text_end");

		expect(textStart?.contentIndex).toBe(0);
		for (const delta of textDeltas) {
			expect(delta.contentIndex).toBe(0);
		}
		expect(textEnd?.contentIndex).toBe(0);
		expect(output.content[0]?.type).toBe("text");
	});

	test("thinking block: start, delta, and end events carry the correct contentIndex", async () => {
		const output = makeOutput();
		const { stream, events } = makeStreamCapture();

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "reason-1", summary: [] },
				},
				{ type: "response.reasoning_text.delta", output_index: 0, item_id: "reason-1", delta: "Thinking" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "reasoning", id: "reason-1", summary: [], content: [] },
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 2 },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const thinkingStart = events.find(e => e.type === "thinking_start");
		const thinkingDeltas = events.filter(e => e.type === "thinking_delta");
		const thinkingEnd = events.find(e => e.type === "thinking_end");

		expect(thinkingStart?.contentIndex).toBe(0);
		for (const delta of thinkingDeltas) {
			expect(delta.contentIndex).toBe(0);
		}
		expect(thinkingEnd?.contentIndex).toBe(0);
		expect(output.content[0]?.type).toBe("thinking");
	});

	test("interleaved thinking + text: each block gets its own correct contentIndex", async () => {
		const output = makeOutput();
		const { stream, events } = makeStreamCapture();

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "reason-1", summary: [] },
				},
				{ type: "response.reasoning_text.delta", output_index: 0, item_id: "reason-1", delta: "Hmm" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "reasoning", id: "reason-1", summary: [], content: [] },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 1, item_id: "msg-1", delta: "Answer" },
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "message",
						id: "msg-1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Answer" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 2 },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const thinkingStart = events.find(e => e.type === "thinking_start");
		const thinkingDelta = events.find(e => e.type === "thinking_delta");
		const thinkingEnd = events.find(e => e.type === "thinking_end");
		const textStart = events.find(e => e.type === "text_start");
		const textDelta = events.find(e => e.type === "text_delta" || e.type === "message_delta");
		const textEnd = events.find(e => e.type === "text_end");

		// Thinking is block 0
		expect(thinkingStart?.contentIndex).toBe(0);
		expect(thinkingDelta?.contentIndex).toBe(0);
		expect(thinkingEnd?.contentIndex).toBe(0);

		// Text is block 1
		expect(textStart?.contentIndex).toBe(1);
		expect(textDelta?.contentIndex).toBe(1);
		expect(textEnd?.contentIndex).toBe(1);

		expect(output.content).toHaveLength(2);
		expect(output.content[0]?.type).toBe("thinking");
		expect(output.content[1]?.type).toBe("text");
	});

	test("tool call: start, delta, and end events carry the correct contentIndex", async () => {
		const output = makeOutput();
		const { stream, events } = makeStreamCapture();

		const args = JSON.stringify({ path: "test.txt" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc-1",
						call_id: "call-1",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc-1",
					delta: args,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: "fc-1",
					arguments: args,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc-1",
						call_id: "call-1",
						name: "read",
						arguments: args,
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 2 },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const toolcallStart = events.find(e => e.type === "toolcall_start");
		const toolcallDeltas = events.filter(e => e.type === "toolcall_delta");
		const toolcallEnd = events.find(e => e.type === "toolcall_end");

		expect(toolcallStart?.contentIndex).toBe(0);
		for (const delta of toolcallDeltas) {
			expect(delta.contentIndex).toBe(0);
		}
		expect(toolcallEnd?.contentIndex).toBe(0);
		expect(output.content[0]?.type).toBe("toolCall");
	});

	test("text followed by tool call: correct indices for both blocks", async () => {
		const output = makeOutput();
		const { stream, events } = makeStreamCapture();

		const args = JSON.stringify({ path: "test.txt" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg-1", delta: "Let me read" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg-1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Let me read" }],
					},
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc-1",
						call_id: "call-1",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 1,
					item_id: "fc-1",
					delta: args,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 1,
					item_id: "fc-1",
					arguments: args,
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc-1",
						call_id: "call-1",
						name: "read",
						arguments: args,
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp-1",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 2 },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const textStart = events.find(e => e.type === "text_start");
		const textEnd = events.find(e => e.type === "text_end");
		const toolcallStart = events.find(e => e.type === "toolcall_start");
		const toolcallEnd = events.find(e => e.type === "toolcall_end");

		expect(textStart?.contentIndex).toBe(0);
		expect(textEnd?.contentIndex).toBe(0);
		expect(toolcallStart?.contentIndex).toBe(1);
		expect(toolcallEnd?.contentIndex).toBe(1);

		expect(output.content).toHaveLength(2);
		expect(output.content[0]?.type).toBe("text");
		expect(output.content[1]?.type).toBe("toolCall");
	});
});
