import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, getCatalogProviderEntry } from "@veyyon/catalog/provider-models/descriptors";
import {
	COMMAND_CODE_STATIC_MODELS,
	commandCodeModelManagerOptions,
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
describe("Command Code provider", () => {
	test("descriptor resolves COMMAND_CODE_API_KEY and defaults to Kimi K2.7 Code", () => {
		const entry = getCatalogProviderEntry("command-code");
		expect(entry).toBeDefined();
		expect(entry?.envVars).toEqual(["COMMAND_CODE_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER["command-code"]).toBe("moonshotai/Kimi-K2.7-Code");
	});

	test("static seed bundles the documented coding flagships against the official endpoint", () => {
		expect(COMMAND_CODE_STATIC_MODELS.map(model => model.id)).toEqual([
			"moonshotai/Kimi-K2.7-Code",
			"zai-org/GLM-5.3",
			"MiniMaxAI/MiniMax-M3",
		]);
		for (const model of COMMAND_CODE_STATIC_MODELS) {
			expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
			expect(model.provider).toBe("command-code");
			expect(model.contextWindow).toBeGreaterThan(0);
		}
	});

	test("discovery calls the official Provider API with the bearer key", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(input), authorization: headers.get("authorization") });
			return new Response(JSON.stringify({ data: [{ id: "moonshotai/Kimi-K2.7-Code" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = commandCodeModelManagerOptions({ apiKey: "cmd-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.commandcode.ai/provider/v1/models",
				authorization: "Bearer cmd-test-key",
			},
		]);
		expect(models?.[0]).toMatchObject({
			id: "moonshotai/Kimi-K2.7-Code",
			provider: "command-code",
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
