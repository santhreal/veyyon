import { describe, expect, it } from "bun:test";
import {
	MAX_PROVIDER_ERROR_BODY_BYTES,
	PROVIDER_SECRET_FAMILIES,
	type ProviderErrorBody,
	providerErrorMessage,
	redactProviderSecrets,
} from "../src/error/error-body";

describe("MAX_PROVIDER_ERROR_BODY_BYTES", () => {
	it("is 64KB", () => {
		expect(MAX_PROVIDER_ERROR_BODY_BYTES).toBe(64 * 1024);
	});
});

describe("PROVIDER_SECRET_FAMILIES", () => {
	it("is non-empty", () => {
		expect(PROVIDER_SECRET_FAMILIES.length).toBeGreaterThan(0);
	});
	it("every family has a redact function", () => {
		for (const family of PROVIDER_SECRET_FAMILIES) {
			expect(typeof family.redact).toBe("function");
		}
	});
});

describe("redactProviderSecrets", () => {
	it("redacts bearer tokens", () => {
		const result = redactProviderSecrets("Authorization: Bearer sk-ant-api03-abc123def456ghi789");
		expect(result).not.toContain("sk-ant-api03-abc123def456ghi789");
	});
	it("redacts sk-ant prefixed keys", () => {
		const result = redactProviderSecrets("key: sk-ant-api03-someverylongkey1234567890");
		expect(result).not.toContain("sk-ant-api03-someverylongkey1234567890");
	});
	it("redacts sk- prefixed keys", () => {
		const result = redactProviderSecrets("key: sk-someverylongkey123456789012345");
		expect(result).not.toContain("sk-someverylongkey123456789012345");
	});
	it("redacts GitHub tokens", () => {
		const result = redactProviderSecrets("token: ghp_1234567890abcdef1234567890");
		expect(result).not.toContain("ghp_1234567890abcdef1234567890");
	});
	it("redacts Google API keys (AIza prefix)", () => {
		const result = redactProviderSecrets("key: AIzaSyA1234567890abcdefghijklmnopqrst");
		expect(result).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrst");
	});
	it("redacts JWT tokens", () => {
		const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		const result = redactProviderSecrets(`token: ${jwt}`);
		expect(result).not.toContain(jwt);
	});
	it("redacts authorization header values", () => {
		const result = redactProviderSecrets("authorization: mysecrettoken123");
		expect(result).not.toContain("mysecrettoken123");
	});
	it("redacts bearer tokens in bearer prefix", () => {
		const result = redactProviderSecrets("bearer mysecrettoken123abc");
		expect(result).not.toContain("mysecrettoken123abc");
	});
	it("redacts cookie headers", () => {
		const result = redactProviderSecrets("Cookie: session=secretcookievalue123");
		expect(result).not.toContain("secretcookievalue123");
	});
	it("does not modify text without secrets", () => {
		const text = "some error message without secrets";
		expect(redactProviderSecrets(text)).toBe(text);
	});
	it("handles empty string", () => {
		expect(redactProviderSecrets("")).toBe("");
	});
});

describe("providerErrorMessage", () => {
	it("returns detail for non-JSON text", () => {
		const body: ProviderErrorBody = { text: "plain error", detail: "plain error", bytesRead: 11, truncated: false, declaredBytes: undefined };
		expect(providerErrorMessage(body)).toBe("plain error");
	});
	it("extracts message from JSON with error.message", () => {
		const body: ProviderErrorBody = {
			text: JSON.stringify({ error: { message: "something failed" } }),
			detail: "raw detail",
			bytesRead: 40,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("something failed");
	});
	it("extracts message from JSON with error as string", () => {
		const body: ProviderErrorBody = {
			text: JSON.stringify({ error: "string error" }),
			detail: "raw detail",
			bytesRead: 25,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("string error");
	});
	it("extracts message from JSON with top-level message", () => {
		const body: ProviderErrorBody = {
			text: JSON.stringify({ message: "top level message" }),
			detail: "raw detail",
			bytesRead: 30,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("top level message");
	});
	it("extracts detail from JSON with top-level detail", () => {
		const body: ProviderErrorBody = {
			text: JSON.stringify({ detail: "detail field" }),
			detail: "raw detail",
			bytesRead: 25,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("detail field");
	});
	it("returns detail for invalid JSON", () => {
		const body: ProviderErrorBody = {
			text: "{invalid json",
			detail: "raw detail",
			bytesRead: 13,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("raw detail");
	});
	it("returns detail when no message field found", () => {
		const body: ProviderErrorBody = {
			text: JSON.stringify({ unrelated: "field" }),
			detail: "raw detail",
			bytesRead: 25,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("raw detail");
	});
	it("returns detail for JSON array", () => {
		const body: ProviderErrorBody = {
			text: JSON.stringify([1, 2, 3]),
			detail: "raw detail",
			bytesRead: 9,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("raw detail");
	});
	it("returns detail for empty text", () => {
		const body: ProviderErrorBody = {
			text: "",
			detail: "raw detail",
			bytesRead: 0,
			truncated: false,
			declaredBytes: undefined,
		};
		expect(providerErrorMessage(body)).toBe("raw detail");
	});
});
