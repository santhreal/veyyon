import { describe, expect, it } from "bun:test";
import {
	AUTH_SCHEMA_VERSION,
	isRefreshFailureDisableCause,
	isSqliteBusyError,
	normalizeDisabledCause,
	normalizeStoredAccountId,
	normalizeStoredEmail,
	OAUTH_REFRESH_FAILURE_DISABLE_PREFIX,
	USAGE_HISTORY_BUCKET_MS,
	USAGE_REPORT_TTL_MS,
} from "../src/auth-credential-rows";

describe("AUTH_SCHEMA_VERSION", () => {
	it("is 6", () => {
		expect(AUTH_SCHEMA_VERSION).toBe(6);
	});
});

describe("USAGE_REPORT_TTL_MS", () => {
	it("is 5 minutes", () => {
		expect(USAGE_REPORT_TTL_MS).toBe(5 * 60_000);
	});
});

describe("USAGE_HISTORY_BUCKET_MS", () => {
	it("is 1 hour", () => {
		expect(USAGE_HISTORY_BUCKET_MS).toBe(60 * 60_000);
	});
});

describe("OAUTH_REFRESH_FAILURE_DISABLE_PREFIX", () => {
	it("is 'oauth refresh failed'", () => {
		expect(OAUTH_REFRESH_FAILURE_DISABLE_PREFIX).toBe("oauth refresh failed");
	});
});

describe("isSqliteBusyError", () => {
	it("returns true for SQLITE_BUSY error code", () => {
		expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(true);
	});
	it("returns true for SQLITE_BUSY_SNAPSHOT error code", () => {
		expect(isSqliteBusyError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
	});
	it("returns false for other error codes", () => {
		expect(isSqliteBusyError({ code: "SQLITE_LOCKED" })).toBe(false);
	});
	it("returns false for non-string code", () => {
		expect(isSqliteBusyError({ code: 42 })).toBe(false);
	});
	it("returns false for null", () => {
		expect(isSqliteBusyError(null)).toBe(false);
	});
	it("returns false for non-object", () => {
		expect(isSqliteBusyError("string")).toBe(false);
	});
	it("returns false for object without code", () => {
		expect(isSqliteBusyError({})).toBe(false);
	});
});

describe("normalizeStoredAccountId", () => {
	it("returns trimmed account id", () => {
		expect(normalizeStoredAccountId("  abc123  ")).toBe("abc123");
	});
	it("returns null for undefined", () => {
		expect(normalizeStoredAccountId(undefined)).toBeNull();
	});
	it("returns null for null", () => {
		expect(normalizeStoredAccountId(null)).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(normalizeStoredAccountId("")).toBeNull();
	});
	it("returns null for whitespace-only string", () => {
		expect(normalizeStoredAccountId("   ")).toBeNull();
	});
});

describe("normalizeStoredEmail", () => {
	it("returns trimmed lowercase email", () => {
		expect(normalizeStoredEmail("  User@Example.COM  ")).toBe("user@example.com");
	});
	it("returns null for undefined", () => {
		expect(normalizeStoredEmail(undefined)).toBeNull();
	});
	it("returns null for null", () => {
		expect(normalizeStoredEmail(null)).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(normalizeStoredEmail("")).toBeNull();
	});
	it("returns null for whitespace-only string", () => {
		expect(normalizeStoredEmail("   ")).toBeNull();
	});
});

describe("normalizeDisabledCause", () => {
	it("returns trimmed cause", () => {
		expect(normalizeDisabledCause("  some reason  ")).toBe("some reason");
	});
	it("returns 'disabled' for empty string", () => {
		expect(normalizeDisabledCause("")).toBe("disabled");
	});
	it("returns 'disabled' for whitespace-only string", () => {
		expect(normalizeDisabledCause("   ")).toBe("disabled");
	});
});

describe("isRefreshFailureDisableCause", () => {
	it("returns true for null", () => {
		expect(isRefreshFailureDisableCause(null)).toBe(true);
	});
	it("returns true for undefined", () => {
		expect(isRefreshFailureDisableCause(undefined)).toBe(true);
	});
	it("returns true for cause starting with prefix", () => {
		expect(isRefreshFailureDisableCause("oauth refresh failed: token expired")).toBe(true);
	});
	it("returns true for exact prefix", () => {
		expect(isRefreshFailureDisableCause("oauth refresh failed")).toBe(true);
	});
	it("returns false for unrelated cause", () => {
		expect(isRefreshFailureDisableCause("manual disable")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isRefreshFailureDisableCause("")).toBe(false);
	});
});
