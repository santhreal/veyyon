/**
 * A tool-call preview must be able to read argument text while it is still
 * arriving, and `arguments` is not that channel.
 *
 * WHAT THIS CLOSES. `openai-completions` accumulated the streamed argument
 * string into a provider-local `partialArgs` property and re-parsed it into
 * `arguments` only every `STREAMING_JSON_PARSE_MIN_GROWTH` (256) bytes. The
 * preview path reads the block's accumulation marker, which was never written,
 * so `event-controller` fell back to `arguments` — frozen at the first parse
 * for the whole of any call shorter than 256 bytes, which is nearly every one.
 * A bash preview therefore rendered `$ …` until the call closed and then popped
 * the whole command in at once. The rows below are the two halves of the
 * contract: the marker tracks the stream byte for byte, and it is gone once the
 * call closes, because a marker still holding text is exactly how
 * `agent-loop.ts` recognizes a call whose arguments never finished.
 *
 * WHAT IT DOES NOT CATCH. Only this provider's wire shape. Hosts that stream
 * `function.arguments` as an OBJECT (MiniMax-compatible) publish no marker on
 * purpose: their `arguments` is complete on every chunk, so the preview already
 * has something to draw, and the third row pins that so the object branch
 * cannot be "fixed" into emitting a marker that is not concat-safe JSON.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ToolCall } from "@veyyon/ai/types";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { getBundledModel } from "@veyyon/catalog/models";

const model = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

const context: Context = { messages: [{ role: "user", content: "run a command", timestamp: 1 }] };

function sseResponse(chunks: readonly unknown[], observed: readonly PromiseWithResolvers<void>[]): Response {
	const encoder = new TextEncoder();
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				const chunk = chunks[index];
				if (chunk === undefined) {
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
					return;
				}
				// `partial` is the LIVE message: releasing every chunk at once would
				// let the producer finish and clear the marker before a single frame
				// was read, so each frame gates the next chunk.
				if (index > 0) await observed[index - 1]?.promise;
				index++;
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** One `chat.completion.chunk` carrying a tool-call argument fragment. */
function argsChunk(fragment: string | Record<string, unknown>, first: boolean): unknown {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							...(first ? { id: "call-1", type: "function" } : {}),
							function: { ...(first ? { name: "bash" } : {}), arguments: fragment },
						},
					],
				},
			},
		],
	};
}

function finishChunk(): unknown {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	};
}

async function collect(chunks: readonly unknown[]): Promise<{
	published: (string | undefined)[];
	parsedAtDelta: unknown[];
	final: ToolCall | undefined;
	finalMarker: string | undefined;
}> {
	const observed = chunks.map(() => Promise.withResolvers<void>());
	const fetchImpl: FetchImpl = async () => sseResponse(chunks, observed);
	const stream = streamOpenAICompletions(model, context, { apiKey: "k", fetch: fetchImpl });
	const published: (string | undefined)[] = [];
	const parsedAtDelta: unknown[] = [];
	let released = 0;
	for await (const event of stream) {
		if (event.type !== "toolcall_delta") continue;
		const block = event.partial.content.find(item => item.type === "toolCall");
		published.push(getStreamingPartialJson(block));
		parsedAtDelta.push(block?.arguments);
		observed[released++]?.resolve();
	}
	for (const gate of observed) gate.resolve();
	const result = await stream.result();
	const final = result.content.find(item => item.type === "toolCall");
	return { published, parsedAtDelta, final, finalMarker: getStreamingPartialJson(final) };
}

describe("streamOpenAICompletions publishes streamed tool arguments", () => {
	it("carries the accumulated argument text on the block at every delta", async () => {
		const fragments = [`{"command":"git `, `status `, `--short"}`];
		const { published, parsedAtDelta, final, finalMarker } = await collect([
			...fragments.map((fragment, index) => argsChunk(fragment, index === 0)),
			finishChunk(),
		]);

		// Byte-for-byte growth: a preview decoding these renders `git`, then
		// `git status`, then the whole command.
		expect(published).toEqual([`{"command":"git `, `{"command":"git status `, `{"command":"git status --short"}`]);
		// The reason the marker has to exist: `arguments` is re-parsed only every
		// STREAMING_JSON_PARSE_MIN_GROWTH bytes, so on the last delta it is still
		// the FIRST fragment's parse. A preview reading it would show `git ` and
		// then jump to the whole command.
		expect(parsedAtDelta.at(-1)).toEqual({ command: "git " });
		expect(final?.arguments).toEqual({ command: "git status --short" });
		expect(finalMarker).toBeUndefined();
	});

	it("leaves no marker on a call whose arguments arrived in one chunk", async () => {
		const { published, final, finalMarker } = await collect([argsChunk(`{"command":"ls"}`, true), finishChunk()]);

		expect(published).toEqual([`{"command":"ls"}`]);
		expect(final?.arguments).toEqual({ command: "ls" });
		expect(finalMarker).toBeUndefined();
	});

	it("publishes no marker for a host that streams arguments as an object", async () => {
		// MiniMax-compatible shape. The wire value is not JSON text, so there is
		// nothing concat-safe to publish; `arguments` is complete on every chunk
		// instead, which is what the preview reads in this branch.
		const { published, parsedAtDelta, final, finalMarker } = await collect([
			argsChunk({ command: "ls" }, true),
			finishChunk(),
		]);

		expect(published).toEqual([undefined, undefined]);
		expect(parsedAtDelta[0]).toEqual({ command: "ls" });
		expect(final?.arguments).toEqual({ command: "ls" });
		expect(finalMarker).toBeUndefined();
	});
});
