/**
 * isRetriableConnectionError: only Error instances with known network/session
 * failure substrings or HTTP 404/502/503 prefixes. Non-errors and HTTP 500 are not retriable.
 */
import { describe, expect, it } from "bun:test";
import { isRetriableConnectionError } from "@veyyon/coding-agent/mcp/tool-bridge";

const RETRIABLE = [
	"ECONNRESET",
	"econnrefused",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"fetch failed",
	"Transport not connected",
	"transport closed",
	"Network Error",
	"HTTP 404: session gone",
	"http 502: bad gateway",
	"HTTP 503: unavailable",
];

const NOT_RETRIABLE = [
	"HTTP 500: internal",
	"HTTP 400: bad request",
	"timeout waiting",
	"ENOTFOUND",
	"socket hang up",
	"connection reset by peer",
	"invalid json",
	"permission denied",
	"random failure",
];

describe("isRetriableConnectionError matrix", () => {
	for (const msg of RETRIABLE) {
		it(`retriable: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(true);
		});
	}

	for (const msg of NOT_RETRIABLE) {
		it(`not retriable: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(false);
		});
	}

	it("non-Error values are never retriable", () => {
		expect(isRetriableConnectionError("econnreset")).toBe(false);
		expect(isRetriableConnectionError(null)).toBe(false);
		expect(isRetriableConnectionError(undefined)).toBe(false);
		expect(isRetriableConnectionError({ message: "econnreset" })).toBe(false);
		expect(isRetriableConnectionError(42)).toBe(false);
	});

	it("case-insensitive substring match on message", () => {
		expect(isRetriableConnectionError(new Error("FETCH FAILED somewhere"))).toBe(true);
		expect(isRetriableConnectionError(new Error("TRANSPORT CLOSED"))).toBe(true);
	});
});
