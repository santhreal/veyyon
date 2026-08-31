import { describe, expect, it } from "bun:test";
import {
	CONNECT_RATE_LIMIT_PATTERN,
	CONNECT_TRANSIENT_CODES,
	type ConnectTrailerFailure,
	connectFailureStatus,
	normalizeConnectCode,
} from "../src/error/connect";

describe("CONNECT_TRANSIENT_CODES", () => {
	it("contains unavailable", () => {
		expect(CONNECT_TRANSIENT_CODES.has("unavailable")).toBe(true);
	});
	it("contains internal", () => {
		expect(CONNECT_TRANSIENT_CODES.has("internal")).toBe(true);
	});
	it("contains deadline_exceeded", () => {
		expect(CONNECT_TRANSIENT_CODES.has("deadline_exceeded")).toBe(true);
	});
	it("contains aborted", () => {
		expect(CONNECT_TRANSIENT_CODES.has("aborted")).toBe(true);
	});
	it("contains resource_exhausted", () => {
		expect(CONNECT_TRANSIENT_CODES.has("resource_exhausted")).toBe(true);
	});
	it("contains unknown", () => {
		expect(CONNECT_TRANSIENT_CODES.has("unknown")).toBe(true);
	});
	it("does not contain unauthenticated", () => {
		expect(CONNECT_TRANSIENT_CODES.has("unauthenticated")).toBe(false);
	});
});

describe("CONNECT_RATE_LIMIT_PATTERN", () => {
	it("matches 'rate limit'", () => {
		expect(CONNECT_RATE_LIMIT_PATTERN.test("rate limit exceeded")).toBe(true);
	});
	it("matches 'rate-limit'", () => {
		expect(CONNECT_RATE_LIMIT_PATTERN.test("rate-limit exceeded")).toBe(true);
	});
	it("matches 'ratelimited'", () => {
		expect(CONNECT_RATE_LIMIT_PATTERN.test("ratelimited")).toBe(true);
	});
	it("matches 'too many requests'", () => {
		expect(CONNECT_RATE_LIMIT_PATTERN.test("too many requests")).toBe(true);
	});
	it("is case-insensitive", () => {
		expect(CONNECT_RATE_LIMIT_PATTERN.test("RATE LIMIT")).toBe(true);
	});
	it("does not match unrelated text", () => {
		expect(CONNECT_RATE_LIMIT_PATTERN.test("some other error")).toBe(false);
	});
});

describe("normalizeConnectCode", () => {
	it("maps numeric code to gRPC name", () => {
		expect(normalizeConnectCode("1")).toBe("canceled");
		expect(normalizeConnectCode("14")).toBe("unavailable");
		expect(normalizeConnectCode("16")).toBe("unauthenticated");
	});
	it("returns trimmed lowercase for unknown numeric code", () => {
		expect(normalizeConnectCode("  99  ")).toBe("99");
	});
	it("returns trimmed lowercase for named code", () => {
		expect(normalizeConnectCode("  Unavailable  ")).toBe("unavailable");
	});
	it("passes through already-normalized name", () => {
		expect(normalizeConnectCode("internal")).toBe("internal");
	});
});

describe("connectFailureStatus", () => {
	it("returns 429 for rate limit message", () => {
		const failure: ConnectTrailerFailure = { code: "8", message: "rate limit exceeded" };
		expect(connectFailureStatus(failure)).toBe(429);
	});
	it("returns 429 for 'too many requests' message", () => {
		const failure: ConnectTrailerFailure = { code: "8", message: "too many requests" };
		expect(connectFailureStatus(failure)).toBe(429);
	});
	it("returns 401 for unauthenticated", () => {
		const failure: ConnectTrailerFailure = { code: "16", message: "auth required" };
		expect(connectFailureStatus(failure)).toBe(401);
	});
	it("returns 429 for resource_exhausted", () => {
		const failure: ConnectTrailerFailure = { code: "8", message: "exhausted" };
		expect(connectFailureStatus(failure)).toBe(429);
	});
	it("returns 503 for unavailable", () => {
		const failure: ConnectTrailerFailure = { code: "14", message: "server unavailable" };
		expect(connectFailureStatus(failure)).toBe(503);
	});
	it("returns 503 for internal", () => {
		const failure: ConnectTrailerFailure = { code: "13", message: "internal error" };
		expect(connectFailureStatus(failure)).toBe(503);
	});
	it("returns 503 for deadline_exceeded", () => {
		const failure: ConnectTrailerFailure = { code: "4", message: "timed out" };
		expect(connectFailureStatus(failure)).toBe(503);
	});
	it("returns undefined for non-transient non-auth code", () => {
		const failure: ConnectTrailerFailure = { code: "3", message: "invalid argument" };
		expect(connectFailureStatus(failure)).toBeUndefined();
	});
	it("rate limit message takes precedence over code", () => {
		const failure: ConnectTrailerFailure = { code: "3", message: "rate limit" };
		expect(connectFailureStatus(failure)).toBe(429);
	});
});
