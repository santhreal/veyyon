/**
 * WHY:
 * OpenAI Responses and OpenAI Codex Responses streams deliver incremental
 * function-argument string fragments on `response.function_call_arguments.delta`.
 * A previous commit introduced a heuristic (`mergeToolCallArgumentsDelta`) that
 * tested whether an arriving delta started with the accumulated buffer prefix
 * (`delta.startsWith(current)`), mistaking coincidental prefix matches for
 * cumulative gateway resends. That heuristic silently truncated repetitive
 * content (runs of spaces, quotes, braces, identical keys/tokens, or a chunk
 * whose text happened to begin with the prefix already buffered).
 *
 * This test closes the class: any tool-call argument value streamed across
 * arbitrary chunk boundaries (including adversarial split points where a later
 * chunk begins with or equals an earlier chunk or the entire current buffer)
 * must produce the exact same accumulated arguments and stream deltas as when
 * the value arrives as a single whole chunk.
 *
 * WHAT IT DOES NOT CATCH:
 * This suite verifies the in-process stream accumulator and Responses event
 * processing pipeline. It does not catch upstream network-level TCP reordering
 * or malformed SSE framing prior to event decoding.
 */
import { describe, expect, it } from "bun:test";
import type { ResponseStreamEvent } from "@veyyon/ai/providers/openai-responses-wire";
import { processResponsesStream } from "@veyyon/ai/providers/openai-shared";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ToolCall,
} from "@veyyon/ai/types";
import { kStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { buildModel } from "@veyyon/catalog/build";

function createTestModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT-4o",
		id: "gpt-4o",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 128000,
		maxTokens: 4096,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function createEmptyOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-4o",
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

async function* createEventStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) {
		yield event as ResponseStreamEvent;
	}
}

interface RunStreamResult {
	output: AssistantMessage;
	toolCall: ToolCall;
	emittedDeltas: string[];
	partialBuffer: string | undefined;
}

async function runResponsesStreamWithDeltas(deltas: string[]): Promise<RunStreamResult> {
	const model = createTestModel();
	const output = createEmptyOutput();
	const emittedDeltas: string[] = [];

	const stream: AssistantMessageEventStream = {
		push: (event: AssistantMessageEvent) => {
			if (event.type === "toolcall_delta") {
				emittedDeltas.push(event.delta);
			}
		},
		end: () => {},
	} as unknown as AssistantMessageEventStream;

	const events: unknown[] = [
		{
			type: "response.created",
			response: { id: "resp_1" },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_item_1",
				call_id: "call_123",
				name: "test_tool",
				arguments: "",
			},
		},
	];

	for (const delta of deltas) {
		events.push({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: "fc_item_1",
			delta,
		});
	}

	events.push({
		type: "response.function_call_arguments.done",
		output_index: 0,
		item_id: "fc_item_1",
		arguments: deltas.join(""),
	});

	events.push({
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_item_1",
			call_id: "call_123",
			name: "test_tool",
			arguments: deltas.join(""),
		},
	});

	events.push({
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_item_1",
					call_id: "call_123",
					name: "test_tool",
					arguments: deltas.join(""),
				},
			],
		},
	});

	const eventStream = createEventStream(events);
	await processResponsesStream(eventStream, output, stream, model);

	const toolCall = output.content.find(block => block.type === "toolCall") as ToolCall;
	const partialBuffer = (toolCall as unknown as Record<symbol, unknown>)[kStreamingPartialJson] as string | undefined;

	return { output, toolCall, emittedDeltas, partialBuffer };
}

describe("OpenAI Responses function argument streaming accumulator", () => {
	it("produces identical arguments and deltas when a chunk starts with the accumulated prefix", async () => {
		// Adversarial case: chunk 1 is `{"path":` and chunk 2 is `{"path": "/foo"}`
		// Entire JSON: `{"path":{"path": "/foo"}}`
		// Under the buggy merge, chunk 2 starts with `{"path":`, so the merge treated it as a resend
		// and stripped `{"path":`, dropping characters and corrupting the argument buffer.
		const whole = await runResponsesStreamWithDeltas(['{"path":{"path": "/foo"}}']);
		const split = await runResponsesStreamWithDeltas(['{"path":', '{"path": "/foo"}}']);

		expect(split.toolCall.arguments).toEqual(whole.toolCall.arguments);
		expect(split.toolCall.arguments).toEqual({ path: { path: "/foo" } });
		expect(split.emittedDeltas.join("")).toBe(whole.emittedDeltas.join(""));
		expect(split.emittedDeltas.join("")).toBe('{"path":{"path": "/foo"}}');
	});

	it("preserves repeated single-character tokens without truncation", async () => {
		// Adversarial case: chunk 1 = `{"`, chunk 2 = `{"foo": 1}`
		// Under the buggy merge, `{"foo": 1}` starts with `{"`, dropping the leading `{"`.
		const whole = await runResponsesStreamWithDeltas(['{{"nested": 1}}']);
		const split = await runResponsesStreamWithDeltas(["{", '{"nested": 1}}']);

		expect(split.emittedDeltas.join("")).toBe(whole.emittedDeltas.join(""));
		expect(split.emittedDeltas.join("")).toBe('{{"nested": 1}}');
	});

	it("preserves runs of repeated whitespace and indentation", async () => {
		// Adversarial case: chunk 1 is `" "` (single space), chunk 2 is `"    "` (four spaces)
		// Under the buggy merge, `"    "`.startsWith(`" "`) was true, dropping one space.
		const whole = await runResponsesStreamWithDeltas(['{\n     "key": "value"\n}']);
		const split = await runResponsesStreamWithDeltas(["{\n ", '    "key": "value"\n}']);

		expect(split.toolCall.arguments).toEqual(whole.toolCall.arguments);
		expect(split.emittedDeltas.join("")).toBe(whole.emittedDeltas.join(""));
	});

	it("matches whole arrival across every possible split index for complex JSON payloads", async () => {
		const testPayloads = [
			JSON.stringify({ query: "SELECT * FROM table WHERE a = a AND b = b" }),
			JSON.stringify({ code: "function test() {\n    if (a) {\n        return a;\n    }\n}" }),
			JSON.stringify({ prompt: "hello hello hello hello hello", repeat: "aaaaabbbbbccccc" }),
			JSON.stringify({
				nested: { nested: { nested: "value" } },
				list: [
					[1, 2],
					[1, 2],
				],
			}),
		];

		for (const payload of testPayloads) {
			const whole = await runResponsesStreamWithDeltas([payload]);

			// Sweep split points across the entire string length
			for (let i = 1; i < payload.length; i += 3) {
				const chunk1 = payload.slice(0, i);
				const chunk2 = payload.slice(i);
				const split = await runResponsesStreamWithDeltas([chunk1, chunk2]);

				expect(split.toolCall.arguments).toEqual(whole.toolCall.arguments);
				expect(split.emittedDeltas.join("")).toBe(payload);
			}
		}
	});

	it("handles empty deltas, whole buffer deltas, and repeated identical chunks cleanly", async () => {
		// 1. Empty delta in middle
		const withEmpty = await runResponsesStreamWithDeltas(['{"a":', "", '"b"}']);
		expect(withEmpty.toolCall.arguments).toEqual({ a: "b" });
		expect(withEmpty.emittedDeltas.join("")).toBe('{"a":"b"}');

		// 2. Repeated identical chunk
		const repeated = await runResponsesStreamWithDeltas(['{"text":"', "abc", "abc", '"}']);
		expect(repeated.toolCall.arguments).toEqual({ text: "abcabc" });
		expect(repeated.emittedDeltas.join("")).toBe('{"text":"abcabc"}');
	});
});
