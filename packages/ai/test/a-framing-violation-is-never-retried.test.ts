/**
 * A framing violation is never retried.
 *
 * WHY THIS SUITE EXISTS. The stream readers now refuse a frame a peer never delimited,
 * which turns a silent heap climb into a thrown error — and an error thrown mid-stream
 * lands in the provider retry loop. The classifier decides transience from the message
 * when nothing structural says otherwise, and `TRANSIENT_TRANSPORT_PATTERN` contains
 * `/terminated/`, which the obvious wording for this failure ("unterminated line") matches
 * outright. That verdict would have re-dialled the peer that was mid-attack, on backoff,
 * for as many attempts as the loop allows: the bound would have stopped one allocation and
 * authorised the next.
 *
 * THE CLASS, not the incident. Every frame kind the reader can refuse is swept from the
 * union at run time, and both call sites are asserted — `classify` (which the turn loop,
 * auto-compaction and the candidate loops all read) and `isProviderRetryableError` (the
 * seconds-scale provider backoff) — for the bare error and for a provider wrapper that
 * carries it only as a `cause` while composing its own transient-sounding sentence. The
 * control is the same wrapper sentence with no framing cause: it must still be retryable,
 * so a green suite cannot mean the sentence stopped mattering to everything.
 *
 * WHAT THIS DOES NOT CATCH. Nothing here proves a provider actually surfaces the reader's
 * error rather than swallowing it; that is the reader's own suite in `@veyyon/utils`.
 */

import { describe, expect, it } from "bun:test";
import { classify, Flag, is, recover, retriable, vetoesRetry } from "@veyyon/ai/error/flags";
import { isProviderRetryableError } from "@veyyon/ai/error/retryable";
import { type StreamFrameKind, StreamFrameLimitError } from "@veyyon/utils/stream-frame-limit";

// Read off the module's own union rather than restated: a fifth frame kind added to the
// reader must be decided here before it can reach a retry loop undecided.
const FRAME_KINDS: StreamFrameKind[] = ["line", "jsonl-record", "sse-line", "sse-event"];

describe("a peer that broke framing is not worth a second request", () => {
	it.each(FRAME_KINDS)("refuses to retry a %s violation", frame => {
		const error = new StreamFrameLimitError(frame, 2048, 1024);

		expect(isProviderRetryableError(error)).toBe(false);
		expect(is(classify(error), Flag.Transient)).toBe(false);
	});

	/**
	 * THE REFUSAL IS A FLAG NOW, not an absence of one. Clearing `Flag.Transient` for the chain left
	 * every veto reader with nothing to read, so the provider ladder needed a hand-written check of
	 * its own — and a wrapper sentence that classified as something ELSE still got past it: a
	 * deadline's "operation timed out" reaches the timeout family, whose transport stage retries.
	 * `Flag.TransportRefused` is the same answer the named HTTP/2 codes give, so one veto covers both
	 * structural refusals and every reader of the decision sees it.
	 */
	it.each(FRAME_KINDS)("declares a %s violation a refusal every reader can see", frame => {
		const error = new StreamFrameLimitError(frame, 2048, 1024);
		const id = classify(error);

		expect(is(id, Flag.TransportRefused)).toBe(true);
		expect(vetoesRetry(id)).toBe(true);
		expect(retriable(id)).toBe(false);
		expect(recover(id, "transport").action).toBe("surface");
	});

	it("stays terminal under a wrapper that classifies as a deadline", () => {
		// The hole the hand-written check left: this sentence is the timeout family's, whose transport
		// stage retries, so a ladder reading the stage's answer would have re-sent it.
		const wrapped = new Error("operation timed out", {
			cause: new StreamFrameLimitError("sse-event", 70_000_000, 67_108_864),
		});
		const id = classify(wrapped);

		expect(is(id, Flag.Timeout)).toBe(true);
		expect(vetoesRetry(id)).toBe(true);
		expect(isProviderRetryableError(wrapped)).toBe(false);
		expect(retriable(id)).toBe(false);
	});

	it("stays terminal when a provider wraps it in a transient-sounding sentence", () => {
		// The exact shape that made this necessary: the wrapper's prose says "terminated",
		// which the transient-transport pattern matches, and the real cause is underneath.
		const wrapped = new Error("stream terminated unexpectedly", {
			cause: new StreamFrameLimitError("sse-event", 70_000_000, 67_108_864),
		});

		expect(isProviderRetryableError(wrapped)).toBe(false);
		expect(is(classify(wrapped), Flag.Transient)).toBe(false);
	});

	it("still retries that same sentence when no framing violation caused it", () => {
		// The control. Without it, a suite that suppressed transience for every error
		// mentioning a stream would look identical to one that reads the cause chain.
		const transport = new Error("stream terminated unexpectedly");

		expect(isProviderRetryableError(transport)).toBe(true);
		expect(is(classify(transport), Flag.Transient)).toBe(true);
	});

	it("dominates a transient signal from anywhere else in the chain", () => {
		// A 503 underneath is a fact about the transport, but it is not why this stream
		// ended: the peer would not delimit its frame, and the next attempt reaches the
		// same peer. Whichever link mentions what, the verdict is terminal.
		const framing = new StreamFrameLimitError("line", 2048, 1024);
		Object.defineProperty(framing, "cause", {
			value: new Error("503 service unavailable"),
			configurable: true,
		});
		const outer = new Error("provider stream failed", { cause: framing });

		expect(is(classify(outer), Flag.Transient)).toBe(false);
		expect(isProviderRetryableError(outer)).toBe(false);
		// The control: the same 503 with no framing breach above it is still transient, so
		// this is a suppression of one class and not of every layered error.
		const plain = new Error("provider stream failed", { cause: new Error("503 service unavailable") });
		expect(is(classify(plain), Flag.Transient)).toBe(true);
	});
});
