/**
 * WHY: `blockIndex` in the OpenAI completions streaming chunk loop
 * previously called `output.content.indexOf(block)` on every streaming
 * event (text_delta, thinking_delta, toolcall_start, toolcall_delta,
 * text_end, thinking_end, toolcall_end) — one O(n) scan per token. It
 * was optimized to cache `currentBlockIndex` and return it in O(1) when
 * the block matches `currentBlock`, falling back to `indexOf` only for
 * non-current blocks (e.g. resumed tool calls).
 *
 * This suite closes the class by asserting `contentIndex` is correct
 * across interleaved text, thinking, and tool-call blocks — the exact
 * scenario where a stale `currentBlockIndex` would produce wrong indices.
 * A mutation that drops the cache or fails to update it on block
 * transitions will produce wrong `contentIndex` values.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";

const model = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };

function sseResponse(chunks: readonly unknown[]): Response {
	const encoder = new TextEncoder();
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[index];
				if (chunk === undefined) {
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
					return;
				}
				index++;
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function textDeltaChunk(content: string): unknown {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	};
}

function reasoningDeltaChunk(reasoning: string): unknown {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		choices: [
			{
				index: 0,
				delta: { reasoning_content: reasoning } as Record<string, unknown>,
				finish_reason: null,
			},
		],
	};
}

function toolCallStartChunk(index: number, id: string, name: string): unknown {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index,
							id,
							function: { name, arguments: "" },
							type: "function",
						},
					],
				},
				finish_reason: null,
			},
		],
	};
}

function toolCallArgsChunk(index: number, args: string): unknown {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [{ index, function: { arguments: args } }],
				},
				finish_reason: null,
			},
		],
	};
}

function finishChunk(): unknown {
	return {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
}

async function collectEvents(chunks: readonly unknown[]): Promise<Array<{ type: string; contentIndex?: number }>> {
	const fetchImpl = ((_url: string | URL | Request, _init?: RequestInit) =>
		Promise.resolve(sseResponse(chunks))) as unknown as FetchImpl;
	const eventStream = streamOpenAICompletions(model, context, { apiKey: "test", fetch: fetchImpl });
	const events: Array<{ type: string; contentIndex?: number }> = [];
	for await (const event of eventStream) {
		events.push({ type: event.type, contentIndex: event.contentIndex });
	}
	return events;
}

describe("openai-completions streaming blockIndex contentIndex correctness", () => {
	it("assigns sequential contentIndex to text then thinking then text", async () => {
		const events = await collectEvents([
			textDeltaChunk("Hello"),
			reasoningDeltaChunk("thinking here"),
			textDeltaChunk(" world"),
			finishChunk(),
		]);

		const textStarts = events.filter(e => e.type === "text_start");
		const thinkingStarts = events.filter(e => e.type === "thinking_start");
		const textDeltas = events.filter(e => e.type === "text_delta");
		const thinkingDeltas = events.filter(e => e.type === "thinking_delta");

		// First text block at index 0, thinking at index 1, second text at index 2
		expect(textStarts[0]?.contentIndex).toBe(0);
		expect(thinkingStarts[0]?.contentIndex).toBe(1);
		expect(textStarts[1]?.contentIndex).toBe(2);

		// Deltas must match their block indices
		expect(textDeltas[0]?.contentIndex).toBe(0);
		expect(thinkingDeltas[0]?.contentIndex).toBe(1);
		expect(textDeltas[1]?.contentIndex).toBe(2);
	});

	it("assigns correct contentIndex to interleaved text and tool calls", async () => {
		const events = await collectEvents([
			textDeltaChunk("Let me search"),
			toolCallStartChunk(0, "call_1", "grep"),
			toolCallArgsChunk(0, '{"pattern":"test"}'),
			textDeltaChunk(" and read"),
			toolCallStartChunk(1, "call_2", "read"),
			toolCallArgsChunk(1, '{"path":"a.txt"}'),
			finishChunk(),
		]);

		const textStarts = events.filter(e => e.type === "text_start");
		const toolStarts = events.filter(e => e.type === "toolcall_start");
		const toolDeltas = events.filter(e => e.type === "toolcall_delta");

		// text(0), toolCall(1), text(2), toolCall(3)
		expect(textStarts[0]?.contentIndex).toBe(0);
		expect(toolStarts[0]?.contentIndex).toBe(1);
		expect(textStarts[1]?.contentIndex).toBe(2);
		// Tool call deltas: start(1) + args(1) + start(3) + args(3)
		expect(toolDeltas[0]?.contentIndex).toBe(1);
		expect(toolDeltas[1]?.contentIndex).toBe(1);
		expect(toolDeltas[2]?.contentIndex).toBe(3);
		expect(toolDeltas[3]?.contentIndex).toBe(3);
	});

	it("assigns contentIndex 0 to a single text block across many deltas", async () => {
		const events = await collectEvents([
			textDeltaChunk("a"),
			textDeltaChunk("b"),
			textDeltaChunk("c"),
			textDeltaChunk("d"),
			textDeltaChunk("e"),
			finishChunk(),
		]);

		const textDeltas = events.filter(e => e.type === "text_delta");
		// All deltas must be contentIndex 0 — the hot path for blockIndex caching
		expect(textDeltas.every(d => d.contentIndex === 0)).toBe(true);
		expect(textDeltas).toHaveLength(5);
	});
});
