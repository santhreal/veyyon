import { describe, expect, it } from "bun:test";
import { iterateAnthropicEvents } from "@veyyon/ai/providers/anthropic";

/**
 * A stream that parsed nothing must fail, not return a blank reply.
 *
 * `iterateAnthropicEvents` deliberately SKIPS a malformed SSE frame instead of
 * aborting the turn, so a non-conforming endpoint still delivers whatever it
 * managed to send. That is the right trade while some of the stream survives.
 *
 * It stops being a trade when none of it does. With every frame unparseable the
 * generator used to run to completion having yielded nothing, and the caller
 * received an assistant message with empty content and `stopReason: "stop"`,
 * which is byte-for-byte what a model that legitimately chose to say nothing
 * looks like. The turn is recorded as a success, the user sees a blank reply,
 * and the only trace is a `logger.warn` they had no reason to go looking for
 * because nothing failed.
 *
 * That is Law 10 exactly: the mechanism did not work, something else happened,
 * and the operator was not told in any way they would notice. A degrade that
 * degrades to nothing is not best-effort, it is silence, so it fails closed.
 *
 * The partial case is the other half and matters just as much: one good frame
 * among bad ones must still come through, or this fix would have replaced a
 * silent failure with a loud one on streams that were working fine.
 */
describe("an Anthropic stream whose frames cannot be parsed", () => {
	/** Feed raw SSE bytes through the envelope iterator and collect what survives. */
	async function run(chunks: string[]): Promise<{ types: string[]; error?: unknown }> {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const response = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

		const types: string[] = [];
		let error: unknown;
		try {
			for await (const event of iterateAnthropicEvents(response)) types.push(event.type);
		} catch (caught) {
			error = caught;
		}
		return { types, error };
	}

	const frame = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;

	const goodStart = frame(
		"message_start",
		JSON.stringify({
			type: "message_start",
			message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-test", usage: {} },
		}),
	);

	/**
	 * The core case. Truncated JSON is what a proxy that cuts a response mid-frame
	 * actually produces, and every frame here is unusable.
	 */
	it("fails rather than returning an empty message when nothing parsed", async () => {
		const { error, types } = await run([
			frame("message_start", '{"type":"message_start","message":{'),
			frame("content_block_delta", '{"type":"content_block_delta","delta"'),
		]);

		expect(error).toBeDefined();
		expect(String(error)).toContain("none of them could be parsed");
		// And it must not have quietly produced anything on the way.
		expect(types).toEqual([]);
	});

	/**
	 * The failure has to say how much was lost. "Malformed stream" without a count
	 * cannot tell an operator whether one frame was dropped or the entire
	 * response was.
	 */
	it("says how many frames it could not parse", async () => {
		const { error } = await run([
			frame("message_start", "{not json"),
			frame("content_block_delta", "{also not json"),
			frame("content_block_delta", "{nor this"),
		]);

		expect(String(error)).toContain("3 event(s)");
	});

	/**
	 * The other half of the contract, and the reason the check is on "nothing got
	 * through" rather than "something was dropped": a stream that delivered real
	 * content must not be failed because one frame in it was bad. Without this the
	 * fix would break every stream that hits a single hiccup.
	 */
	it("still delivers content when only some frames are malformed", async () => {
		const { error, types } = await run([
			goodStart,
			frame(
				"content_block_start",
				JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			),
			frame("content_block_delta", "{truncated garbage"),
			frame(
				"content_block_delta",
				JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
			),
			frame("content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })),
			frame(
				"message_delta",
				JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
			),
			frame("message_stop", JSON.stringify({ type: "message_stop" })),
		]);

		expect(error).toBeUndefined();
		// The good delta survived alongside the frames around it; only the bad one
		// was dropped.
		expect(types).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
	});

	/**
	 * A clean stream must be entirely unaffected. This is the twin that keeps the
	 * suite from passing against an implementation that failed every stream.
	 */
	it("leaves a well-formed stream alone", async () => {
		const { error, types } = await run([
			goodStart,
			frame(
				"content_block_start",
				JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			),
			frame(
				"content_block_delta",
				JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
			),
			frame("content_block_stop", JSON.stringify({ type: "content_block_stop", index: 0 })),
			frame(
				"message_delta",
				JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
			),
			frame("message_stop", JSON.stringify({ type: "message_stop" })),
		]);

		expect(error).toBeUndefined();
		expect(types).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
	});

	/**
	 * A stream that carried no message frames at all is a different failure with
	 * its own handling, and must not be turned into a parse error. Only frames
	 * that were RECOGNISED and then failed to parse count, or a keepalive-only
	 * stream would be misreported as malformed.
	 */
	it("does not report a parse failure for a stream that carried only pings", async () => {
		const { error } = await run([frame("ping", JSON.stringify({ type: "ping" }))]);

		expect(String(error ?? "")).not.toContain("none of them could be parsed");
	});
});
