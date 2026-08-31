import { describe, expect, it } from "bun:test";
import { getEnvApiKey, getEnvApiKeyName, listProvidersWithEnvKey } from "../src/env-api-key";

describe("getEnvApiKeyName", () => {
	it("returns string resolver for known string-keyed provider", () => {
		// brave is a string resolver: "BRAVE_API_KEY"
		expect(getEnvApiKeyName("brave")).toBe("BRAVE_API_KEY");
	});
	it("returns undefined for function resolver", () => {
		// anthropic is a function resolver
		expect(getEnvApiKeyName("anthropic")).toBeUndefined();
	});
	it("returns undefined for unknown provider", () => {
		expect(getEnvApiKeyName("nonexistent-provider")).toBeUndefined();
	});
});

describe("getEnvApiKey", () => {
	it("returns undefined for unknown provider", () => {
		expect(getEnvApiKey("nonexistent-provider")).toBeUndefined();
	});
	it("returns undefined when env var is not set for string resolver", () => {
		// BRAVE_API_KEY is not set in test env
		const result = getEnvApiKey("brave");
		// Could be undefined if BRAVE_API_KEY is not set
		expect(result).toBeUndefined();
	});
});

describe("listProvidersWithEnvKey", () => {
	it("returns non-empty array", () => {
		const providers = listProvidersWithEnvKey();
		expect(providers.length).toBeGreaterThan(0);
	});
	it("includes anthropic", () => {
		expect(listProvidersWithEnvKey()).toContain("anthropic");
	});
	it("includes brave", () => {
		expect(listProvidersWithEnvKey()).toContain("brave");
	});
	it("includes perplexity", () => {
		expect(listProvidersWithEnvKey()).toContain("perplexity");
	});
});
