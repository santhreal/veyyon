/**
 * An Anthropic stream cannot buffer one frame forever.
 *
 * WHY THIS SUITE EXISTS. The frame bound lives in `@veyyon/utils/stream`, and a bound that
 * the product's own consumers do not reach is a bound in a library nobody called. The
 * Anthropic path is the busiest consumer in the tree: `iterateAnthropicEvents` hands
 * `response.body` to `readSseEvents` and iterates until the body ends, so before the bound
 * existed a provider — or any proxy sitting in front of one, which is where a captive
 * portal or a misconfigured gateway lives — could hold the connection open sending
 * `data:` lines and never dispatch, and the process died with a valid-looking request in
 * flight.
 *
 * This drives the real exported generator over a real `Response`, not a stand-in for the
 * reader, because what is being proved is that this consumer inherits the bound and
 * surfaces it. The verdict is asserted too: a framing violation must reach the retry layer
 * as terminal, since retrying reaches the same peer.
 *
 * WHAT THIS DOES NOT CATCH. The SDK client path (`streamAnthropic` through the vendored
 * client) is not driven here; `iterateAnthropicEvents` is exported precisely because it
 * owns the frame policy for both.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { isProviderRetryableError } from "@veyyon/ai/error/retryable";
import { iterateAnthropicEvents } from "@veyyon/ai/providers/anthropic";
import { isStreamFrameLimitError, STREAM_FRAME_MAX_BYTES_ENV } from "@veyyon/utils/stream";

const CEILING = 64 * 1024;
const encoder = new TextEncoder();

let previousCeiling: string | undefined;

afterEach(() => {
	if (previousCeiling === undefined) delete process.env[STREAM_FRAME_MAX_BYTES_ENV];
	else process.env[STREAM_FRAME_MAX_BYTES_ENV] = previousCeiling;
	previousCeiling = undefined;
});

function declareCeiling(bytes: number): void {
	previousCeiling = process.env[STREAM_FRAME_MAX_BYTES_ENV];
	process.env[STREAM_FRAME_MAX_BYTES_ENV] = String(bytes);
}

/**
 * A response body that keeps sending SSE `data:` lines and never dispatches. It stops
 * after `stopAfter` bytes so an unbounded reader FAILS this test instead of hanging it; a
 * bounded reader never gets there.
 */
function neverDispatching(stopAfter: number): { body: ReadableStream<Uint8Array>; produced: () => number } {
	const line = encoder.encode(`data: ${"a".repeat(4088)}\n`);
	let produced = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (produced >= stopAfter) {
				controller.close();
				return;
			}
			produced += line.length;
			controller.enqueue(line.slice());
		},
	});
	return { body, produced: () => produced };
}

describe("the Anthropic event reader inherits the frame bound", () => {
	it("stops an event that never dispatches, and says which protocol broke", async () => {
		declareCeiling(CEILING);
		const source = neverDispatching(CEILING * 32);
		const response = new Response(source.body, { headers: { "content-type": "text/event-stream" } });

		const caught = await (async () => {
			try {
				for await (const _event of iterateAnthropicEvents(response)) {
					// A dispatch never arrives; the bound is what ends this loop.
				}
				return null;
			} catch (err) {
				return err;
			}
		})();

		expect(isStreamFrameLimitError(caught)).toBe(true);
		expect(String((caught as Error).message)).toContain("blank-line dispatch");
		// The bound, not the peer's generosity, is what ended it: the reader stopped inside
		// one ceiling plus the line in flight, far short of what the source would have sent.
		expect(source.produced()).toBeLessThanOrEqual(CEILING + 8192);
	});

	it("is terminal for the retry layer rather than transient", async () => {
		declareCeiling(CEILING);
		const source = neverDispatching(CEILING * 32);
		const response = new Response(source.body, { headers: { "content-type": "text/event-stream" } });

		const caught = await (async () => {
			try {
				for await (const _event of iterateAnthropicEvents(response)) {
					// unreachable
				}
				return null;
			} catch (err) {
				return err;
			}
		})();

		expect(isProviderRetryableError(caught)).toBe(false);
	});

	it("still reads an ordinary stream whose events dispatch", async () => {
		declareCeiling(CEILING);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
					),
				);
				controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
				controller.close();
			},
		});
		const response = new Response(body, { headers: { "content-type": "text/event-stream" } });

		const types: string[] = [];
		for await (const event of iterateAnthropicEvents(response)) types.push(event.type);

		expect(types).toEqual(["message_start", "message_stop"]);
	});

	it("ignores a ceiling that is not a positive integer instead of removing the bound", async () => {
		declareCeiling(0);
		process.env[STREAM_FRAME_MAX_BYTES_ENV] = "not-a-number";
		const source = neverDispatching(1024 * 1024);
		const response = new Response(source.body, { headers: { "content-type": "text/event-stream" } });

		// The compiled default is 64 MiB, so a megabyte of undispatched data is well inside
		// it: the stream ends when the source does, and the typo neither removed the bound
		// nor invented a tiny one.
		const caught = await (async () => {
			try {
				for await (const _event of iterateAnthropicEvents(response)) {
					// unreachable
				}
				return null;
			} catch (err) {
				return err;
			}
		})();

		expect(isStreamFrameLimitError(caught)).toBe(false);
		expect(source.produced()).toBeGreaterThanOrEqual(1024 * 1024);
	});
});
