import { describe, expect, it } from "bun:test";
import {
	type ApiKeyCredential,
	authCredentialEquals,
	authFailureCause,
	compareUsageRankingMetric,
	fingerprintOAuthBearer,
	GPT_56_PAID_CODEX_MODEL_PATTERN,
	isAbortSignalOption,
	type OAuthCredential,
	type StoredCredential,
	storedCredentialArraysEqual,
	USAGE_RANKING_METRIC_EPSILON,
} from "../src/auth-storage-helpers";

function apiKey(key: string): ApiKeyCredential {
	return { type: "api_key", key };
}

function oauth(access: string, refresh = "refresh", expires?: number): OAuthCredential {
	return { type: "oauth", access, refresh, expires } as OAuthCredential;
}

describe("USAGE_RANKING_METRIC_EPSILON", () => {
	it("is 1e-9", () => {
		expect(USAGE_RANKING_METRIC_EPSILON).toBe(1e-9);
	});
});

describe("fingerprintOAuthBearer", () => {
	it("returns a base64url string", () => {
		const result = fingerprintOAuthBearer("some-bearer-token");
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});
	it("is deterministic", () => {
		expect(fingerprintOAuthBearer("token")).toBe(fingerprintOAuthBearer("token"));
	});
	it("differs for different inputs", () => {
		expect(fingerprintOAuthBearer("token1")).not.toBe(fingerprintOAuthBearer("token2"));
	});
});

describe("isAbortSignalOption", () => {
	it("returns true for AbortSignal", () => {
		expect(isAbortSignalOption(new AbortController().signal)).toBe(true);
	});
	it("returns false for undefined", () => {
		expect(isAbortSignalOption(undefined)).toBe(false);
	});
	it("returns false for null", () => {
		expect(isAbortSignalOption(null)).toBe(false);
	});
	it("returns false for plain object", () => {
		expect(isAbortSignalOption({})).toBe(false);
	});
});

describe("compareUsageRankingMetric", () => {
	it("returns 0 for equal values", () => {
		expect(compareUsageRankingMetric(1.0, 1.0)).toBe(0);
	});
	it("returns positive when left > right", () => {
		expect(compareUsageRankingMetric(2.0, 1.0)).toBeGreaterThan(0);
	});
	it("returns negative when left < right", () => {
		expect(compareUsageRankingMetric(1.0, 2.0)).toBeLessThan(0);
	});
	it("returns 0 for nearly equal values within tolerance", () => {
		expect(compareUsageRankingMetric(1.0, 1.0 + 1e-10)).toBe(0);
	});
	it("handles Infinity", () => {
		expect(compareUsageRankingMetric(Number.POSITIVE_INFINITY, 1.0)).toBeGreaterThan(0);
	});
	it("handles -Infinity", () => {
		expect(compareUsageRankingMetric(Number.NEGATIVE_INFINITY, 1.0)).toBeLessThan(0);
	});
});

describe("authFailureCause", () => {
	it("returns message for Error", () => {
		expect(authFailureCause(new Error("bad request"))).toBe("bad request");
	});
	it("returns string as-is", () => {
		expect(authFailureCause("some failure")).toBe("some failure");
	});
	it("returns default message for unknown type", () => {
		expect(authFailureCause(42)).toBe("authentication failed");
	});
	it("returns default message for null", () => {
		expect(authFailureCause(null)).toBe("authentication failed");
	});
	it("returns default message for undefined", () => {
		expect(authFailureCause(undefined)).toBe("authentication failed");
	});
});

describe("authCredentialEquals", () => {
	it("returns true for identical api_key credentials", () => {
		expect(authCredentialEquals(apiKey("key1"), apiKey("key1"))).toBe(true);
	});
	it("returns false for different api_key credentials", () => {
		expect(authCredentialEquals(apiKey("key1"), apiKey("key2"))).toBe(false);
	});
	it("returns false for different types", () => {
		expect(authCredentialEquals(apiKey("key1"), oauth("access1"))).toBe(false);
	});
	it("returns true for identical oauth credentials", () => {
		const a = oauth("access1", "refresh1", 1234);
		const b = oauth("access1", "refresh1", 1234);
		expect(authCredentialEquals(a, b)).toBe(true);
	});
	it("returns false for different access tokens", () => {
		expect(authCredentialEquals(oauth("access1"), oauth("access2"))).toBe(false);
	});
});

describe("storedCredentialArraysEqual", () => {
	it("returns true for identical arrays", () => {
		const left: StoredCredential[] = [{ id: 1, credential: apiKey("key1") }];
		const right: StoredCredential[] = [{ id: 1, credential: apiKey("key1") }];
		expect(storedCredentialArraysEqual(left, right)).toBe(true);
	});
	it("returns false for different lengths", () => {
		const left: StoredCredential[] = [{ id: 1, credential: apiKey("key1") }];
		const right: StoredCredential[] = [];
		expect(storedCredentialArraysEqual(left, right)).toBe(false);
	});
	it("returns false for different ids", () => {
		const left: StoredCredential[] = [{ id: 1, credential: apiKey("key1") }];
		const right: StoredCredential[] = [{ id: 2, credential: apiKey("key1") }];
		expect(storedCredentialArraysEqual(left, right)).toBe(false);
	});
	it("returns false for different credentials", () => {
		const left: StoredCredential[] = [{ id: 1, credential: apiKey("key1") }];
		const right: StoredCredential[] = [{ id: 1, credential: apiKey("key2") }];
		expect(storedCredentialArraysEqual(left, right)).toBe(false);
	});
	it("returns true for empty arrays", () => {
		expect(storedCredentialArraysEqual([], [])).toBe(true);
	});
});

describe("GPT_56_PAID_CODEX_MODEL_PATTERN", () => {
	it("matches gpt-5.6-sol", () => {
		expect(GPT_56_PAID_CODEX_MODEL_PATTERN.test("gpt-5.6-sol")).toBe(true);
	});
	it("matches gpt-5.6-luna", () => {
		expect(GPT_56_PAID_CODEX_MODEL_PATTERN.test("gpt-5.6-luna")).toBe(true);
	});
	it("matches gpt-5.6-sol-pro", () => {
		expect(GPT_56_PAID_CODEX_MODEL_PATTERN.test("gpt-5.6-sol-pro")).toBe(true);
	});
	it("matches gpt-5.6-luna-pro", () => {
		expect(GPT_56_PAID_CODEX_MODEL_PATTERN.test("gpt-5.6-luna-pro")).toBe(true);
	});
	it("does not match gpt-5.6-other", () => {
		expect(GPT_56_PAID_CODEX_MODEL_PATTERN.test("gpt-5.6-other")).toBe(false);
	});
	it("does not match gpt-4", () => {
		expect(GPT_56_PAID_CODEX_MODEL_PATTERN.test("gpt-4")).toBe(false);
	});
});
