import { describe, expect, it } from "bun:test";
import { isProviderRetryableError, isTransientStatus } from "../src/error/retryable";

describe("isTransientStatus", () => {
	it("returns true for 429", () => {
		expect(isTransientStatus(429)).toBe(true);
	});
	it("returns true for 500", () => {
		expect(isTransientStatus(500)).toBe(true);
	});
	it("returns true for 502", () => {
		expect(isTransientStatus(502)).toBe(true);
	});
	it("returns true for 503", () => {
		expect(isTransientStatus(503)).toBe(true);
	});
	it("returns true for 504", () => {
		expect(isTransientStatus(504)).toBe(true);
	});
	it("returns false for 400", () => {
		expect(isTransientStatus(400)).toBe(false);
	});
	it("returns false for 401", () => {
		expect(isTransientStatus(401)).toBe(false);
	});
	it("returns false for 404", () => {
		expect(isTransientStatus(404)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isTransientStatus(undefined)).toBe(false);
	});
});

describe("isProviderRetryableError", () => {
	it("returns false for non-Error", () => {
		expect(isProviderRetryableError("string")).toBe(false);
		expect(isProviderRetryableError(42)).toBe(false);
		expect(isProviderRetryableError(null)).toBe(false);
		expect(isProviderRetryableError(undefined)).toBe(false);
	});
	it("returns false for 401 error", () => {
		const err = new Error("unauthorized");
		(err as { status?: number }).status = 401;
		expect(isProviderRetryableError(err)).toBe(false);
	});
	it("returns false for 404 error", () => {
		const err = new Error("not found");
		(err as { status?: number }).status = 404;
		expect(isProviderRetryableError(err)).toBe(false);
	});
	it("returns true for 500 error", () => {
		const err = new Error("internal server error");
		(err as { status?: number }).status = 500;
		expect(isProviderRetryableError(err)).toBe(true);
	});
	it("returns true for 503 error", () => {
		const err = new Error("service unavailable");
		(err as { status?: number }).status = 503;
		expect(isProviderRetryableError(err)).toBe(true);
	});
	it("returns true for 429 error", () => {
		const err = new Error("rate limited");
		(err as { status?: number }).status = 429;
		expect(isProviderRetryableError(err)).toBe(true);
	});
	it("returns true when provider transient hook returns true", () => {
		const err = new Error("custom transient");
		expect(isProviderRetryableError(err, { isProviderTransient: () => true })).toBe(true);
	});
	it("returns false when provider transient hook returns false and no status", () => {
		const err = new Error("custom non-transient");
		expect(isProviderRetryableError(err, { isProviderTransient: () => false })).toBe(false);
	});
});
