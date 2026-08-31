import { describe, expect, it } from "bun:test";
import { type ResponseRetryPolicy, retryResponse } from "../src/error/response";

function makeResponse(status: number, headers?: Record<string, string>): Response {
	return new Response(null, { status, headers: new Headers(headers) });
}

describe("retryResponse", () => {
	it("returns true when x-should-retry header is 'true'", () => {
		const res = makeResponse(500, { "x-should-retry": "true" });
		expect(retryResponse(res, undefined)).toBe(true);
	});
	it("returns false when x-should-retry header is 'false'", () => {
		const res = makeResponse(500, { "x-should-retry": "false" });
		expect(retryResponse(res, undefined)).toBe(false);
	});
	it("returns false for 401 without header", () => {
		const res = makeResponse(401);
		expect(retryResponse(res, undefined)).toBe(false);
	});
	it("returns false for 403 without header", () => {
		const res = makeResponse(403);
		expect(retryResponse(res, undefined)).toBe(false);
	});
	it("returns false for 429 without header (classified as rate-limit, not auto-retry)", () => {
		const res = makeResponse(429);
		expect(retryResponse(res, undefined)).toBe(false);
	});
	it("returns true for 500 without header", () => {
		const res = makeResponse(500);
		expect(retryResponse(res, undefined)).toBe(true);
	});
	it("returns true for 502 without header", () => {
		const res = makeResponse(502);
		expect(retryResponse(res, undefined)).toBe(true);
	});
	it("returns true for 503 without header", () => {
		const res = makeResponse(503);
		expect(retryResponse(res, undefined)).toBe(true);
	});
	it("returns false for 400 without header", () => {
		const res = makeResponse(400);
		expect(retryResponse(res, undefined)).toBe(false);
	});
	it("returns false for 404 without header", () => {
		const res = makeResponse(404);
		expect(retryResponse(res, undefined)).toBe(false);
	});
	it("respects neverRetry list", () => {
		const res = makeResponse(500);
		const policy: ResponseRetryPolicy = { neverRetry: [500] };
		expect(retryResponse(res, undefined, policy)).toBe(false);
	});
	it("respects alsoRetry list", () => {
		const res = makeResponse(418);
		const policy: ResponseRetryPolicy = { alsoRetry: [418] };
		expect(retryResponse(res, undefined, policy)).toBe(true);
	});
	it("neverRetry overrides alsoRetry", () => {
		const res = makeResponse(500);
		const policy: ResponseRetryPolicy = { neverRetry: [500], alsoRetry: [500] };
		expect(retryResponse(res, undefined, policy)).toBe(false);
	});
	it("refusesReplay returns false when body matches", () => {
		const res = makeResponse(500);
		const policy: ResponseRetryPolicy = { refusesReplay: b => b.includes("no replay") };
		expect(retryResponse(res, "error: no replay allowed", policy)).toBe(false);
	});
	it("refusesReplay does not trigger when body does not match", () => {
		const res = makeResponse(500);
		const policy: ResponseRetryPolicy = { refusesReplay: b => b.includes("no replay") };
		expect(retryResponse(res, "regular error", policy)).toBe(true);
	});
	it("header 'true' overrides neverRetry", () => {
		const res = makeResponse(500, { "x-should-retry": "true" });
		const policy: ResponseRetryPolicy = { neverRetry: [500] };
		expect(retryResponse(res, undefined, policy)).toBe(true);
	});
	it("header 'false' overrides alsoRetry", () => {
		const res = makeResponse(500, { "x-should-retry": "false" });
		const policy: ResponseRetryPolicy = { alsoRetry: [500] };
		expect(retryResponse(res, undefined, policy)).toBe(false);
	});
});
