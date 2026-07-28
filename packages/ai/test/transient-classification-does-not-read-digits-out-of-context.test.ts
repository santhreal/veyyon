/**
 * A status number embedded in unrelated text must not make a permanent failure look transient.
 *
 * THE BUG. `TRANSIENT_TRANSPORT_PATTERN` listed the retryable HTTP statuses as bare alternatives,
 * `429|500|502|503|504`, with nothing anchoring them. A regex alternative matches anywhere, so any
 * error message that happened to contain those three digits in a row was classified as a transient
 * transport failure. Real examples, both verified against the pre-fix pattern:
 *
 *   Devin stream error invalid_argument: bad tool schema (trace ID: aaa503bbb)
 *   model 500m-params is not supported
 *
 * Neither is transient. The first is the server rejecting the request and the second is a
 * configuration mistake, and both would be retried through the entire provider budget with backoff
 * before the operator was told anything at all. It surfaced through Devin, whose every error message
 * carries a 32-character hex trace ID, but the exposure is any provider and any message with a digit
 * run in it: a token count, a timestamp, a request id, a duration.
 *
 * WHICH DIRECTION THIS FAILS IN, and why it is worth a suite. Misreading permanent as transient
 * spends the retry budget and, for a rate limit, real quota on requests that cannot succeed, while
 * hiding the true error behind a delay. So the tests below assert BOTH halves: the out-of-context
 * digits no longer match, and every genuine rendering of a status still does. A fix that narrowed
 * the pattern into missing real 503s would trade this bug for the far worse one of never retrying.
 */
import { describe, expect, it } from "bun:test";
import { TRANSIENT_TRANSPORT_PATTERN } from "@veyyon/ai/error/flags";

describe("TRANSIENT_TRANSPORT_PATTERN and digits that are not statuses", () => {
	/**
	 * The exact message that exposed this, kept verbatim.
	 *
	 * Devin appends `(trace ID: <32 hex chars>)` to every stream error. Hex includes the decimal
	 * digits, so a trace ID containing `503`, `429`, `500`, `502` or `504` is routine rather than
	 * exotic, and it silently converted a permanent `invalid_argument` into a retried one.
	 */
	it("does not treat a trace ID containing a status number as a server fault", () => {
		expect(
			TRANSIENT_TRANSPORT_PATTERN.test("Devin stream error invalid_argument: bad tool schema (trace ID: aaa503bbb)"),
		).toBe(false);
		expect(
			TRANSIENT_TRANSPORT_PATTERN.test("Devin stream error invalid_argument: bad tool schema (trace ID: aaa429bbb)"),
		).toBe(false);
		expect(
			TRANSIENT_TRANSPORT_PATTERN.test("Devin stream error invalid_argument: schema too deep (trace ID: 4b56ec500a4a)"),
		).toBe(false);
	});

	/** A model name is not a status, and `500m-params` is a plausible one. */
	it("does not treat digits inside an identifier as a status", () => {
		expect(TRANSIENT_TRANSPORT_PATTERN.test("model 500m-params is not supported")).toBe(false);
		expect(TRANSIENT_TRANSPORT_PATTERN.test("unknown model gpt-504-turbo")).toBe(false);
	});

	/**
	 * Counts and durations are the other everyday source of digit runs.
	 *
	 * These are the messages most likely to carry a long number, and none of them is a transport
	 * failure. A context-length rejection retried as a 500 is a permanent failure retried forever.
	 */
	it("does not treat token counts or durations as statuses", () => {
		expect(TRANSIENT_TRANSPORT_PATTERN.test("input is 429000 tokens, above the 200000 limit")).toBe(false);
		expect(TRANSIENT_TRANSPORT_PATTERN.test("request rejected: prompt has 15029 messages")).toBe(false);
	});
});

describe("TRANSIENT_TRANSPORT_PATTERN still matches every real status rendering", () => {
	/**
	 * The half that must not regress, and the reason the fix is `\b` rather than a narrower literal.
	 *
	 * Providers render statuses many ways and all of them have a non-word character or a string edge
	 * beside the number, which is exactly what `\b` keys on. If any of these stopped matching, real
	 * transient failures would stop being retried, which is a worse outcome than the bug being fixed.
	 */
	it.each([
		["bare", "503"],
		["with the scheme", "HTTP 503"],
		["labelled", "status: 502"],
		["parenthesised", "Cloud Code Assist API error (429)"],
		["with a trailing colon", "500: internal error"],
		["mid-sentence", "server returned 504 while streaming"],
		["comma separated", "retrying after 429, attempt 2"],
		["slash separated", "upstream/502"],
		["at the end of a sentence", "the gateway answered 503."],
	])("matches a status %s", (_shape, message) => {
		expect(TRANSIENT_TRANSPORT_PATTERN.test(message)).toBe(true);
	});

	/**
	 * The non-numeric alternatives are untouched, pinned so a future edit to the number group cannot
	 * quietly damage the rest of a pattern this long.
	 */
	it.each([
		"overloaded",
		"rate limit exceeded",
		"too many requests",
		"service unavailable",
		"socket hang up",
		"other side closed",
		"fetch failed",
		"connection refused",
		"stream stall",
		"HTTP2StreamReset",
	])("still matches %s", message => {
		expect(TRANSIENT_TRANSPORT_PATTERN.test(message)).toBe(true);
	});
});
