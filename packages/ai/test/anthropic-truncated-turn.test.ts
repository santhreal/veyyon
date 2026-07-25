import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { AnthropicMessages } from "@veyyon/ai/providers/anthropic-client";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * A turn cut off mid-sentence must not be committed as a finished one.
 *
 * When a socket closes or a proxy drops the connection partway through a
 * response, the Anthropic stream simply stops. The provider saw
 * `content_block_start` and some deltas, never `content_block_stop`, and never
 * `message_stop`. It warned about the unterminated block, closed it, and broke
 * out of the loop with `stopReason` left untouched, so the truncated turn was
 * handed back looking exactly like a completed one.
 *
 * The damage is not the blank half of the sentence. It is that the turn is
 * PERSISTED, and the model reads its own truncated output back as history on
 * every following turn. A sentence that stops mid-word, or worse a tool call
 * whose JSON arguments were cut, becomes a permanent part of the conversation,
 * and nothing downstream can tell it apart from something the model chose to
 * write. The only trace was a warning.
 *
 * The two distinctions this suite draws are load-bearing, because a check that
 * was any broader would fail streams that work today:
 *
 *   • A stream that closed all its blocks cleanly and merely omitted the
 *     trailing `message_stop` is a lenient endpoint, not a truncation.
 *   • A stream with a block left open that nonetheless carried a terminal
 *     envelope is a transparent reconnect splicing a new message onto the same
 *     connection. Upstream said the message is finished, so the orphaned block
 *     is an envelope artifact, not lost content.
 *
 * Truncation is only the case where the bytes stopped: a block still open and
 * nothing having declared the message done.
 */
describe("an Anthropic turn cut off mid-stream", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const model: Model<"anthropic-messages"> = buildModel({
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});

	const context: Context = { messages: [{ role: "user", content: "write a sentence", timestamp: 0 }] };

	/** Replay a fixed event list through the SDK client the provider streams from. */
	function mockEvents(events: Record<string, unknown>[]): void {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((() => {
			const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
			const stream = {
				async *[Symbol.asyncIterator]() {
					for (const event of events) yield event;
				},
			};
			return {
				async withResponse() {
					return { data: stream, response, request_id: "req_mock" };
				},
			};
		}) as never);
	}

	const messageStart = {
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-fable-5",
			content: [],
			usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	};
	const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
	const textDelta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	const textStop = { type: "content_block_stop", index: 0 };
	const messageDelta = {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 4 },
	};
	const messageStop = { type: "message_stop" };

	/**
	 * Drive the provider and hand back the message it produced. A failed turn is
	 * reported in-band here as `stopReason: "error"` with an `errorMessage`, which
	 * is the signal every consumer already treats as "this turn did not complete";
	 * that is the state a truncated stream has to land in.
	 */
	async function run(events: Record<string, unknown>[]): Promise<AssistantMessage> {
		mockEvents(events);
		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test" });
		for await (const _ of stream) {
			// drain
		}
		return await stream.result();
	}

	/**
	 * The core case: the connection dies after some deltas, with the text block
	 * still open. Before the fix this returned `stopReason: "stop"` and no
	 * `errorMessage`, indistinguishable from a turn the model chose to end.
	 */
	it("marks the half-written turn failed instead of complete", async () => {
		const message = await run([messageStart, textStart, textDelta("The answer is")]);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("truncated");
	});

	/**
	 * The failure has to say the turn was cut, not merely that something was odd
	 * about the envelope. An operator reading "malformed stream" cannot tell
	 * whether they lost content.
	 */
	it("says the turn was cut mid-message", async () => {
		const message = await run([messageStart, textStart, textDelta("half a sen")]);

		expect(message.errorMessage).toContain("unterminated content block");
	});

	/**
	 * The partial text is still carried on the failed message rather than
	 * discarded. Losing it would make the failure harder to diagnose, and the
	 * point of the fix is the turn's STATUS, not deleting what arrived.
	 */
	it("keeps the partial text on the failed turn", async () => {
		const message = await run([messageStart, textStart, textDelta("The answer is")]);

		expect(JSON.parse(JSON.stringify(message.content))).toEqual([{ type: "text", text: "The answer is" }]);
	});

	/**
	 * A truncated TOOL CALL is the dangerous version: its arguments are partial
	 * JSON, and committing it means the next turn replays a malformed call.
	 */
	it("marks a tool call whose arguments were cut off as failed", async () => {
		const message = await run([
			messageStart,
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t1", name: "edit", input: {} },
			},
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"/a' } },
		]);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("truncated");
	});

	/**
	 * The distinction that keeps this from breaking working setups: every block
	 * closed cleanly and only the trailing `message_stop` is missing. That is a
	 * lenient endpoint, not a cut connection, and the turn stands.
	 */
	it("still accepts a stream that closed its blocks but omitted message_stop", async () => {
		const message = await run([messageStart, textStart, textDelta("all done"), textStop, messageDelta]);

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(JSON.parse(JSON.stringify(message.content))).toEqual([{ type: "text", text: "all done" }]);
	});

	/**
	 * The second distinction, and the one that is easiest to get wrong: a block is
	 * left open, but the stream went on to carry a terminal envelope. That is a
	 * transparent reconnect splicing a fresh message onto the same connection, and
	 * upstream declared the message finished. Failing it would break every
	 * provider that reconnects mid-stream.
	 */
	it("still accepts an open block when the stream declared the message finished", async () => {
		const message = await run([
			messageStart,
			textStart,
			textDelta("spliced"),
			// No content_block_stop for index 0: the reconnect orphaned it.
			{ ...messageStart, message: { ...messageStart.message, id: "msg_reconnect" } },
			messageDelta,
			messageStop,
		]);

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		// The orphaned block is still finalized, so nothing is dropped.
		expect(JSON.parse(JSON.stringify(message.content))).toEqual([{ type: "text", text: "spliced" }]);
	});

	/**
	 * And a fully well-formed stream is untouched. Without this the suite would
	 * pass against an implementation that failed every turn.
	 */
	it("leaves a complete turn alone", async () => {
		const message = await run([messageStart, textStart, textDelta("hello"), textStop, messageDelta, messageStop]);

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(JSON.parse(JSON.stringify(message.content))).toEqual([{ type: "text", text: "hello" }]);
	});
});
