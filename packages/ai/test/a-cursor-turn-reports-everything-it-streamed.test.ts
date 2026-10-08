/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * A consumer of a Cursor turn reads its event stream, not the wire: it opens the assistant message
 * on `start`, closes each tool-call block on its `toolcall_end`, and reports the time to first
 * token from the finished message. The class this closes is "the wire delivered it and the turn
 * did not report it": a missing `start`, a tool call the server opened and the turn never closed,
 * or a first token that the finished message does not time.
 *
 * Each case drives a real turn against a loopback HTTP/2 server and asserts on the events it
 * emitted.
 *
 * WHAT IT DOES NOT CATCH: the argument content of a tool call, which `cursor-streaming-args` covers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	type CursorH2Server,
	respondConnect,
	runCursorTurn,
	serverFrame,
	startCursorH2Server,
	textDeltaFrame,
	turnEndedFrame,
} from "./helpers/cursor-h2-server";

let server: CursorH2Server | undefined;

afterEach(async () => {
	await server?.close();
	server = undefined;
});

function toolCallStartedFrame(callId: string, name: string): Buffer {
	return serverFrame({
		message: {
			case: "interactionUpdate",
			value: {
				message: {
					case: "toolCallStarted",
					value: {
						callId,
						toolCall: {
							tool: { case: "mcpToolCall", value: { args: { name, toolName: name, toolCallId: callId } } },
						},
					},
				},
			},
		},
	});
}

async function serve(frames: Buffer[]): Promise<CursorH2Server> {
	return startCursorH2Server(({ stream }) => {
		respondConnect(stream);
		stream.end(Buffer.concat(frames));
	});
}

describe("a Cursor turn reports what it streamed", () => {
	it("opens the message with `start` before any content event", async () => {
		server = await serve([textDeltaFrame("hello"), turnEndedFrame()]);

		const { events } = await runCursorTurn(server.baseUrl);

		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("times the first token when one arrived, and only then", async () => {
		server = await serve([textDeltaFrame("hello"), turnEndedFrame()]);
		const withToken = await runCursorTurn(server.baseUrl);
		await server.close();
		server = await serve([turnEndedFrame()]);
		const withoutToken = await runCursorTurn(server.baseUrl);

		expect(withToken.message.ttft).toBeGreaterThanOrEqual(0);
		expect(withToken.message.ttft).toBeLessThanOrEqual(withToken.message.duration ?? -1);
		expect(withoutToken.message.ttft).toBeUndefined();
	});

	it("closes every tool call the server opened and never completed", async () => {
		server = await serve([
			toolCallStartedFrame("call-a", "read"),
			toolCallStartedFrame("call-b", "grep"),
			turnEndedFrame(),
		]);

		const { events, message } = await runCursorTurn(server.baseUrl);

		const opened = message.content.flatMap((block, index) => (block.type === "toolCall" ? [index] : []));
		const closed = events.flatMap(event => (event.type === "toolcall_end" ? [event.contentIndex] : []));
		expect(opened).toEqual([0, 1]);
		expect(closed).toEqual(opened);
	});
});
