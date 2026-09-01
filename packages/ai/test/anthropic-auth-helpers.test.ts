import { describe, expect, it } from "bun:test";
import { buildAnthropicAuthConfig, buildAnthropicUrl, isOAuthToken } from "../src/utils/anthropic-auth";

describe("isOAuthToken", () => {
	it("returns true for token containing 'sk-ant-oat'", () => {
		expect(isOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});
	it("returns false for regular API key", () => {
		expect(isOAuthToken("sk-ant-api03-abc123")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isOAuthToken("")).toBe(false);
	});
	it("returns false for unrelated string", () => {
		expect(isOAuthToken("some-other-token")).toBe(false);
	});
	it("returns true for token with 'sk-ant-oat' in middle", () => {
		expect(isOAuthToken("prefix-sk-ant-oat-suffix")).toBe(true);
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("returns config with apiKey and baseUrl", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://api.anthropic.com");
		expect(config.apiKey).toBe("sk-ant-api03-test");
		expect(config.baseUrl).toBe("https://api.anthropic.com");
		expect(config.isOAuth).toBe(false);
	});
	it("detects OAuth token", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-test", "https://api.anthropic.com");
		expect(config.isOAuth).toBe(true);
	});
	it("uses default endpoint when no baseUrl provided", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test");
		expect(config.baseUrl).toContain("anthropic.com");
	});
	it("normalizes baseUrl by stripping trailing slash", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://api.anthropic.com/");
		expect(config.baseUrl).toBe("https://api.anthropic.com");
	});
	it("preserves /v1 in baseUrl (normalizeBaseUrl only strips trailing slashes)", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://api.anthropic.com/v1");
		expect(config.baseUrl).toBe("https://api.anthropic.com/v1");
	});
});

describe("buildAnthropicUrl", () => {
	it("builds messages URL with beta=true query", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://api.anthropic.com");
		const url = buildAnthropicUrl(config);
		expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
	});
	it("handles baseUrl with trailing slash", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://api.anthropic.com/");
		const url = buildAnthropicUrl(config);
		expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
	});
	it("handles custom baseUrl", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://custom.example.com");
		const url = buildAnthropicUrl(config);
		expect(url).toBe("https://custom.example.com/v1/messages?beta=true");
	});
});
