/**
 * A generation that produced no final message must not be reported to the client as `completed`.
 *
 * WHY THIS SUITE EXISTS. `encodeStream` builds its terminal SSE frame from the stream's final assistant
 * message. When no `done` event arrived it asked the stream for its result, and that ask was wrapped in
 * `.catch(() => null)`. Every reader below then treated the null as "there was no final message" rather
 * than as an error: the status became `completed`, the output became whatever items had already streamed,
 * and usage became null. So a generation that FAILED partway through was announced to the client as a
 * successful response carrying partial content.
 *
 * That is the worst shape a failure can take, because the client cannot detect it. A `response.failed` is
 * retried; a `response.completed` with half an answer is used. And it is not a hypothetical path:
 * `EventStream.end()` with no terminal value rejects `result()` by design, with "Stream ended without a
 * final result", which is what an upstream connection dropping after some text has streamed looks like from
 * here.
 *
 * The suite asserts the FRAME an SSE client reads, not internal state, because the wire is the contract.
 * It also pins the two behaviours that must not change while fixing this: a stream that does deliver a
 * `done` event still completes, and a stream that reports an explicit `error` event still fails with that
 * error's own message rather than the generic one.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { encodeStream } from "@veyyon/ai/providers/openai-responses-server";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

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

function partialMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		content: [],
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	};
}

/** One SSE frame: its `event:` name and the parsed `data:` payload. */
interface Frame {
	event: string;
	data: Record<string, unknown>;
}

/** Read the whole encoded stream and split it into frames, dropping the `[DONE]` sentinel. */
async function frames(stream: ReadableStream<Uint8Array>): Promise<Frame[]> {
	const chunks: string[] = [];
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		chunks.push(decoder.decode(value, { stream: true }));
	}
	const out: Frame[] = [];
	for (const block of chunks.join("").split("\n\n")) {
		const eventLine = block.split("\n").find(line => line.startsWith("event: "));
		const dataLine = block.split("\n").find(line => line.startsWith("data: "));
		if (!eventLine || !dataLine) continue;
		const payload = dataLine.slice("data: ".length);
		if (payload === "[DONE]") continue;
		out.push({ event: eventLine.slice("event: ".length), data: JSON.parse(payload) as Record<string, unknown> });
	}
	return out;
}

/** The terminal frame, which is the one an SSE client acts on. */
function terminal(list: Frame[]): Frame {
	const last = list.filter(frame => frame.event.startsWith("response.")).at(-1);
	if (!last) throw new Error("no response.* frame was emitted");
	return last;
}

describe("a stream that ends without a final message", () => {
	/**
	 * The regression. `end()` with no terminal value rejects `result()`, which used to be swallowed, and the
	 * client was told `completed`. The status must be `failed`, and the error must carry the stream's own
	 * reason so the client can tell this from a refusal or a length cutoff.
	 */
	it("reports response.failed with the stream's reason", async () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: partialMessage() });
			stream.end();
		});

		const frame = terminal(await frames(encodeStream(stream, "gpt-5-requested")));

		expect(frame.event).toBe("response.failed");
		const response = frame.data.response as { status: string; error?: { message?: string } };
		expect(response.status).toBe("failed");
		expect(response.error?.message).toContain("Stream ended without a final result");
	});

	/**
	 * The partial content that DID stream is still attached to the failure, because a client debugging a
	 * truncated answer needs to see how far it got. Failing closed means reporting the failure, not
	 * discarding the evidence.
	 */
	it("still carries the items that streamed before the failure", async () => {
		const stream = new AssistantMessageEventStream();
		const partial = partialMessage();
		queueMicrotask(() => {
			stream.push({ type: "start", partial });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "half an ", partial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "answer", partial });
			stream.push({ type: "text_end", contentIndex: 0, content: "half an answer", partial });
			stream.end();
		});

		const list = await frames(encodeStream(stream, "gpt-5-requested"));
		const frame = terminal(list);

		expect(frame.event).toBe("response.failed");
		expect(JSON.stringify((frame.data.response as { output: unknown }).output)).toContain("half an answer");
	});

	/**
	 * And the terminal frame is emitted exactly once. A failure path that emitted `response.failed` and then
	 * fell through to `response.completed` would leave the client with the last frame it read, which is how
	 * a fail-closed fix turns back into the bug it replaced.
	 */
	it("emits no completed frame alongside the failure", async () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: partialMessage() });
			stream.end();
		});

		const names = (await frames(encodeStream(stream, "gpt-5-requested"))).map(frame => frame.event);

		expect(names.filter(name => name === "response.completed")).toEqual([]);
		expect(names.filter(name => name === "response.failed")).toHaveLength(1);
	});
});

describe("a stream that rejects its result outright", () => {
	/**
	 * The other way the ask can fail: the provider fails the stream after some events. The reason travels to
	 * the client instead of being replaced by a successful-looking response.
	 */
	it("reports the rejection reason", async () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: partialMessage() });
			stream.rejectFinalResult(new Error("upstream connection reset"));
			stream.end(undefined);
			stream.endWaiting();
		});

		const frame = terminal(await frames(encodeStream(stream, "gpt-5-requested")));

		expect(frame.event).toBe("response.failed");
		expect((frame.data.response as { error?: { message?: string } }).error?.message).toContain(
			"upstream connection reset",
		);
	});
});

describe("the paths that must keep working", () => {
	/** A stream that delivers a `done` event completes, which is the ordinary case and most of the traffic. */
	it("still completes when a final message arrives", async () => {
		const stream = new AssistantMessageEventStream();
		const final: AssistantMessage = {
			...partialMessage(),
			content: [{ type: "text", text: "Hi!" }],
			usage: { ...zeroUsage(), input: 1, output: 2 },
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: partialMessage() });
			stream.push({ type: "done", reason: "stop", message: final });
		});

		const frame = terminal(await frames(encodeStream(stream, "gpt-5-requested")));

		expect(frame.event).toBe("response.completed");
		expect((frame.data.response as { status: string }).status).toBe("completed");
	});

	/**
	 * An explicit `error` event still fails with ITS message, not with the generic no-final-message one. The
	 * two failure paths are distinct and an operator reads the difference: one is the provider saying what
	 * went wrong, the other is the stream ending with nothing said at all.
	 */
	it("keeps an explicit error event's own message", async () => {
		const stream = new AssistantMessageEventStream();
		const failed: AssistantMessage = {
			...partialMessage(),
			stopReason: "error",
			errorMessage: "model overloaded",
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: partialMessage() });
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end();
		});

		const frame = terminal(await frames(encodeStream(stream, "gpt-5-requested")));

		expect(frame.event).toBe("response.failed");
		expect((frame.data.response as { error?: { message?: string } }).error?.message).toBe("model overloaded");
	});
});
