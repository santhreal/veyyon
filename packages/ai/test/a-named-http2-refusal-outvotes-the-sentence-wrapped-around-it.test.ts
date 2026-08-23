/**
 * WHY. An HTTP/2 error code is the peer's own statement about whether another attempt can differ,
 * and six of them mean it cannot: `NGHTTP2_CANCEL` (our own abort), `FLOW_CONTROL_ERROR`,
 * `FRAME_SIZE_ERROR`, `COMPRESSION_ERROR`, `INADEQUATE_SECURITY`, `HTTP_1_1_REQUIRED`. The
 * classifier read the code and refused those, and then two things put the retry back:
 *
 *  - the provider predicate's prose fallback. `Stream closed with error code NGHTTP2_CANCEL:
 *    operation timed out` carries the word "timed out", which matches the transport pattern, so a
 *    cancel the classifier had already refused was retried anyway.
 *  - a wrapper's own sentence. The classifier computes the HTTP/2 verdict per LINK, so a wrapper
 *    whose message says "connection error" over a cause naming `NGHTTP2_CANCEL` had no code in its
 *    own signal and set `Flag.Transient` from prose.
 *
 * The class this closes: a structural fact being outvoted by a sentence composed around it. The fact
 * is now a flag of its own, `Flag.TransportRefused`, owned by the `refusal` family and ordered ahead
 * of `transport` in the registry, so one place decides it and every stage reads the same answer. The
 * flag sits BESIDE `Flag.Transient` rather than clearing it: the wrapper's sentence is still what the
 * failure looks like, and a deadline that cancelled its own stream still has to say it timed out —
 * clearing the bit instead broke exactly that message.
 *
 * What it does not catch: whether a given `NGHTTP2_*` code belongs in the retryable set or the
 * refused one. That is `fetch-retry`'s own decision and its own suite. It also does not cover the
 * loops that still ask `Flag.Transient` directly instead of the registry; each is migrated with its
 * own suite.
 */
import { describe, expect, it } from "bun:test";
import { classify, Flag, is, isProviderRetryableError, recover, retriable } from "@veyyon/ai/error";
import { STREAM_FRAME_LIMIT_ERROR_NAME } from "@veyyon/utils/stream-frame-limit";

/** The codes a replay reproduces, in the spelling Node puts in the message. */
const REFUSED_CODES = [
	"NGHTTP2_CANCEL",
	"NGHTTP2_FLOW_CONTROL_ERROR",
	"NGHTTP2_FRAME_SIZE_ERROR",
	"NGHTTP2_COMPRESSION_ERROR",
	"NGHTTP2_INADEQUATE_SECURITY",
	"NGHTTP2_HTTP_1_1_REQUIRED",
] as const;

/** Codes whose meaning is "the transport failed", which stay retryable. */
const RETRYABLE_CODES = ["NGHTTP2_NO_ERROR", "NGHTTP2_REFUSED_STREAM", "NGHTTP2_INTERNAL_ERROR"] as const;

const streamError = (code: string, tail = ""): Error => new Error(`Stream closed with error code ${code}${tail}`);

describe("a named HTTP/2 refusal", () => {
	it("is refused for every code that a replay reproduces", () => {
		for (const code of REFUSED_CODES) {
			const error = streamError(code);
			expect(is(classify(error), Flag.TransportRefused)).toBe(true);
			expect(is(classify(error), Flag.Transient)).toBe(false);
			expect(isProviderRetryableError(error)).toBe(false);
		}
	});

	it("survives a transient-sounding tail on its own message", () => {
		for (const code of REFUSED_CODES) {
			const error = streamError(code, ": operation timed out");
			expect(is(classify(error), Flag.Transient)).toBe(false);
			expect(isProviderRetryableError(error)).toBe(false);
		}
	});

	it("survives a wrapper that composed its own sentence around the cause", () => {
		for (const code of REFUSED_CODES) {
			const wrapped = new Error("provider stream failed: connection error, please retry your request", {
				cause: streamError(code),
			});
			const id = classify(wrapped);
			expect(is(id, Flag.TransportRefused)).toBe(true);
			// The wrapper's own sentence still describes it, and nobody retries it anyway.
			expect(is(id, Flag.Transient)).toBe(true);
			expect(retriable(id)).toBe(false);
			expect(recover(id, "transport").action).toBe("surface");
			expect(isProviderRetryableError(wrapped)).toBe(false);
		}
	});

	it("survives a wrapper carrying a transient status", () => {
		const wrapped = new Error("503 Service Unavailable", { cause: streamError("NGHTTP2_HTTP_1_1_REQUIRED") });
		const id = classify(wrapped);
		expect(is(id, Flag.TransportRefused)).toBe(true);
		expect(retriable(id)).toBe(false);
		expect(isProviderRetryableError(wrapped)).toBe(false);
	});

	it("is found however deep in the chain it sits", () => {
		const deep = new Error("turn failed", {
			cause: new Error("stream aborted", { cause: new Error("upstream", { cause: streamError("NGHTTP2_CANCEL") }) }),
		});
		expect(is(classify(deep), Flag.TransportRefused)).toBe(true);
		expect(isProviderRetryableError(deep)).toBe(false);
	});

	it("ends rather than looping on a chain that points at itself", () => {
		const looped: Error & { cause?: unknown } = new Error("fetch failed");
		looped.cause = looped;
		expect(is(classify(looped), Flag.TransportRefused)).toBe(false);
		expect(isProviderRetryableError(looped)).toBe(true);
	});
});

describe("the refusal is narrow", () => {
	it("leaves a transport code retryable", () => {
		for (const code of RETRYABLE_CODES) {
			const error = streamError(code);
			expect(is(classify(error), Flag.TransportRefused)).toBe(false);
			expect(is(classify(error), Flag.Transient)).toBe(true);
			expect(isProviderRetryableError(error)).toBe(true);
		}
	});

	it("leaves an unrecognised code to the wording rules", () => {
		const error = streamError("NGHTTP2_SOMETHING_NEW", ": service unavailable");
		expect(is(classify(error), Flag.TransportRefused)).toBe(false);
		expect(is(classify(error), Flag.Transient)).toBe(true);
	});

	it("leaves a failure that names no code at all transient", () => {
		const error = new Error("upstream connect error: connection refused");
		expect(is(classify(error), Flag.TransportRefused)).toBe(false);
		expect(is(classify(error), Flag.Transient)).toBe(true);
		expect(isProviderRetryableError(error)).toBe(true);
	});

	it("still refuses a framing violation, which is the other structural refusal", () => {
		const framing = Object.assign(new Error("a line arrived with no line feed and was terminated"), {
			name: STREAM_FRAME_LIMIT_ERROR_NAME,
		});
		expect(is(classify(framing), Flag.Transient)).toBe(false);
		expect(isProviderRetryableError(framing)).toBe(false);
	});
});
