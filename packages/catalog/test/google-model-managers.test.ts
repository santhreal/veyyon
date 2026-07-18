import { afterEach, describe, expect, it } from "bun:test";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	googleModelManagerOptions,
	googleVertexModelManagerOptions,
} from "../src/provider-models/google";

// The Google-family builders gate dynamic discovery on a credential and adapt
// the caller's `fetch` into a discovery-shaped fetcher. Lock the gating, the
// oauth-token wiring, and the no-custom-fetch fallback to the global fetch.

const ANTIGRAVITY_MODELS_PATH = "/v1internal:fetchAvailableModels";

describe("googleModelManagerOptions", () => {
	it("returns a bare provider config with no fetcher when unauthenticated", () => {
		const options = googleModelManagerOptions();
		expect(options.providerId).toBe("google");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("wires a fetcher once an api key is present", () => {
		const options = googleModelManagerOptions({ apiKey: "gkey" });
		expect(typeof options.fetchDynamicModels).toBe("function");
	});
});

describe("googleVertexModelManagerOptions", () => {
	it("is a static provider with no dynamic discovery", () => {
		const options = googleVertexModelManagerOptions();
		expect(options.providerId).toBe("google-vertex");
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});

describe("googleAntigravityModelManagerOptions", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("returns a bare provider config with no fetcher when unauthenticated", () => {
		const options = googleAntigravityModelManagerOptions();
		expect(options.providerId).toBe("google-antigravity");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("adapts the caller fetch and carries the oauth token to fetchAvailableModels", async () => {
		let sawUrl = "";
		let sawAuth = "";
		const spyFetch = ((input: string | URL | Request, init?: RequestInit) => {
			sawUrl = String(input);
			sawAuth = new Headers(init?.headers).get("Authorization") ?? "";
			return Promise.resolve(
				new Response(JSON.stringify({ models: { "gemini-x": { displayName: "Gemini X", maxTokens: 100000 } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}) as unknown as import("../src/types").FetchImpl;

		const options = googleAntigravityModelManagerOptions({
			oauthToken: "oauth-secret",
			endpoint: "https://ag.example",
			fetch: spyFetch,
		});
		expect(typeof options.fetchDynamicModels).toBe("function");

		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["gemini-x"]);
		expect(sawUrl).toBe(`https://ag.example${ANTIGRAVITY_MODELS_PATH}`);
		expect(sawAuth).toBe("Bearer oauth-secret");
	});

	it("falls back to the global fetch when no custom fetch is supplied", async () => {
		let hitGlobal = false;
		globalThis.fetch = (async () => {
			hitGlobal = true;
			return new Response("", { status: 401 });
		}) as unknown as typeof fetch;

		const options = googleAntigravityModelManagerOptions({
			oauthToken: "oauth-secret",
			endpoint: "https://ag.example",
		});
		// A 401 from every endpoint yields no catalog.
		expect(await options.fetchDynamicModels?.()).toBeNull();
		expect(hitGlobal).toBe(true);
	});
});

describe("googleGeminiCliModelManagerOptions", () => {
	it("returns a bare provider config with no fetcher when unauthenticated", () => {
		const options = googleGeminiCliModelManagerOptions();
		expect(options.providerId).toBe("google-gemini-cli");
		expect(options.fetchDynamicModels).toBeUndefined();
	});

	it("re-stamps discovered models onto the gemini-cli provider and base url", async () => {
		let sawUrl = "";
		const spyFetch = ((input: string | URL | Request, _init?: RequestInit) => {
			sawUrl = String(input);
			return Promise.resolve(
				new Response(JSON.stringify({ models: { "gemini-y": { displayName: "Gemini Y", maxTokens: 100000 } } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}) as unknown as import("../src/types").FetchImpl;

		const options = googleGeminiCliModelManagerOptions({
			oauthToken: "oauth-secret",
			endpoint: "https://gca.example",
			fetch: spyFetch,
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["gemini-y"]);
		expect(models?.every(model => model.provider === "google-gemini-cli")).toBe(true);
		expect(models?.every(model => model.baseUrl === "https://gca.example")).toBe(true);
		expect(sawUrl).toBe(`https://gca.example${ANTIGRAVITY_MODELS_PATH}`);
	});
});
