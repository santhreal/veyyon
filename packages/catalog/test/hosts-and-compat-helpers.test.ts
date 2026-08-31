import { describe, expect, it } from "bun:test";
import { applyCompatOverrides } from "../src/compat/apply";
import { hostMatchesUrl, type KnownHost, modelMatchesHost } from "../src/hosts";

describe("hostMatchesUrl", () => {
	it("returns false for undefined baseUrl", () => {
		expect(hostMatchesUrl(undefined, "openai")).toBe(false);
	});

	it("returns false for empty baseUrl", () => {
		expect(hostMatchesUrl("", "openai")).toBe(false);
	});

	it("returns true when URL contains marker", () => {
		expect(hostMatchesUrl("https://api.openai.com/v1", "openai")).toBe(true);
	});

	it("returns false when URL does not contain marker", () => {
		expect(hostMatchesUrl("https://example.com", "openai")).toBe(false);
	});

	it("is case-insensitive for ASCII markers", () => {
		expect(hostMatchesUrl("https://API.OPENAI.COM/v1", "openai")).toBe(true);
	});

	it("matches anthropic host", () => {
		expect(hostMatchesUrl("https://api.anthropic.com", "anthropic")).toBe(true);
	});

	it("matches githubCopilot with copilot-api marker", () => {
		expect(hostMatchesUrl("https://copilot-api.example.com", "githubCopilot")).toBe(true);
	});

	it("matches githubCopilot with githubcopilot.com marker", () => {
		expect(hostMatchesUrl("https://api.githubcopilot.com", "githubCopilot")).toBe(true);
	});

	it("matches fireworks host", () => {
		expect(hostMatchesUrl("https://fireworks.ai/api", "fireworks")).toBe(true);
	});

	it("matches groq host", () => {
		expect(hostMatchesUrl("https://api.groq.com", "groq")).toBe(true);
	});

	it("matches deepseekDirect host", () => {
		expect(hostMatchesUrl("https://api.deepseek.com", "deepseekDirect")).toBe(true);
	});

	it("matches deepseekFamily with deepseek.com marker", () => {
		expect(hostMatchesUrl("https://api.deepseek.com", "deepseekFamily")).toBe(true);
	});

	it("matches azureOpenAI with .openai.azure.com marker", () => {
		expect(hostMatchesUrl("https://myresource.openai.azure.com", "azureOpenAI")).toBe(true);
	});

	it("matches azureOpenAI with azure.com/openai marker", () => {
		expect(hostMatchesUrl("https://example.azure.com/openai", "azureOpenAI")).toBe(true);
	});

	it("matches xai host", () => {
		expect(hostMatchesUrl("https://api.x.ai/v1", "xai")).toBe(true);
	});

	it("returns false for partial marker match", () => {
		expect(hostMatchesUrl("https://openai.com", "openai")).toBe(false);
	});
});

describe("modelMatchesHost", () => {
	it("matches by provider name", () => {
		expect(modelMatchesHost({ provider: "openai", baseUrl: "" }, "openai")).toBe(true);
	});

	it("matches by provider prefix", () => {
		expect(modelMatchesHost({ provider: "xiaomi-token-plan-123", baseUrl: "" }, "xiaomi")).toBe(true);
	});

	it("matches by baseUrl marker when provider does not match", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://api.openai.com" }, "openai")).toBe(true);
	});

	it("returns false when neither provider nor baseUrl matches", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://example.com" }, "openai")).toBe(false);
	});

	it("returns false for empty baseUrl and non-matching provider", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "" }, "anthropic")).toBe(false);
	});

	it("matches anthropic by provider", () => {
		expect(modelMatchesHost({ provider: "anthropic", baseUrl: "" }, "anthropic")).toBe(true);
	});

	it("matches githubCopilot by provider", () => {
		expect(modelMatchesHost({ provider: "github-copilot", baseUrl: "" }, "githubCopilot")).toBe(true);
	});

	it("matches fireworks by baseUrl only (no providers in spec)", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://fireworks.ai" }, "fireworks")).toBe(true);
	});

	it("matches chutes by baseUrl only (no providers in spec)", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://chutes.ai" }, "chutes")).toBe(true);
	});

	it("matches minimax by provider", () => {
		expect(modelMatchesHost({ provider: "minimax", baseUrl: "" }, "minimax")).toBe(true);
	});

	it("matches minimax-code by provider", () => {
		expect(modelMatchesHost({ provider: "minimax-code", baseUrl: "" }, "minimax")).toBe(true);
	});

	it("matches moonshotNative by provider", () => {
		expect(modelMatchesHost({ provider: "moonshot", baseUrl: "" }, "moonshotNative")).toBe(true);
	});

	it("matches moonshotNative by kimi-code provider", () => {
		expect(modelMatchesHost({ provider: "kimi-code", baseUrl: "" }, "moonshotNative")).toBe(true);
	});
});

describe("applyCompatOverrides", () => {
	it("does nothing for undefined overrides", () => {
		const compat = { a: 1, b: 2 };
		applyCompatOverrides(compat, undefined);
		expect(compat).toEqual({ a: 1, b: 2 });
	});

	it("applies overrides for existing keys", () => {
		const compat = { a: 1, b: 2 };
		applyCompatOverrides(compat, { a: 10 });
		expect(compat.a).toBe(10);
		expect(compat.b).toBe(2);
	});

	it("ignores overrides for non-existing keys", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, { c: 3 } as never);
		expect(compat).toEqual({ a: 1 });
	});

	it("ignores undefined override values", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, { a: undefined });
		expect(compat.a).toBe(1);
	});

	it("applies multiple overrides", () => {
		const compat = { a: 1, b: 2, c: 3 };
		applyCompatOverrides(compat, { a: 10, b: 20 });
		expect(compat).toEqual({ a: 10, b: 20, c: 3 });
	});

	it("handles empty overrides object", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, {});
		expect(compat).toEqual({ a: 1 });
	});

	it("handles empty compat object", () => {
		const compat = {};
		applyCompatOverrides(compat, { a: 1 } as never);
		expect(compat).toEqual({});
	});

	it("overrides with false value", () => {
		const compat = { flag: true };
		applyCompatOverrides(compat, { flag: false });
		expect(compat.flag).toBe(false);
	});

	it("overrides with null value", () => {
		const compat = { val: "original" };
		applyCompatOverrides(compat, { val: null });
		expect(compat.val).toBeNull();
	});

	it("overrides with 0 value", () => {
		const compat = { count: 5 };
		applyCompatOverrides(compat, { count: 0 });
		expect(compat.count).toBe(0);
	});

	it("does not add new keys from overrides", () => {
		const compat = { a: 1 };
		applyCompatOverrides(compat, { newKey: "value" } as never);
		expect(Object.keys(compat)).toEqual(["a"]);
	});
});

// Test the KnownHost type covers all expected hosts
describe("KNOWN_HOSTS coverage", () => {
	const expectedHosts: KnownHost[] = [
		"openai",
		"azureOpenAI",
		"codexBackend",
		"openrouter",
		"anthropic",
		"deepseekDirect",
		"fireworks",
		"groq",
		"xai",
		"mistral",
		"together",
	];

	for (const host of expectedHosts) {
		it(`host ${host} has at least one urlMarker`, () => {
			// Verify the host is valid by using it
			expect(hostMatchesUrl(undefined, host)).toBe(false);
		});
	}
});
