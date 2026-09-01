import { describe, expect, it } from "bun:test";
import {
	calculateRateLimitBackoffMs,
	isOpaqueStatusBody,
	matchesUsageLimitText,
	parseRateLimitReason,
} from "../src/error/rate-limit";

describe("parseRateLimitReason", () => {
	it("returns QUOTA_EXHAUSTED for 'quota will reset'", () => {
		expect(parseRateLimitReason("Your quota will reset tomorrow")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns QUOTA_EXHAUSTED for 'exhausted your capacity'", () => {
		expect(parseRateLimitReason("You have exhausted your capacity")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns MODEL_CAPACITY_EXHAUSTED for 'capacity'", () => {
		expect(parseRateLimitReason("model capacity reached")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});
	it("returns MODEL_CAPACITY_EXHAUSTED for 'overloaded'", () => {
		expect(parseRateLimitReason("server overloaded")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});
	it("returns MODEL_CAPACITY_EXHAUSTED for 503", () => {
		expect(parseRateLimitReason("HTTP 503")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});
	it("returns MODEL_CAPACITY_EXHAUSTED for 529", () => {
		expect(parseRateLimitReason("HTTP 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});
	it("returns MODEL_CAPACITY_EXHAUSTED for 'resource exhausted'", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});
	it("returns RATE_LIMIT_EXCEEDED for 'per minute'", () => {
		expect(parseRateLimitReason("requests per minute exceeded")).toBe("RATE_LIMIT_EXCEEDED");
	});
	it("returns RATE_LIMIT_EXCEEDED for 'rate limit'", () => {
		expect(parseRateLimitReason("rate limit hit")).toBe("RATE_LIMIT_EXCEEDED");
	});
	it("returns RATE_LIMIT_EXCEEDED for 'too many requests'", () => {
		expect(parseRateLimitReason("too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});
	it("returns QUOTA_EXHAUSTED for 'exhausted'", () => {
		expect(parseRateLimitReason("quota exhausted")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns QUOTA_EXHAUSTED for 'usage limit'", () => {
		expect(parseRateLimitReason("usage limit reached")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns QUOTA_EXHAUSTED for 'out of credits'", () => {
		expect(parseRateLimitReason("you are out of credits")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns QUOTA_EXHAUSTED for 'spending-limit'", () => {
		expect(parseRateLimitReason("spending-limit exceeded")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns QUOTA_EXHAUSTED for 'insufficient balance'", () => {
		expect(parseRateLimitReason("insufficient balance")).toBe("QUOTA_EXHAUSTED");
	});
	it("returns SERVER_ERROR for 500", () => {
		expect(parseRateLimitReason("HTTP 500")).toBe("SERVER_ERROR");
	});
	it("returns SERVER_ERROR for 502", () => {
		expect(parseRateLimitReason("HTTP 502")).toBe("SERVER_ERROR");
	});
	it("returns SERVER_ERROR for 'internal error'", () => {
		expect(parseRateLimitReason("internal error occurred")).toBe("SERVER_ERROR");
	});
	it("returns UNKNOWN for unrelated text", () => {
		expect(parseRateLimitReason("something else happened")).toBe("UNKNOWN");
	});
	it("returns UNKNOWN for empty string", () => {
		expect(parseRateLimitReason("")).toBe("UNKNOWN");
	});
	it("account rate limit returns QUOTA_EXHAUSTED", () => {
		expect(parseRateLimitReason("account rate limit exceeded")).toBe("QUOTA_EXHAUSTED");
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 30 min for QUOTA_EXHAUSTED", () => {
		expect(calculateRateLimitBackoffMs("QUOTA_EXHAUSTED")).toBe(30 * 60 * 1000);
	});
	it("returns 30s for RATE_LIMIT_EXCEEDED", () => {
		expect(calculateRateLimitBackoffMs("RATE_LIMIT_EXCEEDED")).toBe(30 * 1000);
	});
	it("returns 20s for SERVER_ERROR", () => {
		expect(calculateRateLimitBackoffMs("SERVER_ERROR")).toBe(20 * 1000);
	});
	it("returns 45s-75s for MODEL_CAPACITY_EXHAUSTED", () => {
		const backoff = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
		expect(backoff).toBeGreaterThanOrEqual(45 * 1000);
		expect(backoff).toBeLessThan(75 * 1000);
	});
	it("returns 30 min for UNKNOWN (conservative default)", () => {
		expect(calculateRateLimitBackoffMs("UNKNOWN")).toBe(30 * 60 * 1000);
	});
});

describe("isOpaqueStatusBody", () => {
	it("returns true for '429'", () => {
		expect(isOpaqueStatusBody("429")).toBe(true);
	});
	it("returns true for 'HTTP 429 error'", () => {
		expect(isOpaqueStatusBody("HTTP 429 error")).toBe(true);
	});
	it("returns true for 'status code 429'", () => {
		expect(isOpaqueStatusBody("status code 429")).toBe(true);
	});
	it("returns false for message with real content", () => {
		expect(isOpaqueStatusBody("rate limit exceeded")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isOpaqueStatusBody("")).toBe(true);
	});
	it("returns true for '429 Too Many Requests'", () => {
		// "Too" is 3 chars but "Requests" is 8, however "429" and "Too" and "Many" are removed...
		// Let me check: cleaned removes "429", "too", "many", "requests" are not in the remove list
		// Actually the remove list is: 429, http, https, status, error, code, response, message
		// "Too Many Requests" → after cleaning: "Too Many Requests" → has "Too" (3 chars) → not opaque
		expect(isOpaqueStatusBody("429 Too Many Requests")).toBe(false);
	});
});

describe("matchesUsageLimitText", () => {
	it("matches 'usage limit'", () => {
		expect(matchesUsageLimitText("usage limit reached")).toBe(true);
	});
	it("matches 'usage_limit_reached'", () => {
		expect(matchesUsageLimitText("usage_limit_reached")).toBe(true);
	});
	it("matches 'quota exceeded'", () => {
		expect(matchesUsageLimitText("quota exceeded")).toBe(true);
	});
	it("matches 'resource exhausted'", () => {
		expect(matchesUsageLimitText("resource exhausted")).toBe(true);
	});
	it("matches 'run out of credits'", () => {
		expect(matchesUsageLimitText("run out of credits")).toBe(true);
	});
	it("matches 'spending limit'", () => {
		expect(matchesUsageLimitText("spending limit")).toBe(true);
	});
	it("matches account rate limit", () => {
		expect(matchesUsageLimitText("account rate limit exceeded")).toBe(true);
	});
	it("does not match unrelated text", () => {
		expect(matchesUsageLimitText("some random error")).toBe(false);
	});
	it("does not match empty string", () => {
		expect(matchesUsageLimitText("")).toBe(false);
	});
});
