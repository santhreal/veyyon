import { describe, expect, test } from "bun:test";
import { getBundledModel } from "@veyyon/catalog/models";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	getCatalogProviderEntry,
	PROVIDERS_PUBLISHING_OWN_MODEL_LIMITS,
} from "@veyyon/catalog/provider-models/descriptors";
import {
	COMMAND_CODE_STATIC_MODELS,
	commandCodeModelManagerOptions,
	NOUS_RESEARCH_BUNDLED_MODELS,
	NOUS_RESEARCH_STATIC_MODELS,
	nousResearchModelManagerOptions,
} from "@veyyon/catalog/provider-models/openai-compat";
import type { Api, FetchImpl, ModelSpec } from "@veyyon/catalog/types";
import { applyCanonicalLimitFallback, applyGeneratedModelPolicies } from "../scripts/generated-policies";

/**
 * These providers expose model routers, so catalog discovery must preserve the
 * endpoint's capability metadata rather than inheriting same-family defaults
 * from another host. Which providers get that treatment is one derived set, so
 * a generation pass cannot honor it for one member and miss another, and a new
 * member turns the pin below red until someone records it. The gap this suite
 * does not cover is live upstream drift.
 */
describe("providers that own their model limits", () => {
	test("the opt-out set is derived from the catalog table, not restated per pass", () => {
		expect([...PROVIDERS_PUBLISHING_OWN_MODEL_LIMITS].sort()).toEqual(["command-code", "nous-research"]);
		expect(getCatalogProviderEntry("command-code")?.publishesOwnModelLimits).toBe(true);
		expect(getCatalogProviderEntry("nous-research")?.publishesOwnModelLimits).toBe(true);
	});

	test("a flagged provider keeps a null output cap through both generation passes", () => {
		const nousModel: ModelSpec<Api> = { ...NOUS_RESEARCH_STATIC_MODELS[0]!, contextWindow: null };
		const sameFamilyReference: ModelSpec<Api> = {
			...NOUS_RESEARCH_STATIC_MODELS[0]!,
			provider: "anthropic",
			id: "claude-sonnet-4.6",
			contextWindow: 200000,
			maxTokens: 64000,
		};
		applyCanonicalLimitFallback([sameFamilyReference, nousModel]);
		expect(nousModel.contextWindow).toBeNull();
		expect(nousModel.maxTokens).toBeNull();
	});
});

describe("Command Code provider", () => {
	test("prefers CMD_API_KEY and retains the Veyyon alias", () => {
		const entry = getCatalogProviderEntry("command-code");
		expect(entry).toBeDefined();
		expect(entry?.envVars).toEqual(["CMD_API_KEY", "COMMAND_CODE_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER["command-code"]).toBe("moonshotai/Kimi-K2.7-Code");
	});

	test("static coding flagships use the exact published contexts and unknown output caps", () => {
		expect(
			COMMAND_CODE_STATIC_MODELS.map(model => ({
				id: model.id,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		).toEqual([
			{ id: "moonshotai/Kimi-K2.7-Code", contextWindow: 256000, maxTokens: null },
			{ id: "zai-org/GLM-5.3", contextWindow: 1000000, maxTokens: null },
			{ id: "MiniMaxAI/MiniMax-M3", contextWindow: 1000000, maxTokens: null },
		]);
		for (const model of COMMAND_CODE_STATIC_MODELS) {
			expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
			expect(model.provider).toBe("command-code");
			const bundled = getBundledModel("command-code", model.id);
			expect(bundled?.contextWindow).toBe(model.contextWindow);
			expect(bundled?.maxTokens).toBeNull();
			expect(bundled?.reasoning).toBe(model.reasoning);
			expect(bundled?.input).toEqual(model.input);
		}
	});

	test("discovery maps context_length while leaving output caps unknown", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(input), authorization: headers.get("authorization") });
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "moonshotai/Kimi-K2.7-Code",
							name: "Kimi K2.7 Code",
							context_length: 256000,
							max_completion_tokens: 32768,
						},
						{ id: "router/new-model", name: "New Model", context_length: 765432 },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = commandCodeModelManagerOptions({ apiKey: "cmd-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.commandcode.ai/provider/v1/models",
				authorization: "Bearer cmd-test-key",
			},
		]);
		expect(
			models?.map(model => ({ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
		).toEqual([
			{ id: "moonshotai/Kimi-K2.7-Code", contextWindow: 256000, maxTokens: null },
			{ id: "router/new-model", contextWindow: 765432, maxTokens: null },
		]);
	});

	test("generated enrichment cannot invent an output cap", () => {
		const commandModel: ModelSpec<Api> = {
			...COMMAND_CODE_STATIC_MODELS[0]!,
			maxTokens: 32768,
		};
		applyGeneratedModelPolicies([commandModel]);
		expect(commandModel.maxTokens).toBeNull();

		const canonicalReference: ModelSpec<Api> = {
			...COMMAND_CODE_STATIC_MODELS[0]!,
			provider: "moonshot",
			maxTokens: 32768,
		};
		applyCanonicalLimitFallback([canonicalReference, commandModel]);
		expect(commandModel.contextWindow).toBe(256000);
		expect(commandModel.maxTokens).toBeNull();
	});
});

describe("Nous Research provider", () => {
	test("uses OAuth discovery with an explicit NOUS_API_KEY fallback and a tool-capable default", () => {
		const entry = getCatalogProviderEntry("nous-research");
		expect(entry).toBeDefined();
		expect(entry?.envVars).toEqual(["NOUS_API_KEY"]);
		expect(entry?.catalogDiscovery?.oauthProvider).toBe("nous-research");
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["nous-research"]).toBe("anthropic/claude-sonnet-4.6");
		expect(getBundledModel("nous-research", "anthropic/claude-sonnet-4.6")).toBeDefined();
		const staticDefault = NOUS_RESEARCH_STATIC_MODELS.find(model => model.id === "anthropic/claude-sonnet-4.6");
		expect(staticDefault).toMatchObject({
			input: ["text"],
			supportsTools: true,
			cost: { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 },
			contextWindow: 1000000,
			maxTokens: null,
			compat: { supportsToolChoice: false },
		});
		expect(NOUS_RESEARCH_BUNDLED_MODELS.map(model => model.id)).toEqual(["anthropic/claude-sonnet-4.6"]);
	});

	test("maps rich tool-capable chat rows and excludes non-tool and non-chat products", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url: String(input), authorization: headers.get("authorization") });
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "anthropic/claude-sonnet-4.6",
							name: "Anthropic: Claude Sonnet 4.6",
							context_length: 250000,
							architecture: {
								modality: "text+image+file->text",
								input_modalities: ["text", "image", "file"],
								output_modalities: ["text"],
							},
							pricing: {
								prompt: "0.00000125",
								completion: "0.0000065",
								input_cache_read: "0.000000125",
								input_cache_write: "0.000001625",
							},
							top_provider: { context_length: 999999, max_completion_tokens: 64000 },
							supported_parameters: ["tools", "tool_choice", "reasoning", "reasoning_effort"],
							reasoning: { supported_efforts: ["high", "future", "low"] },
						},
						{
							id: "nous/tool-text",
							name: "Tool Text",
							context_length: 131072,
							architecture: { modality: "text->text" },
							pricing: { prompt: "0", completion: "0" },
							top_provider: { max_completion_tokens: null },
							supported_parameters: ["tools"],
						},
						{
							id: "nous/tool-metadata-sparse",
							name: "Tool Metadata Sparse",
							architecture: {},
							top_provider: { context_length: 32000 },
							supported_parameters: ["tools"],
						},
						{
							id: "nous/no-tools",
							architecture: { modality: "text->text", output_modalities: ["text"] },
							supported_parameters: ["reasoning"],
						},
						{
							id: "voyage/code-embedding",
							architecture: { modality: "text->embeddings", output_modalities: ["embeddings"] },
							supported_parameters: ["tools"],
						},
						{
							id: "image/generator",
							architecture: { modality: "text->image", output_modalities: ["image"] },
							supported_parameters: ["tools"],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = nousResearchModelManagerOptions({ apiKey: "oauth-access-token", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://inference-api.nousresearch.com/v1/models",
				authorization: "Bearer oauth-access-token",
			},
		]);
		expect(models?.map(model => model.id)).toEqual([
			"anthropic/claude-sonnet-4.6",
			"nous/tool-metadata-sparse",
			"nous/tool-text",
		]);
		expect(models?.[0]).toMatchObject({
			reasoning: true,
			reasoningOptions: { efforts: ["low", "high"] },
			input: ["text", "image"],
			supportsTools: true,
			cost: { input: 1.25, output: 6.5, cacheRead: 0.125, cacheWrite: 1.625 },
			pricing: "published",
			contextWindow: 999999,
			maxTokens: 64000,
			compat: { supportsToolChoice: true },
		});
		expect(models?.[1]).toMatchObject({
			reasoning: false,
			input: ["text"],
			supportsTools: true,
			pricing: "unknown",
			contextWindow: 32000,
			maxTokens: null,
			compat: { supportsToolChoice: false },
		});
		expect(models?.[2]).toMatchObject({
			reasoning: false,
			input: ["text"],
			supportsTools: true,
			pricing: "published",
			contextWindow: 131072,
			maxTokens: null,
			compat: { supportsToolChoice: false },
		});
	});
});
