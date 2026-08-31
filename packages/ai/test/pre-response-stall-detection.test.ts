/**
 * WHY: `isPreResponseStallMessage` and `isPreResponseStall` decide whether an
 * error is a pre-response stall (the provider accepted the request but never
 * sent the first token). A false positive retries a non-stall error, burning
 * retries; a false negative skips the retry ladder and surfaces a hang as a
 * hard failure. The pattern match covers "timed out", "timeout", "stream
 * stall", and the Anthropic connection timeout error name.
 *
 * This suite covers every branch: pattern hits, pattern misses, non-Error
 * inputs, the Anthropic timeout name, and the `isTimeoutError` path.
 */
import { describe, expect, it } from "bun:test";
import { isPreResponseStall, isPreResponseStallMessage } from "../src/utils/first-event-budget";

describe("isPreResponseStallMessage", () => {
	it("matches 'timed out'", () => {
		expect(isPreResponseStallMessage("The request timed out")).toBe(true);
	});

	it("matches 'timeout'", () => {
		expect(isPreResponseStallMessage("timeout waiting for response")).toBe(true);
	});

	it("matches 'stream stall'", () => {
		expect(isPreResponseStallMessage("stream stall detected")).toBe(true);
	});

	it("matches case-insensitively", () => {
		expect(isPreResponseStallMessage("TIMED OUT")).toBe(true);
		expect(isPreResponseStallMessage("Timeout")).toBe(true);
		expect(isPreResponseStallMessage("STREAM STALL")).toBe(true);
	});

	it("matches 'time out' with optional space", () => {
		expect(isPreResponseStallMessage("time out")).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isPreResponseStallMessage("internal server error")).toBe(false);
		expect(isPreResponseStallMessage("rate limited")).toBe(false);
		expect(isPreResponseStallMessage("")).toBe(false);
	});

	it("does not match 'timeout' as a substring of a larger word", () => {
		expect(isPreResponseStallMessage("timeoutsarenotreal")).toBe(false);
	});

	it("matches 'timeout' with word boundary", () => {
		expect(isPreResponseStallMessage("connection timeout: 30s")).toBe(true);
	});
});

describe("isPreResponseStall", () => {
	it("returns false for non-Error values", () => {
		expect(isPreResponseStall(null)).toBe(false);
		expect(isPreResponseStall(undefined)).toBe(false);
		expect(isPreResponseStall("timeout")).toBe(false);
		expect(isPreResponseStall(42)).toBe(false);
		expect(isPreResponseStall({ message: "timeout" })).toBe(false);
	});

	it("returns true for an Error with a timeout message", () => {
		expect(isPreResponseStall(new Error("The request timed out"))).toBe(true);
		expect(isPreResponseStall(new Error("stream stall"))).toBe(true);
	});

	it("returns false for an Error with a non-stall message", () => {
		expect(isPreResponseStall(new Error("rate limited"))).toBe(false);
		expect(isPreResponseStall(new Error("internal server error"))).toBe(false);
	});

	it("returns true for an AnthropicConnectionTimeoutError", () => {
		const err = new Error("connection failed");
		err.name = "AnthropicConnectionTimeoutError";
		expect(isPreResponseStall(err)).toBe(true);
	});

	it("returns true for a DOMException with timeout name via isTimeoutError", () => {
		const err = new DOMException("aborted", "TimeoutError");
		expect(isPreResponseStall(err)).toBe(true);
	});

	it("returns false for a generic Error with a non-timeout name", () => {
		const err = new Error("something broke");
		err.name = "TypeError";
		expect(isPreResponseStall(err)).toBe(false);
	});
});
