import { describe, expect, it } from "bun:test";
import { parseDevinRateLimitResetMs, readConnectTrailerError } from "../src/providers/devin-helpers";

describe("readConnectTrailerError", () => {
	it("returns null for empty text", () => {
		expect(readConnectTrailerError("")).toBeNull();
	});

	it("returns null for non-JSON text", () => {
		expect(readConnectTrailerError("not json")).toBeNull();
	});

	it("returns null for JSON without error field", () => {
		expect(readConnectTrailerError('{"foo":"bar"}')).toBeNull();
	});

	it("returns null for JSON with error that is not an object", () => {
		expect(readConnectTrailerError('{"error":"string"}')).toBeNull();
	});

	it("returns null for error object with no code or message", () => {
		expect(readConnectTrailerError('{"error":{}}')).toBeNull();
	});

	it("parses error with code and message", () => {
		const result = readConnectTrailerError('{"error":{"code":"rate_limited","message":"Too many requests"}}');
		expect(result).not.toBeNull();
		expect(result?.code).toBe("rate_limited");
		expect(result?.message).toBe("Too many requests");
		expect(result?.text).toContain("rate_limited");
		expect(result?.text).toContain("Too many requests");
	});

	it("parses error with only code", () => {
		const result = readConnectTrailerError('{"error":{"code":"ECONNREFUSED"}}');
		expect(result).not.toBeNull();
		expect(result?.code).toBe("ECONNREFUSED");
		expect(result?.message).toBe("");
		expect(result?.text).toContain("ECONNREFUSED");
	});

	it("parses error with only message", () => {
		const result = readConnectTrailerError('{"error":{"message":"something went wrong"}}');
		expect(result).not.toBeNull();
		expect(result?.code).toBe("");
		expect(result?.message).toBe("something went wrong");
		expect(result?.text).toContain("something went wrong");
	});

	it("ignores non-string code and message", () => {
		const result = readConnectTrailerError('{"error":{"code":123,"message":456}}');
		expect(result).toBeNull();
	});

	it("handles error with extra fields", () => {
		const result = readConnectTrailerError('{"error":{"code":"E500","message":"fail","extra":"ignored"}}');
		expect(result?.code).toBe("E500");
		expect(result?.message).toBe("fail");
	});
});

describe("parseDevinRateLimitResetMs", () => {
	it("parses 'reset in 30 seconds'", () => {
		expect(parseDevinRateLimitResetMs("reset in 30 seconds")).toBe(30_000);
	});

	it("parses 'resets in 5 minutes'", () => {
		expect(parseDevinRateLimitResetMs("resets in 5 minutes")).toBe(300_000);
	});

	it("parses 'reset after 1 hour'", () => {
		expect(parseDevinRateLimitResetMs("reset after 1 hour")).toBe(3_600_000);
	});

	it("parses 'reset in about 10 seconds'", () => {
		expect(parseDevinRateLimitResetMs("reset in about 10 seconds")).toBe(10_000);
	});

	it("parses 'reset in approximately 3 minutes'", () => {
		expect(parseDevinRateLimitResetMs("reset in approximately 3 minutes")).toBe(180_000);
	});

	it("parses 'reset in ~5 seconds'", () => {
		expect(parseDevinRateLimitResetMs("reset in ~5 seconds")).toBe(5_000);
	});

	it("parses 'resets in 1 second' (singular)", () => {
		expect(parseDevinRateLimitResetMs("resets in 1 second")).toBe(1_000);
	});

	it("is case-insensitive", () => {
		expect(parseDevinRateLimitResetMs("RESET IN 30 SECONDS")).toBe(30_000);
	});

	it("returns undefined for no reset message", () => {
		expect(parseDevinRateLimitResetMs("something went wrong")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseDevinRateLimitResetMs("")).toBeUndefined();
	});

	it("returns undefined for reset without time", () => {
		expect(parseDevinRateLimitResetMs("reset soon")).toBeUndefined();
	});

	it("returns undefined for invalid number", () => {
		expect(parseDevinRateLimitResetMs("reset in abc seconds")).toBeUndefined();
	});

	it("returns undefined for negative amount", () => {
		// regex captures digits only, so negative won't match
		expect(parseDevinRateLimitResetMs("reset in -5 seconds")).toBeUndefined();
	});

	it("handles 'reset' without 's'", () => {
		expect(parseDevinRateLimitResetMs("reset in 10 minute")).toBe(600_000);
	});

	it("handles 'reset' with 's'", () => {
		expect(parseDevinRateLimitResetMs("resets in 10 minutes")).toBe(600_000);
	});
});
