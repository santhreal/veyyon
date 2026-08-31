import { describe, expect, it } from "bun:test";
import * as AIError from "../src/error";
import { type ApiKeyLoginConfig, createApiKeyLogin } from "../src/registry/api-key-login";

const testConfig: ApiKeyLoginConfig = {
	providerLabel: "TestProvider",
	authUrl: "https://example.com/keys",
	instructions: "Get your key here",
	promptMessage: "Paste your key",
	placeholder: "sk-...",
	validation: null,
};

function makeCallbacks(
	overrides: Partial<{ onPrompt: () => Promise<string>; onAuth: (info: unknown) => void; signal: AbortSignal }> = {},
) {
	return {
		onPrompt: overrides.onPrompt ?? (async () => "sk_test_key"),
		onAuth: overrides.onAuth ?? (() => {}),
		signal: overrides.signal,
	} as Parameters<ReturnType<typeof createApiKeyLogin>>[0];
}

describe("createApiKeyLogin", () => {
	it("returns a function", () => {
		expect(typeof createApiKeyLogin(testConfig)).toBe("function");
	});
	it("throws OnPromptRequiredError when onPrompt is missing", async () => {
		const login = createApiKeyLogin(testConfig);
		await expect(login({} as Parameters<typeof login>[0])).rejects.toBeInstanceOf(AIError.OnPromptRequiredError);
	});
	it("returns trimmed api key", async () => {
		const login = createApiKeyLogin(testConfig);
		const callbacks = makeCallbacks({ onPrompt: async () => "  sk_key  " });
		const result = await login(callbacks);
		expect(result).toBe("sk_key");
	});
	it("throws ApiKeyRequiredError for empty key", async () => {
		const login = createApiKeyLogin(testConfig);
		const callbacks = makeCallbacks({ onPrompt: async () => "   " });
		await expect(login(callbacks)).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
	});
	it("throws LoginCancelledError when signal is aborted", async () => {
		const login = createApiKeyLogin(testConfig);
		const controller = new AbortController();
		controller.abort();
		const callbacks = makeCallbacks({ signal: controller.signal });
		await expect(login(callbacks)).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});
	it("calls onAuth with url and instructions", async () => {
		let authInfo: { url?: string; instructions?: string } | undefined;
		const login = createApiKeyLogin(testConfig);
		const callbacks = makeCallbacks({
			onAuth: (info: { url: string; instructions: string }) => {
				authInfo = info;
			},
		});
		await login(callbacks);
		expect(authInfo?.url).toBe("https://example.com/keys");
		expect(authInfo?.instructions).toBe("Get your key here");
	});
	it("calls onPrompt with message and placeholder", async () => {
		let promptInfo: { message?: string; placeholder?: string } | undefined;
		const login = createApiKeyLogin(testConfig);
		const callbacks = makeCallbacks({
			onPrompt: async (info: { message: string; placeholder: string }) => {
				promptInfo = info;
				return "sk_key";
			},
		});
		await login(callbacks);
		expect(promptInfo?.message).toBe("Paste your key");
		expect(promptInfo?.placeholder).toBe("sk-...");
	});
	it("returns key without validation when validation is null", async () => {
		const login = createApiKeyLogin({ ...testConfig, validation: null });
		const callbacks = makeCallbacks();
		const result = await login(callbacks);
		expect(result).toBe("sk_test_key");
	});
});

describe("nousResearchApiKeyProvider", () => {
	it("has correct id", async () => {
		const { nousResearchApiKeyProvider } = await import("../src/registry/nous-research-api-key");
		expect(nousResearchApiKeyProvider.id).toBe("nous-research-api-key");
	});
	it("has correct name", async () => {
		const { nousResearchApiKeyProvider } = await import("../src/registry/nous-research-api-key");
		expect(nousResearchApiKeyProvider.name).toContain("Nous Research");
	});
	it("has storeCredentialsAs", async () => {
		const { nousResearchApiKeyProvider } = await import("../src/registry/nous-research-api-key");
		expect(nousResearchApiKeyProvider.storeCredentialsAs).toBe("nous-research");
	});
	it("has a login function", async () => {
		const { nousResearchApiKeyProvider } = await import("../src/registry/nous-research-api-key");
		expect(typeof nousResearchApiKeyProvider.login).toBe("function");
	});
});
