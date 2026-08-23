import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, getCatalogProviderEntry } from "@veyyon/catalog/provider-models/descriptors";
import {
	cohereModelManagerOptions,
	NOUS_RESEARCH_STATIC_MODELS,
	nousResearchModelManagerOptions,
} from "@veyyon/catalog/provider-models/openai-compat";
import type { FetchImpl } from "@veyyon/catalog/types";

/**
 * The two new providers must resolve credentials through their documented env
 * names, ship a default model that exists in the bundle, and point discovery
 * at the official OpenAI-compatible endpoints (asserted through the URL the
 * dynamic fetch calls, not through source text).
 */
describe("Cohere provider", () => {
	test("descriptor carries both official env spellings and the Command default", () => {
		const entry = getCatalogProviderEntry("cohere");
		expect(entry).toBeDefined();
		expect(entry?.envVars).toEqual(["COHERE_API_KEY", "CO_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.cohere).toBe("command-a-plus-05-2026");
	});

	test("discovery calls the official compatibility endpoint with the bearer key", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(input), authorization: headers.get("authorization") });
			return new Response(JSON.stringify({ data: [{ id: "command-a-03-2025" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = cohereModelManagerOptions({ apiKey: "cohere-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.cohere.ai/compatibility/v1/models",
				authorization: "Bearer cohere-test-key",
			},
		]);
		expect(models?.[0]).toMatchObject({
			id: "command-a-03-2025",
			provider: "cohere",
			api: "openai-completions",
		});
	});
});

describe("Nous Research provider", () => {
	test("descriptor resolves NOUS_API_KEY and defaults to Hermes 4 405B", () => {
		const entry = getCatalogProviderEntry("nous-research");
		expect(entry).toBeDefined();
		expect(entry?.envVars).toEqual(["NOUS_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER["nous-research"]).toBe("nousresearch/hermes-4-405b");
	});

	test("static seed bundles the Hermes family against the official endpoint", () => {
		expect(NOUS_RESEARCH_STATIC_MODELS.map(model => model.id)).toEqual([
			"nousresearch/hermes-4-70b",
			"nousresearch/hermes-4-405b",
		]);
		for (const model of NOUS_RESEARCH_STATIC_MODELS) {
			expect(model.baseUrl).toBe("https://inference-api.nousresearch.com/v1");
			expect(model.provider).toBe("nous-research");
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(model.maxTokens).toBeGreaterThan(0);
		}
	});

	test("discovery calls the official inference endpoint with the bearer key", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(input), authorization: headers.get("authorization") });
			return new Response(JSON.stringify({ data: [{ id: "nousresearch/hermes-4-70b" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = nousResearchModelManagerOptions({ apiKey: "nous-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://inference-api.nousresearch.com/v1/models",
				authorization: "Bearer nous-test-key",
			},
		]);
		expect(models?.[0]).toMatchObject({
			id: "nousresearch/hermes-4-70b",
			provider: "nous-research",
			api: "openai-completions",
		});
	});
});
