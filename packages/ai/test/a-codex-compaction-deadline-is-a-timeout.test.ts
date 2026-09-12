import { describe, expect, test } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { collectCodexCompactionV2Stream } from "@veyyon/ai/providers/openai-codex/compaction-v2";
import { isAbortError, isTimeoutError } from "@veyyon/utils/abortable";

/**
 * A codex server-side compaction whose deadline expires fails as a timeout, and
 * one the caller cancels fails as a cancellation.
 *
 * WHY. The v2 compaction stream is read through `readSseEvents`, which ends the
 * stream on an aborted signal instead of throwing, so an expired deadline
 * reached the reader as "closed before response.completed": no timeout
 * vocabulary, classified as neither Timeout nor Abort. On a 234k-token span
 * every server compaction was cut at 180 s and reported as a backend fault, and
 * the retry ladder treated it as one. The class is any abort reason lost at
 * that seam; the two reasons a compaction signal carries are covered.
 *
 * Does not catch: a body that closes on its own before `response.completed`,
 * which is still the backend's fault and still reported as such.
 */

const encoder = new TextEncoder();

/**
 * A stream that sends `response.created`, then aborts `controller` with `reason`
 * the moment the reader asks for more, standing in for a deadline or a
 * cancellation that fires while the backend is silent.
 */
function silentAfterCreated(controller: AbortController, reason: unknown): ReadableStream<Uint8Array> {
	let pulls = 0;
	return new ReadableStream<Uint8Array>({
		pull(stream) {
			pulls += 1;
			if (pulls === 1) {
				stream.enqueue(
					encoder.encode(
						'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
					),
				);
				return;
			}
			controller.abort(reason);
		},
	});
}

/** The reason `scopedTimeoutSignal` aborts with when its deadline expires. */
function deadlineReason(): DOMException {
	return new DOMException("The operation timed out.", "TimeoutError");
}

describe("a codex compaction deadline is a timeout", () => {
	test("an expired deadline fails as a timeout the ladder classifies as one", async () => {
		const controller = new AbortController();

		const error: unknown = await collectCodexCompactionV2Stream(
			silentAfterCreated(controller, deadlineReason()),
			controller.signal,
			t => t,
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toContain("timed out");
		expect(message).toContain("NOT compacted");
		expect(AIError.is(AIError.classify(error, "openai-codex-responses"), AIError.Flag.Timeout)).toBe(true);
		expect(isAbortError(error)).toBe(false);
	});

	test("a caller's cancellation fails as a cancellation, not a timeout", async () => {
		const controller = new AbortController();

		const error: unknown = await collectCodexCompactionV2Stream(
			silentAfterCreated(controller, undefined),
			controller.signal,
			t => t,
		).catch((caught: unknown) => caught);

		expect(isAbortError(error)).toBe(true);
		expect(isTimeoutError(error)).toBe(false);
		expect(AIError.is(AIError.classify(error, "openai-codex-responses"), AIError.Flag.Timeout)).toBe(false);
	});

	test("a body that closes on its own is still the backend's fault", async () => {
		const error: unknown = await collectCodexCompactionV2Stream(
			new ReadableStream<Uint8Array>({
				start(stream) {
					stream.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
					stream.close();
				},
			}),
			undefined,
			t => t,
		).catch((caught: unknown) => caught);

		const message = error instanceof Error ? error.message : String(error);
		expect(message).toContain("closed before response.completed");
		expect(AIError.is(AIError.classify(error, "openai-codex-responses"), AIError.Flag.Timeout)).toBe(false);
	});
});
