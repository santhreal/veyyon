import { describe, expect, it } from "bun:test";
import { deterministicUuid } from "../src/utils/deterministic-id";
import { formatErrorMessageWithRetryAfter, getRetryAfterMsFromHeaders } from "../src/utils/retry-after";

describe("deterministicUuid", () => {
	it("returns a UUID-shaped string", () => {
		const uuid = deterministicUuid("test-seed");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
	it("is deterministic for same seed", () => {
		expect(deterministicUuid("seed-1")).toBe(deterministicUuid("seed-1"));
	});
	it("is different for different seeds", () => {
		expect(deterministicUuid("seed-1")).not.toBe(deterministicUuid("seed-2"));
	});
	it("handles empty seed", () => {
		const uuid = deterministicUuid("");
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
	it("handles long seed", () => {
		const uuid = deterministicUuid("a".repeat(1000));
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

describe("getRetryAfterMsFromHeaders", () => {
	it("returns undefined for undefined headers", () => {
		expect(getRetryAfterMsFromHeaders(undefined)).toBeUndefined();
	});
	it("returns undefined for null headers", () => {
		expect(getRetryAfterMsFromHeaders(null)).toBeUndefined();
	});
	it("reads retry-after-ms header from record", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "5000" })).toBe(5000);
	});
	it("reads retry-after header as seconds", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "5" })).toBe(5000);
	});
	it("reads retry-after header as HTTP date", () => {
		const future = new Date(Date.now() + 10_000).toUTCString();
		const result = getRetryAfterMsFromHeaders({ "retry-after": future });
		expect(result).not.toBeUndefined();
		expect(result ?? 0).toBeGreaterThan(5000);
	});
	it("reads x-ratelimit-reset-ms header", () => {
		expect(getRetryAfterMsFromHeaders({ "x-ratelimit-reset-ms": "3000" })).toBe(3000);
	});
	it("reads x-ratelimit-reset header as seconds", () => {
		expect(getRetryAfterMsFromHeaders({ "x-ratelimit-reset": "3" })).toBe(3000);
	});
	it("returns undefined when no relevant headers", () => {
		expect(getRetryAfterMsFromHeaders({ "content-type": "application/json" })).toBeUndefined();
	});
	it("handles Headers instance", () => {
		const headers = new Headers({ "retry-after-ms": "2000" });
		expect(getRetryAfterMsFromHeaders(headers)).toBe(2000);
	});
	it("returns the maximum when multiple headers present", () => {
		const result = getRetryAfterMsFromHeaders({
			"retry-after-ms": "1000",
			"retry-after": "5",
		});
		expect(result).toBe(5000);
	});
	it("returns undefined for negative retry-after-ms", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "-1" })).toBeUndefined();
	});
	it("returns undefined for non-numeric retry-after-ms", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "abc" })).toBeUndefined();
	});
	it("is case insensitive for header names", () => {
		expect(getRetryAfterMsFromHeaders({ "Retry-After-Ms": "1000" })).toBe(1000);
	});
});

describe("formatErrorMessageWithRetryAfter", () => {
	it("returns error message for Error instance", () => {
		const error = new Error("test error");
		expect(formatErrorMessageWithRetryAfter(error)).toBe("test error");
	});
	it("appends retry-after-ms hint when headers present", () => {
		const error = new Error("rate limited");
		const result = formatErrorMessageWithRetryAfter(error, { "retry-after-ms": "5000" });
		expect(result).toContain("retry-after-ms=5000");
	});
	it("does not append hint when no headers", () => {
		const error = new Error("test error");
		expect(formatErrorMessageWithRetryAfter(error)).toBe("test error");
	});
	it("does not duplicate hint when already present", () => {
		const error = new Error("error retry-after-ms=1000");
		const result = formatErrorMessageWithRetryAfter(error, { "retry-after-ms": "2000" });
		expect(result).toBe("error retry-after-ms=1000");
	});
	it("handles non-Error values", () => {
		const result = formatErrorMessageWithRetryAfter("string error");
		expect(result).toContain("string error");
	});
	it("handles object errors", () => {
		const result = formatErrorMessageWithRetryAfter({ code: 500 });
		expect(result).toContain("500");
	});
});
