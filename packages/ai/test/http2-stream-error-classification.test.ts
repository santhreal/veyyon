import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";

/**
 * WHY: `Stream closed with error code NGHTTP2_INTERNAL_ERROR` reached the
 * session as an unclassified hard failure, so the model-fallback chain never
 * engaged and the turn was lost. The session layer must agree with the
 * transport layer on which HTTP/2 error codes are worth another attempt.
 *
 * The strings here are the ones Node v22 produces: `ERR_HTTP2_STREAM_ERROR`
 * carries `Stream closed with error code %s` and `ERR_HTTP2_SESSION_ERROR`
 * carries `Session closed with error code %s`.
 */

function streamError(code: string): Error {
	const error = new Error(`Stream closed with error code ${code}`) as NodeJS.ErrnoException;
	error.code = "ERR_HTTP2_STREAM_ERROR";
	return error;
}

describe("HTTP/2 stream error classification", () => {
	it("treats an NGHTTP2_INTERNAL_ERROR stream reset as transient and retriable", () => {
		const id = AIError.classify(streamError("NGHTTP2_INTERNAL_ERROR"));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("classifies the session spelling the same way", () => {
		const error = new Error("Session closed with error code NGHTTP2_INTERNAL_ERROR");
		expect(AIError.is(AIError.classify(error), AIError.Flag.Transient)).toBe(true);
	});

	it("classifies a reset nested in a cause chain", () => {
		const error = new Error("Cursor stream failed", { cause: streamError("NGHTTP2_REFUSED_STREAM") });
		expect(AIError.retriable(AIError.classify(error))).toBe(true);
	});

	const retryable = [
		"NGHTTP2_NO_ERROR",
		"NGHTTP2_PROTOCOL_ERROR",
		"NGHTTP2_INTERNAL_ERROR",
		"NGHTTP2_SETTINGS_TIMEOUT",
		"NGHTTP2_STREAM_CLOSED",
		"NGHTTP2_REFUSED_STREAM",
		"NGHTTP2_CONNECT_ERROR",
		"NGHTTP2_ENHANCE_YOUR_CALM",
	];
	for (const code of retryable) {
		it(`flags ${code} transient`, () => {
			expect(AIError.is(AIError.classify(streamError(code)), AIError.Flag.Transient)).toBe(true);
		});
	}

	const hard = [
		"NGHTTP2_FLOW_CONTROL_ERROR",
		"NGHTTP2_FRAME_SIZE_ERROR",
		"NGHTTP2_CANCEL",
		"NGHTTP2_COMPRESSION_ERROR",
		"NGHTTP2_INADEQUATE_SECURITY",
		"NGHTTP2_HTTP_1_1_REQUIRED",
	];
	for (const code of hard) {
		it(`leaves ${code} a hard failure`, () => {
			const id = AIError.classify(streamError(code));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
			expect(AIError.retriable(id)).toBe(false);
		});
	}

	it("does not let surrounding prose promote a cancel back to transient", () => {
		const error = new Error("provider returned error: Stream closed with error code NGHTTP2_CANCEL");
		const id = AIError.classify(error);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.retriable(id)).toBe(false);
	});

	it("keeps a replay-unsafe turn hard even when the transport fault is transient", () => {
		// The stream may have already delivered a tool call whose side effect ran.
		// Transport transience says the next attempt could differ; it says nothing
		// about whether replaying is safe, so the replay guard still wins.
		const id = AIError.classify(streamError("NGHTTP2_INTERNAL_ERROR"));
		expect(AIError.retriable(id, { replayUnsafe: true })).toBe(false);
	});
});
