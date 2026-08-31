import { describe, expect, it } from "bun:test";
import { ANTHROPIC_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
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
		expect(isOAuthToken("openai-key-123")).toBe(false);
	});
});

describe("buildAnthropicAuthConfig", () => {
	it("returns config with provided apiKey and baseUrl", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-xyz", "https://custom.example.com");
		expect(config.apiKey).toBe("sk-ant-api03-xyz");
		expect(config.baseUrl).toBe("https://custom.example.com");
		expect(config.isOAuth).toBe(false);
	});
	it("falls back to default endpoint when baseUrl is undefined", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-xyz");
		expect(config.baseUrl).toBe(ANTHROPIC_API_ENDPOINT);
	});
	it("falls back to default endpoint when baseUrl is empty", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-xyz", "");
		expect(config.baseUrl).toBe(ANTHROPIC_API_ENDPOINT);
	});
	it("detects OAuth token", () => {
		const config = buildAnthropicAuthConfig("sk-ant-oat-xyz");
		expect(config.isOAuth).toBe(true);
	});
	it("detects non-OAuth token", () => {
		const config = buildAnthropicAuthConfig("sk-ant-api03-xyz");
		expect(config.isOAuth).toBe(false);
	});
});

describe("buildAnthropicUrl", () => {
	it("builds URL with beta=true query param", () => {
		const auth: AnthropicAuthConfig = {
			apiKey: "sk-ant-api03-xyz",
			baseUrl: "https://api.anthropic.com",
			isOAuth: false,
		};
		const url = buildAnthropicUrl(auth);
		expect(url).toContain("/v1/messages");
		expect(url).toContain("beta=true");
	});
	it("handles custom base URL", () => {
		const auth: AnthropicAuthConfig = {
			apiKey: "sk-ant-api03-xyz",
			baseUrl: "https://custom.example.com",
			isOAuth: false,
		};
		const url = buildAnthropicUrl(auth);
		expect(url).toContain("https://custom.example.com");
		expect(url).toContain("/v1/messages");
	});
});
