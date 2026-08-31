import { describe, expect, it } from "bun:test";
import {
	formatErrorMessageWithRetryAfter,
	getHeadersFromError,
	getRetryAfterMsFromHeaders,
} from "../src/utils/retry-after";

describe("getRetryAfterMsFromHeaders", () => {
	it("returns undefined for undefined", () => {
		expect(getRetryAfterMsFromHeaders(undefined)).toBeUndefined();
	});
	it("returns undefined for null", () => {
		expect(getRetryAfterMsFromHeaders(null)).toBeUndefined();
	});
	it("returns undefined for empty record", () => {
		expect(getRetryAfterMsFromHeaders({})).toBeUndefined();
	});
	it("parses retry-after-ms header", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "5000" })).toBe(5000);
	});
	it("parses retry-after-ms with decimal", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "500.7" })).toBe(501);
	});
	it("returns undefined for negative retry-after-ms", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "-1" })).toBeUndefined();
	});
	it("parses retry-after header as seconds", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "5" })).toBe(5000);
	});
	it("parses retry-after header as HTTP date", () => {
		const future = new Date(Date.now() + 5000).toUTCString();
		const result = getRetryAfterMsFromHeaders({ "retry-after": future });
		expect(result).not.toBeUndefined();
		expect(result!).toBeGreaterThan(0);
	});
	it("returns undefined for invalid retry-after", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "invalid" })).toBeUndefined();
	});
	it("parses x-ratelimit-reset-ms header", () => {
		expect(getRetryAfterMsFromHeaders({ "x-ratelimit-reset-ms": "3000" })).toBeGreaterThanOrEqual(0);
	});
	it("parses x-ratelimit-reset header (seconds)", () => {
		const result = getRetryAfterMsFromHeaders({ "x-ratelimit-reset": "3" });
		expect(result).not.toBeUndefined();
	});
	it("returns the max of multiple candidates", () => {
		const result = getRetryAfterMsFromHeaders({
			"retry-after-ms": "1000",
			"retry-after": "10",
		});
		expect(result).toBe(10000);
	});
	it("works with Headers instance", () => {
		const headers = new Headers({ "retry-after-ms": "2000" });
		expect(getRetryAfterMsFromHeaders(headers)).toBe(2000);
	});
});

describe("formatErrorMessageWithRetryAfter", () => {
	it("returns message as-is when no retry-after info", () => {
		const err = new Error("something went wrong");
		expect(formatErrorMessageWithRetryAfter(err)).toBe("something went wrong");
	});
	it("appends retry-after-ms hint when header present", () => {
		const err = new Error("rate limited");
		const result = formatErrorMessageWithRetryAfter(err, { "retry-after-ms": "5000" });
		expect(result).toContain("retry-after-ms=5000");
	});
	it("does not duplicate hint when already present", () => {
		const err = new Error("rate limited retry-after-ms=3000");
		const result = formatErrorMessageWithRetryAfter(err, { "retry-after-ms": "5000" });
		expect(result).toBe("rate limited retry-after-ms=3000");
	});
	it("handles non-Error values", () => {
		expect(formatErrorMessageWithRetryAfter("string error")).toBe('"string error"');
		expect(formatErrorMessageWithRetryAfter(42)).toBe("42");
	});
	it("handles null", () => {
		expect(formatErrorMessageWithRetryAfter(null)).toBe("null");
	});
	it("handles undefined", () => {
		expect(formatErrorMessageWithRetryAfter(undefined)).toBe("undefined");
	});
});

describe("getHeadersFromError", () => {
	it("returns undefined for non-object", () => {
		expect(getHeadersFromError("string")).toBeUndefined();
		expect(getHeadersFromError(42)).toBeUndefined();
		expect(getHeadersFromError(null)).toBeUndefined();
		expect(getHeadersFromError(undefined)).toBeUndefined();
	});
	it("returns headers from error with headers property", () => {
		const err = { headers: { "retry-after-ms": "1000" } };
		const result = getHeadersFromError(err);
		expect(result).toEqual({ "retry-after-ms": "1000" });
	});
	it("returns undefined for error without headers", () => {
		expect(getHeadersFromError(new Error("no headers"))).toBeUndefined();
	});
	it("traverses cause chain", () => {
		const inner = { headers: { "retry-after-ms": "2000" } };
		const outer = new Error("outer");
		outer.cause = inner;
		const result = getHeadersFromError(outer);
		expect(result).toEqual({ "retry-after-ms": "2000" });
	});
	it("handles circular references", () => {
		const err: { headers?: unknown; cause?: unknown } = {};
		err.cause = err;
		expect(getHeadersFromError(err)).toBeUndefined();
	});
});
