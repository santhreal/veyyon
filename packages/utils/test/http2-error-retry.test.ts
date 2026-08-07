import { describe, expect, it } from "bun:test";
import { constants } from "node:http2";
import { fetchWithRetry, http2ErrorCode, http2RetryVerdict, isRetryableError } from "@veyyon/utils/fetch-retry";

/**
 * WHY: a Cursor turn died on `Stream closed with error code NGHTTP2_INTERNAL_ERROR`
 * and was treated as a hard failure, so neither the transport retry nor the
 * session-level model fallback engaged and the turn was lost. This layer only
 * knew the phrase "internal error" with a literal space, so the NGHTTP2
 * spelling never matched anything.
 *
 * These tests pin the RFC 7540 section 7 split: a transport or peer fault is
 * retried, a request-shaped or self-inflicted failure stays hard.
 *
 * The code names come from `node:http2` constants rather than from literals, so
 * a typo cannot make a case vacuous. The surrounding template is Node's
 * `ERR_HTTP2_STREAM_ERROR` message, `Stream closed with error code %s`, and its
 * session twin `Session closed with error code %s`.
 */

const RETRYABLE = [
	"NGHTTP2_NO_ERROR",
	"NGHTTP2_PROTOCOL_ERROR",
	"NGHTTP2_INTERNAL_ERROR",
	"NGHTTP2_SETTINGS_TIMEOUT",
	"NGHTTP2_STREAM_CLOSED",
	"NGHTTP2_REFUSED_STREAM",
	"NGHTTP2_CONNECT_ERROR",
	"NGHTTP2_ENHANCE_YOUR_CALM",
];

const HARD = [
	"NGHTTP2_FLOW_CONTROL_ERROR",
	"NGHTTP2_FRAME_SIZE_ERROR",
	"NGHTTP2_CANCEL",
	"NGHTTP2_COMPRESSION_ERROR",
	"NGHTTP2_INADEQUATE_SECURITY",
	"NGHTTP2_HTTP_1_1_REQUIRED",
];

describe("HTTP/2 error-code retry classification", () => {
	it("retries the reset that lost the turn", () => {
		const error = new Error("Stream closed with error code NGHTTP2_INTERNAL_ERROR");
		expect(isRetryableError(error)).toBe(true);
	});

	it("reads the code out of both the stream and the session spelling", () => {
		expect(http2ErrorCode("Stream closed with error code NGHTTP2_REFUSED_STREAM")).toBe("NGHTTP2_REFUSED_STREAM");
		expect(http2ErrorCode("Session closed with error code NGHTTP2_ENHANCE_YOUR_CALM")).toBe(
			"NGHTTP2_ENHANCE_YOUR_CALM",
		);
		expect(http2ErrorCode("fetch failed")).toBeUndefined();
	});

	it("returns no verdict for an unrecognised code so the generic heuristics still run", () => {
		expect(http2RetryVerdict("Stream closed with error code NGHTTP2_SOMETHING_NEW")).toBeUndefined();
		expect(http2RetryVerdict("fetch failed")).toBeUndefined();
	});

	it("covers every RFC 7540 error code exactly once", () => {
		// 0x0 through 0xd, no gaps and no duplicates: a code that reaches neither
		// set falls back to wording heuristics that cannot read it.
		const values = [...RETRYABLE, ...HARD].map(name => {
			const value = constants[name as keyof typeof constants];
			if (typeof value !== "number") throw new Error(`${name} is not an http2 constant`);
			return value;
		});
		expect([...values].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
	});

	for (const code of RETRYABLE) {
		it(`retries ${code}`, () => {
			const message = `Stream closed with error code ${code}`;
			expect(http2RetryVerdict(message)).toBe(true);
			expect(isRetryableError(new Error(message))).toBe(true);
		});
	}

	for (const code of HARD) {
		it(`does not retry ${code}`, () => {
			const message = `Stream closed with error code ${code}`;
			expect(http2RetryVerdict(message)).toBe(false);
			expect(isRetryableError(new Error(message))).toBe(false);
		});
	}

	it("keeps a cancel hard even when the wrapper text reads transient", () => {
		// A named code is a definite answer about whether a replay can differ.
		// Without the override, "server error" in the surrounding prose drags a
		// user-initiated cancel back into the retry loop.
		const error = new Error("upstream server error: Stream closed with error code NGHTTP2_CANCEL");
		expect(isRetryableError(error)).toBe(false);
	});

	it("retries a GOAWAY that closed the session before the stream was created", () => {
		// ERR_HTTP2_GOAWAY_SESSION. The stream never existed, so nothing was
		// processed and the replay is unambiguously safe.
		const error = new Error("New streams cannot be created after receiving a GOAWAY");
		expect(http2RetryVerdict(error.message)).toBe(true);
		expect(isRetryableError(error)).toBe(true);
	});

	it("leaves the pending-stream cancel spelling hard", () => {
		// ERR_HTTP2_STREAM_CANCEL is our own abort, not the peer's weather.
		expect(isRetryableError(new Error("The pending stream has been canceled"))).toBe(false);
	});
});

/**
 * WHY: classifying a code as deterministic is only worth something if the retry
 * loop in the same module acts on it. `fetchWithRetry` used to retry every
 * thrown transport error without consulting any classifier, so a request that
 * failed with `NGHTTP2_CANCEL` -- normally our own abort arriving through a
 * per-attempt signal the loop cannot observe on `signal` -- was re-sent in full
 * four more times to reach the identical answer. On a provider request that is
 * four extra copies of the whole prompt on the wire.
 */
describe("fetchWithRetry honors the HTTP/2 verdict", () => {
	const attemptsFor = async (message: string, maxAttempts: number): Promise<number> => {
		let attempts = 0;
		await fetchWithRetry("https://example.invalid/v1/messages", {
			method: "POST",
			body: "prompt",
			maxAttempts,
			defaultDelayMs: 0,
			fetch: async () => {
				attempts++;
				throw new Error(message);
			},
		}).catch(() => undefined);
		return attempts;
	};

	for (const code of HARD) {
		it(`sends ${code} exactly once`, async () => {
			expect(await attemptsFor(`Stream closed with error code ${code}`, 5)).toBe(1);
		});
	}

	it("still spends the whole budget on a retryable code", async () => {
		expect(await attemptsFor("Stream closed with error code NGHTTP2_REFUSED_STREAM", 5)).toBe(5);
	});

	it("reads the code through the `fetch failed` cause wrapper", async () => {
		let attempts = 0;
		await fetchWithRetry("https://example.invalid/v1/messages", {
			maxAttempts: 5,
			defaultDelayMs: 0,
			fetch: async () => {
				attempts++;
				throw new Error("fetch failed", { cause: new Error("Stream closed with error code NGHTTP2_CANCEL") });
			},
		}).catch(() => undefined);
		expect(attempts).toBe(1);
	});

	it("leaves an unclassifiable transport error on the existing budget", async () => {
		expect(await attemptsFor("socket hang up", 3)).toBe(3);
	});
});
