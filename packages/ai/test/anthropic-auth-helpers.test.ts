import { describe, expect, it } from "bun:test";
import {
	type AnthropicAuthConfig,
	buildAnthropicAuthConfig,
	buildAnthropicUrl,
	isOAuthToken,
} from "../src/utils/anthropic-auth";

describe("isOAuthToken", () => {
	it("returns true for sk-ant-oat token", () => {
		expect(isOAuthToken("sk-ant-oat-abc123")).toBe(true);
	});

	it("returns true for token containing sk-ant-oat", () => {
		expect(isOAuthToken("prefix-sk-ant-oat-suffix")).toBe(true);
	});

	it("returns false for regular API key", () => {
		expect(isOAuthToken("sk-ant-api03-abc123")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isOAuthToken("")).toBe(false);
	});

	it("returns false for non-anthropic key", () => {
		expect(isOAuthToken("sk-openai-abc123")).toBe(false);
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("returns config with apiKey and isOAuth", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-test");
		expect(config.apiKey).toBe("sk-ant-oat-test");
		expect(config.isOAuth).toBe(true);
	});

	it("returns config with isOAuth false for regular key", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test");
		expect(config.isOAuth).toBe(false);
	});

	it("uses provided baseUrl when valid", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "https://custom.example.com");
		expect(config.baseUrl).toContain("custom.example.com");
	});

	it("falls back to default endpoint when no baseUrl provided", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test");
		expect(config.baseUrl).toBeTruthy();
		expect(config.baseUrl).toMatch(/^https:\/\//);
	});

	it("falls back to default endpoint when baseUrl is empty", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-test", "");
		expect(config.baseUrl).toBeTruthy();
	});
});

describe("buildAnthropicUrl", () => {
	it("builds URL with /v1/messages and beta=true", () => {
		const auth: AnthropicAuthConfig = {
			apiKey: "test-key",
			baseUrl: "https://api.anthropic.com",
			isOAuth: false,
		};
		const url = buildAnthropicUrl(auth);
		expect(url).toContain("/v1/messages");
		expect(url).toContain("beta=true");
	});

	it("preserves custom base URL", () => {
		const auth: AnthropicAuthConfig = {
			apiKey: "test-key",
			baseUrl: "https://custom.example.com",
			isOAuth: false,
		};
		const url = buildAnthropicUrl(auth);
		expect(url).toContain("custom.example.com");
		expect(url).toContain("/v1/messages");
	});

	it("always includes beta=true query parameter", () => {
		const auth: AnthropicAuthConfig = {
			apiKey: "test-key",
			baseUrl: "https://api.anthropic.com",
			isOAuth: true,
		};
		const url = buildAnthropicUrl(auth);
		expect(url.endsWith("?beta=true")).toBe(true);
	});
});
