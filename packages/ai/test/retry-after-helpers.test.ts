import { describe, expect, it } from "bun:test";
import { formatErrorMessageWithRetryAfter, getRetryAfterMsFromHeaders } from "../src/utils/retry-after";

describe("getRetryAfterMsFromHeaders", () => {
	it("returns undefined for undefined headers", () => {
		expect(getRetryAfterMsFromHeaders(undefined)).toBeUndefined();
	});
	it("returns undefined for null headers", () => {
		expect(getRetryAfterMsFromHeaders(null)).toBeUndefined();
	});
	it("parses retry-after-ms header", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "5000" })).toBe(5000);
	});
	it("parses retry-after header as seconds", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "5" })).toBe(5000);
	});
	it("parses retry-after header as HTTP date", () => {
		const future = new Date(Date.now() + 5000);
		const result = getRetryAfterMsFromHeaders({ "retry-after": future.toUTCString() });
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(10000);
	});
	it("parses x-ratelimit-reset-ms header", () => {
		const result = getRetryAfterMsFromHeaders({ "x-ratelimit-reset-ms": "1000" });
		expect(result).not.toBeUndefined();
		expect(result).toBeGreaterThanOrEqual(0);
	});
	it("parses x-ratelimit-reset header as seconds", () => {
		const result = getRetryAfterMsFromHeaders({ "x-ratelimit-reset": "1" });
		expect(result).not.toBeUndefined();
		expect(result).toBeGreaterThanOrEqual(0);
	});
	it("returns undefined for no relevant headers", () => {
		expect(getRetryAfterMsFromHeaders({ "content-type": "application/json" })).toBeUndefined();
	});
	it("returns undefined for invalid retry-after-ms", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "abc" })).toBeUndefined();
	});
	it("returns undefined for negative retry-after-ms", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "-1" })).toBeUndefined();
	});
	it("returns undefined for negative retry-after", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "-1" })).toBeUndefined();
	});
	it("returns undefined for invalid retry-after", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "not-a-date" })).toBeUndefined();
	});
	it("returns max of multiple candidates", () => {
		const result = getRetryAfterMsFromHeaders({
			"retry-after-ms": "3000",
			"retry-after": "10",
		});
		expect(result).toBe(10000);
	});
	it("handles Headers instance", () => {
		const headers = new Headers({ "retry-after-ms": "2000" });
		expect(getRetryAfterMsFromHeaders(headers)).toBe(2000);
	});
	it("ceils fractional retry-after-ms", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "4.7" })).toBe(5);
	});
	it("ceils fractional retry-after seconds", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "2.5" })).toBe(2500);
	});
	it("returns 0 for retry-after of 0", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "0" })).toBe(0);
	});
	it("returns 0 for retry-after-ms of 0", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "0" })).toBe(0);
	});
});

describe("formatErrorMessageWithRetryAfter", () => {
	it("returns message as-is when no headers and no retry-after hint", () => {
		const err = new Error("something failed");
		expect(formatErrorMessageWithRetryAfter(err)).toBe("something failed");
	});
	it("appends retry-after-ms hint from headers", () => {
		const err = new Error("rate limited");
		const result = formatErrorMessageWithRetryAfter(err, { "retry-after-ms": "5000" });
		expect(result).toContain("retry-after-ms=5000");
		expect(result).toContain("rate limited");
	});
	it("does not duplicate hint when already in message", () => {
		const err = new Error("rate limited retry-after-ms=5000");
		const result = formatErrorMessageWithRetryAfter(err, { "retry-after-ms": "5000" });
		expect(result).toBe("rate limited retry-after-ms=5000");
	});
	it("handles non-Error error", () => {
		const result = formatErrorMessageWithRetryAfter("string error");
		expect(result).toContain("string error");
	});
	it("handles non-Error object error", () => {
		const result = formatErrorMessageWithRetryAfter({ key: "value" });
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
	it("returns message without hint when no retry-after headers", () => {
		const err = new Error("failed");
		const result = formatErrorMessageWithRetryAfter(err, { "content-type": "application/json" });
		expect(result).toBe("failed");
	});
});
