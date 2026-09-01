import { describe, expect, it } from "bun:test";
import { AUTH_EVIDENCE_LOCAL, isAuthRetryableError } from "../src/error/auth-classify";

describe("AUTH_EVIDENCE_LOCAL", () => {
	it("is 'authEvidenceIsLocal'", () => {
		expect(AUTH_EVIDENCE_LOCAL).toBe("authEvidenceIsLocal");
	});
});

describe("isAuthRetryableError", () => {
	it("returns false for non-Error non-string", () => {
		expect(isAuthRetryableError(42)).toBe(false);
		expect(isAuthRetryableError(null)).toBe(false);
		expect(isAuthRetryableError(undefined)).toBe(false);
	});
	it("returns false for local evidence", () => {
		const err = { [AUTH_EVIDENCE_LOCAL]: true, message: "some error" };
		expect(isAuthRetryableError(err)).toBe(false);
	});
	it("returns false for local evidence Error", () => {
		const err = new Error("some error");
		(err as { [x: string]: unknown })[AUTH_EVIDENCE_LOCAL] = true;
		expect(isAuthRetryableError(err)).toBe(false);
	});
	it("returns true for 401 status", () => {
		const err = new Error("unauthorized");
		(err as { status?: number }).status = 401;
		expect(isAuthRetryableError(err)).toBe(true);
	});
	it("returns false for 403 status", () => {
		const err = new Error("forbidden");
		(err as { status?: number }).status = 403;
		expect(isAuthRetryableError(err)).toBe(false);
	});
	it("returns true for usage limit error", () => {
		const err = new Error("usage limit reached");
		expect(isAuthRetryableError(err)).toBe(true);
	});
	it("returns true for 'usage limit' in message", () => {
		expect(isAuthRetryableError("usage limit exceeded")).toBe(true);
	});
	it("returns true for 'quota exceeded' in message", () => {
		expect(isAuthRetryableError("quota exceeded")).toBe(true);
	});
	it("returns false for unrelated error", () => {
		expect(isAuthRetryableError(new Error("something else"))).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isAuthRetryableError("")).toBe(false);
	});
	it("returns false for non-401 status", () => {
		const err = new Error("not found");
		(err as { status?: number }).status = 404;
		expect(isAuthRetryableError(err)).toBe(false);
	});
});
