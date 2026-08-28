import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { DiscoveryHooks } from "../../discovery/failure";
import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../../discovery/openai-compatible";
import type { ModelManagerOptions } from "../../model-manager";
import { getBundledModels } from "../../models";
import { OPENROUTER_API_ENDPOINT } from "../../provider-endpoints";
import type { Api, FetchImpl, Model, ModelSpec, Provider } from "../../types";
import { isRecord, toNumber, toPositiveNumber } from "../../utils";
import { coreWeaveProjectHeaders } from "../../wire/coreweave";
import {
	COPILOT_API_HEADERS,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	parseGitHubCopilotApiKey,
} from "../../wire/github-copilot";
import { basetenRouteReasoning } from "../baseten-reasoning";
import { createBundledReferenceMap, createReferenceResolver, toModelSpec } from "../bundled-references";
import {
	buildAnthropicDiscoveryHeaders,
	buildAnthropicReferenceMap,
	createOllamaMetadataResolver,
	createSimpleAnthropicProviderOptions,
	createSimpleOpenAICompletionsOptions,
	fetchModelsDevPayload,
	fetchOllamaNativeModels,
	isLikelyNanoGptTextModelId,
	mapAnthropicModelsDev,
	mapWithBundledReference,
	NANO_GPT_THINKING_SUFFIX_RE,
	normalizeOllamaBaseUrl,
	toAnthropicDiscoveryBaseUrl,
	toInputCapabilities,
	toModelName,
	toOllamaNativeBaseUrl,
	withCatalogDiscoveryTimeout,
} from "./helpers";
import {
	ANTHROPIC_BASE_URL,
	clampKimiK27CodeMaxTokens,
	createCopilotLongContextVariant,
	extractCopilotLimits,
	extractCopilotSupportsVision,
	extractCopilotTokenPrices,
	fetchLiteLLMRichModels,
	getZenMuxCacheWritePrice,
	getZenMuxPricingValue,
	inferCopilotApi,
	isCopilotChatModel,
	isNousToolCapableChatModel,
	isSakanaFuguModelId,
	isZenMuxAnthropicModel,
	mapNousResearchModel,
	NOUS_RESEARCH_BASE_URL,
	normalizeSakanaBaseUrl,
	normalizeZenMuxOpenAiBaseUrl,
	OLLAMA_DEFAULT_MAX_TOKENS,
	OLLAMA_FALLBACK_CONTEXT_WINDOW,
	SAKANA_FUGU_STATIC_MODEL_BY_ID,
	SAKANA_FUGU_STATIC_MODEL_IDS,
	SAKANA_FUGU_THINKING,
	SAKANA_RESPONSES_COMPAT,
	toZenMuxAnthropicBaseUrl,
	XIAOMI_TOKEN_PLAN_BASE_URLS,
	XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS,
	type XiaomiTokenPlanRegion,
} from "./overrides";
import type { OllamaModelManagerConfig } from "./providers-helpers";
import { loadModelsDevReferences } from "./resolvers";

export {
	type AimlApiModelManagerConfig,
	aimlApiModelManagerOptions,
	type CerebrasModelManagerConfig,
	cerebrasModelManagerOptions,
	type DeepSeekModelManagerConfig,
	deepseekModelManagerOptions,
	type FirepassModelManagerConfig,
	type FireworksModelManagerConfig,
	firepassModelManagerOptions,
	fireworksModelManagerOptions,
	type GroqModelManagerConfig,
	groqModelManagerOptions,
	type HuggingfaceModelManagerConfig,
	huggingfaceModelManagerOptions,
	type MistralModelManagerConfig,
	mistralModelManagerOptions,
	type NovitaModelManagerConfig,
	type NvidiaModelManagerConfig,
	normalizeUmansBaseUrl,
	novitaModelManagerOptions,
	nvidiaModelManagerOptions,
	type OllamaModelManagerConfig,
	type OpenAIModelManagerConfig,
	type OpenCodeModelManagerConfig,
	openaiModelManagerOptions,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
	type UmansModelManagerConfig,
	umansModelManagerOptions,
	type WaferModelManagerConfig,
	waferServerlessModelManagerOptions,
	type XaiModelManagerConfig,
	type XaiOAuthModelManagerConfig,
	xaiModelManagerOptions,
	xaiOAuthModelManagerOptions,
	type ZhipuCodingPlanModelManagerConfig,
	zhipuCodingPlanModelManagerOptions,
} from "./providers-helpers";

export function ollamaModelManagerOptions(config?: OllamaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaBaseUrl(config?.baseUrl);
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"openai-responses">("ollama" as Parameters<typeof getBundledModels>[0]);
	const resolveMetadata = createOllamaMetadataResolver(nativeBaseUrl, config?.fetch);
	return {
		providerId: "ollama",
		fetchDynamicModels: async hooks => {
			const openAiCompatible = await fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					if (!reference) {
						return {
							...defaults,
							name: toModelName(entry.name, defaults.name),
							contextWindow: OLLAMA_FALLBACK_CONTEXT_WINDOW,
							maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
						};
					}
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (openAiCompatible && openAiCompatible.length > 0) {
				await Promise.all(
					openAiCompatible.map(async model => {
						const metadata = await resolveMetadata(model.id, hooks?.onFailure);
						model.contextWindow = metadata.contextWindow;
						if (metadata.reasoning !== undefined) {
							model.reasoning = metadata.reasoning;
							model.thinking = metadata.thinking;
						}
						if (metadata.input) {
							model.input = metadata.input;
						}
					}),
				);
				return openAiCompatible;
			}
			const nativeFallback = await fetchOllamaNativeModels(
				baseUrl,
				resolveMetadata,
				config?.fetch,
				hooks?.onFailure,
			);
			if (nativeFallback && nativeFallback.length > 0) {
				return nativeFallback;
			}
			return openAiCompatible;
		},
	};
}

export interface OpenRouterModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function openrouterModelManagerOptions(
	config?: OpenRouterModelManagerConfig,
): ModelManagerOptions<"openrouter"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? OPENROUTER_API_ENDPOINT;
	const references = createBundledReferenceMap<"openrouter">("openrouter");
	return {
		providerId: "openrouter",
		cacheProviderId: "openrouter:pseudo-api",
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openrouter",
				provider: "openrouter",
				baseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const params = entry.supported_parameters;
					return Array.isArray(params) && params.includes("tools");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"openrouter">,
					_context: OpenAICompatibleModelMapperContext<"openrouter">,
				): ModelSpec<"openrouter"> => {
					const reference = references.get(defaults.id);
					const baseModel = mapWithBundledReference(entry, defaults, reference);
					const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;
					const params = Array.isArray(entry.supported_parameters) ? (entry.supported_parameters as string[]) : [];
					const modality = String((isRecord(entry.architecture) ? entry.architecture : {})?.modality ?? "");
					const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;

					const supportsToolChoice = params.includes("tool_choice");

					return {
						...baseModel,
						reasoning: params.includes("reasoning"),
						input: modality.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: toPositiveNumber(pricing?.prompt, 0) * 1_000_000,
							output: toPositiveNumber(pricing?.completion, 0) * 1_000_000,
							cacheRead: toPositiveNumber(pricing?.input_cache_read, 0) * 1_000_000,
							cacheWrite: toPositiveNumber(pricing?.input_cache_write, 0) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_length === "number" ? entry.context_length : baseModel.contextWindow,
						maxTokens:
							typeof topProvider?.max_completion_tokens === "number"
								? topProvider.max_completion_tokens
								: baseModel.maxTokens,
						...(!supportsToolChoice && {
							compat: { ...(baseModel.compat ?? {}), supportsToolChoice: false },
						}),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

export interface ZenMuxModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zenmuxModelManagerOptions(config?: ZenMuxModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const openAiBaseUrl = normalizeZenMuxOpenAiBaseUrl(config?.baseUrl);
	const anthropicBaseUrl = toZenMuxAnthropicBaseUrl(openAiBaseUrl);
	return {
		providerId: "zenmux",
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels<Api>({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "zenmux",
				baseUrl: openAiBaseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const pricings = isRecord(entry.pricings) ? entry.pricings : undefined;
					const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
					const isAnthropicModel = isZenMuxAnthropicModel(entry, defaults.id);
					return {
						...defaults,
						name: toModelName(entry.display_name, defaults.name),
						api: isAnthropicModel ? "anthropic-messages" : "openai-completions",
						baseUrl: isAnthropicModel ? anthropicBaseUrl : openAiBaseUrl,
						reasoning: capabilities?.reasoning === true || defaults.reasoning,
						input: toInputCapabilities(entry.input_modalities),
						cost: {
							input: getZenMuxPricingValue(pricings, "prompt"),
							output: getZenMuxPricingValue(pricings, "completion"),
							cacheRead: getZenMuxPricingValue(pricings, "input_cache_read"),
							cacheWrite: getZenMuxCacheWritePrice(pricings),
						},
						contextWindow: toPositiveNumber(entry.context_length, defaults.contextWindow),
						maxTokens: toPositiveNumber(entry.max_completion_tokens, defaults.maxTokens),
					};
				},
				fetch: config?.fetch,
			}),
	};
}

export interface KiloModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function kiloModelManagerOptions(config?: KiloModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kilo.ai/api/gateway";
	return {
		providerId: "kilo",
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "kilo",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
			}),
	};
}

export interface AlibabaCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function alibabaCodingPlanModelManagerOptions(
	config?: AlibabaCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
	const references = createBundledReferenceMap<"openai-completions">("alibaba-coding-plan");
	return {
		providerId: "alibaba-coding-plan",
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "alibaba-coding-plan",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			}),
	};
}

export interface VercelAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeVercelAiGatewayBaseUrls(rawBaseUrl: string | undefined): { baseUrl: string; catalogBaseUrl: string } {
	const baseUrl = trimTrailingSlashes(rawBaseUrl === undefined ? "https://ai-gateway.vercel.sh" : rawBaseUrl.trim());
	const catalogBaseUrl = baseUrl === "" || baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

	return {
		baseUrl: baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl,
		catalogBaseUrl,
	};
}

export function vercelAiGatewayModelManagerOptions(
	config?: VercelAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const { baseUrl, catalogBaseUrl } = normalizeVercelAiGatewayBaseUrls(config?.baseUrl);
	return {
		providerId: "vercel-ai-gateway",
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: catalogBaseUrl,
				apiKey,
				filterModel: (entry: OpenAICompatibleModelRecord) => {
					const tags = entry.tags;
					return Array.isArray(tags) && tags.includes("tool-use");
				},
				mapModel: (
					entry: OpenAICompatibleModelRecord,
					defaults: ModelSpec<"anthropic-messages">,
					_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
				): ModelSpec<"anthropic-messages"> => {
					const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;
					const tags = Array.isArray(entry.tags) ? (entry.tags as string[]) : [];

					return {
						...defaults,
						baseUrl,
						reasoning: tags.includes("reasoning"),
						input: tags.includes("vision") ? ["text", "image"] : ["text"],
						cost: {
							input: (toNumber(pricing?.input) ?? 0) * 1_000_000,
							output: (toNumber(pricing?.output) ?? 0) * 1_000_000,
							cacheRead: (toNumber(pricing?.input_cache_read) ?? 0) * 1_000_000,
							cacheWrite: (toNumber(pricing?.input_cache_write) ?? 0) * 1_000_000,
						},
						contextWindow:
							typeof entry.context_window === "number" ? entry.context_window : defaults.contextWindow,
						maxTokens: typeof entry.max_tokens === "number" ? entry.max_tokens : defaults.maxTokens,
					};
				},
				fetch: config?.fetch,
			}),
	};
}

export interface KimiCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function kimiCodeModelManagerOptions(
	config?: KimiCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.kimi.com/coding/v1";
	const references = createBundledReferenceMap<"openai-completions">("kimi-code");
	return {
		providerId: "kimi-code",
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "kimi-code",
					baseUrl,
					apiKey,
					headers: {
						"User-Agent": "KimiCLI/1.0",
						"X-Msh-Platform": "kimi_cli",
					},
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const model = mapWithBundledReference(entry, defaults, references.get(defaults.id));
						return {
							...model,
							name: typeof entry.display_name === "string" ? entry.display_name : model.name,
							reasoning: entry.supports_reasoning === true || model.reasoning,
							input:
								entry.supports_image_in === true || model.input.includes("image")
									? ["text", "image"]
									: ["text"],
							contextWindow:
								typeof entry.context_length === "number"
									? entry.context_length
									: (model.contextWindow ?? 262144),
							maxTokens: model.maxTokens ?? 32000,
							compat: {
								thinkingFormat: "zai",
								reasoningContentField: "reasoning_content",
								supportsDeveloperRole: false,
							},
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface LmStudioNativeModelMetadata {
	input: ("text" | "image")[];
	contextWindow?: number;
}

export interface LmStudioNativeModelMetadataOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

const LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250;

function toLmStudioNativeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const normalized = trimTrailingSlashes(trimmed);
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function getLmStudioCapabilityNames(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap(item => (typeof item === "string" ? [item.toLowerCase()] : []));
}

function getLmStudioNativeInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modelType = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
	const capabilities = getLmStudioCapabilityNames(entry.capabilities);
	const supportsImage = modelType === "vlm" || capabilities.includes("vision") || capabilities.includes("image");
	return supportsImage ? ["text", "image"] : ["text"];
}

function getLmStudioNativeContextWindow(entry: Record<string, unknown>): number | undefined {
	return (
		toPositiveNumber(entry.max_context_length, null) ??
		toPositiveNumber(entry.context_length, null) ??
		toPositiveNumber(entry.max_model_len, null) ??
		undefined
	);
}

export async function fetchLmStudioNativeModelMetadata(
	baseUrl: string,
	fetchImpl: FetchImpl = fetch,
	options?: LmStudioNativeModelMetadataOptions,
): Promise<Map<string, LmStudioNativeModelMetadata> | null> {
	const nativeBaseUrl = toLmStudioNativeBaseUrl(baseUrl);
	const fetchMetadata = async (signal?: AbortSignal): Promise<Map<string, LmStudioNativeModelMetadata> | null> => {
		try {
			const response = await fetchImpl(`${nativeBaseUrl}/api/v0/models`, {
				method: "GET",
				headers: { Accept: "application/json", ...(options?.headers ?? {}) },
				signal,
			});
			if (!response.ok) {
				return null;
			}
			const payload = await response.json();
			if (!isRecord(payload) || !Array.isArray(payload.data)) {
				return null;
			}
			const metadata = new Map<string, LmStudioNativeModelMetadata>();
			for (const entry of payload.data) {
				if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
					continue;
				}
				const contextWindow = getLmStudioNativeContextWindow(entry);
				metadata.set(entry.id, {
					input: getLmStudioNativeInput(entry),
					...(contextWindow === undefined ? {} : { contextWindow }),
				});
			}
			return metadata;
		} catch {
			return null;
		}
	};
	if (options?.signal !== undefined) {
		return fetchMetadata(options.signal);
	}
	return withCatalogDiscoveryTimeout(LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS, fetchMetadata);
}

export interface LmStudioModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function lmStudioModelManagerOptions(
	config?: LmStudioModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
	const references = new Map<string, ModelSpec<"openai-completions">>();
	return {
		providerId: "lm-studio",
		fetchDynamicModels: async hooks => {
			const nativeMetadataPromise = fetchLmStudioNativeModelMetadata(baseUrl, config?.fetch, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
			});
			const models = await fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return mapWithBundledReference(entry, defaults, reference);
				},
				fetch: config?.fetch,
			});
			if (!models) {
				return models;
			}
			const nativeMetadata = await nativeMetadataPromise;
			if (!nativeMetadata) {
				return models;
			}
			return models.map(model => {
				const metadata = nativeMetadata.get(model.id);
				if (!metadata) {
					return model;
				}
				return {
					...model,
					input: metadata.input,
					contextWindow: metadata.contextWindow ?? model.contextWindow,
				};
			});
		},
	};
}

export interface SyntheticModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function syntheticModelManagerOptions(
	config?: SyntheticModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.synthetic.new/openai/v1";
	const references = new Map(
		(getBundledModels("synthetic") as Model<"openai-completions">[]).map(model => [model.id, toModelSpec(model)]),
	);
	return {
		providerId: "synthetic",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "synthetic",
					baseUrl,
					apiKey,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const reference = references.get(defaults.id);
						const referenceSupportsImage = reference?.input.includes("image") ?? false;
						return {
							...(reference ? { ...reference, id: defaults.id, baseUrl } : defaults),
							name: toModelName(entry.name, reference?.name ?? defaults.name),
							reasoning: entry.supports_reasoning === true || (reference?.reasoning ?? false),
							input: entry.supports_vision === true || referenceSupportsImage ? ["text", "image"] : ["text"],
							contextWindow: toPositiveNumber(
								entry.context_length,
								reference?.contextWindow ?? defaults.contextWindow,
							),
							maxTokens: toPositiveNumber(entry.max_tokens, reference?.maxTokens ?? 8192),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface VeniceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function veniceModelManagerOptions(
	config?: VeniceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.venice.ai/api/v1";
	const references = createBundledReferenceMap<"openai-completions">("venice");
	return {
		providerId: "venice",
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "venice",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					const model = mapWithBundledReference(entry, defaults, reference);
					return {
						...model,
						maxTokens: clampKimiK27CodeMaxTokens(defaults.id, model.maxTokens),
						compat: { ...model.compat, supportsUsageInStreaming: false },
					};
				},
				fetch: config?.fetch,
			}),
	};
}

export interface BasetenModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function basetenModelManagerOptions(
	config?: BasetenModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://inference.baseten.co/v1";
	const references = createBundledReferenceMap<"openai-completions">("baseten");
	return {
		providerId: "baseten",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "baseten",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const raw = isRecord(entry) ? entry : {};
						const features = Array.isArray(raw.supported_features) ? raw.supported_features : [];
						const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];

						const route = basetenRouteReasoning(defaults.id);
						const reasoning = route?.reasons === true;
						const supportsTools = features.includes("tools") ? undefined : false;
						const vision = modalities.includes("image") || (reference?.input.includes("image") ?? false);

						const pricing = isRecord(raw.pricing) ? raw.pricing : {};
						const cost = {
							input: toPositiveNumber(pricing.prompt, 0) * 1_000_000,
							output: toPositiveNumber(pricing.completion, 0) * 1_000_000,
							cacheRead: toPositiveNumber(pricing.input_cache_read, 0) * 1_000_000,
							cacheWrite: 0,
						};

						const contextWindow = toPositiveNumber(
							raw.context_length,
							reference?.contextWindow ?? defaults.contextWindow,
						);
						const maxTokens = toPositiveNumber(
							raw.max_completion_tokens,
							reference?.maxTokens ?? defaults.maxTokens,
						);

						const baseModel = mapWithBundledReference(entry, defaults, reference);

						const thinking = route?.efforts && { mode: "effort" as const, efforts: route.efforts };

						return {
							...baseModel,
							reasoning,
							input: vision ? ["text", "image"] : ["text"],
							cost,
							contextWindow,
							maxTokens,
							thinking,
							...(supportsTools === false ? { supportsTools } : {}),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface TogetherModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function togetherModelManagerOptions(
	config?: TogetherModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("together", "https://api.together.xyz/v1", config);
}

export interface CoreWeaveModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function coreWeaveModelManagerOptions(
	config?: CoreWeaveModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("coreweave", "https://api.inference.wandb.ai/v1", {
		...config,
		headers: () => coreWeaveProjectHeaders(Bun.env),
	});
}

export interface CommandCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function commandCodeModelManagerOptions(
	config?: CommandCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions(
		"command-code",
		"https://api.commandcode.ai/provider/v1",
		config,
		(entry, model) => ({
			...model,
			contextWindow: toPositiveNumber(entry.context_length, model.contextWindow),
			maxTokens: null,
		}),
	);
}

export interface NousResearchModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nousResearchModelManagerOptions(
	config?: NousResearchModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? NOUS_RESEARCH_BASE_URL;
	const references = createBundledReferenceMap<"openai-completions">("nous-research");
	return {
		providerId: "nous-research",
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "nous-research",
					baseUrl,
					apiKey,
					filterModel: isNousToolCapableChatModel,
					mapModel: (entry, defaults) => mapNousResearchModel(entry, defaults, references.get(defaults.id)),
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface MoonshotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function moonshotModelManagerOptions(
	config?: MoonshotModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1";
	const references = createBundledReferenceMap<"openai-completions">("moonshot");
	return {
		providerId: "moonshot",
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "moonshot",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						return mapWithBundledReference(entry, defaults, references.get(defaults.id));
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface SakanaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function sakanaModelManagerOptions(config?: SakanaModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeSakanaBaseUrl(config?.baseUrl ?? Bun.env.SAKANA_BASE_URL ?? Bun.env.FUGU_BASE_URL);
	const references = createBundledReferenceMap<"openai-responses">("sakana");
	return {
		providerId: "sakana",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: SAKANA_FUGU_STATIC_MODEL_IDS,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-responses",
					provider: "sakana",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id) ?? SAKANA_FUGU_STATIC_MODEL_BY_ID.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						if (!reference && isSakanaFuguModelId(model.id)) {
							return {
								...model,
								reasoning: true,
								thinking: { ...SAKANA_FUGU_THINKING },
								compat: { ...SAKANA_RESPONSES_COMPAT },
							};
						}
						return model;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface QwenPortalModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qwenPortalModelManagerOptions(
	config?: QwenPortalModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qwen-portal", "https://portal.qwen.ai/v1", config);
}

export interface QianfanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function qianfanModelManagerOptions(
	config?: QianfanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("qianfan", "https://qianfan.baidubce.com/v2", config);
}

export interface CloudflareAiGatewayModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cloudflareAiGatewayModelManagerOptions(
	config?: CloudflareAiGatewayModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	return createSimpleAnthropicProviderOptions(
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
		config,
	);
}

export interface XiaomiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	providerId?: Provider;
	tokenPlanRegion?: XiaomiTokenPlanRegion;
}

export function xiaomiModelManagerOptions(
	config?: XiaomiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const providerId = config?.providerId ?? "xiaomi";
	const tokenPlanBaseUrls = config?.tokenPlanRegion
		? [XIAOMI_TOKEN_PLAN_BASE_URLS[config.tokenPlanRegion]]
		: XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS;
	const XIAOMI_STANDARD_BASE_URL = "https://api.xiaomimimo.com/v1";
	const isTokenPlanProvider = config?.tokenPlanRegion !== undefined || providerId.startsWith("xiaomi-token-plan-");
	const isTokenPlanKey = isTokenPlanProvider || apiKey?.startsWith("tp-");
	const baseUrl = isTokenPlanKey ? tokenPlanBaseUrls[0] : (config?.baseUrl ?? XIAOMI_STANDARD_BASE_URL);
	const references = createBundledReferenceMap<"openai-completions">("xiaomi");
	const fetchModels = (url: string, hooks: DiscoveryHooks | undefined) =>
		fetchOpenAICompatibleModels({
			onFailure: hooks?.onFailure,
			api: "openai-completions",
			provider: providerId,
			baseUrl: url,
			apiKey,
			filterModel: (_entry, model) => !model.id.includes("-tts") && !model.id.includes("-asr"),
			mapModel: (entry, defaults) => {
				const reference = references.get(defaults.id);
				const model = mapWithBundledReference(entry, defaults, reference);
				return {
					...model,
					api: "openai-completions",
					provider: providerId,
					baseUrl: defaults.baseUrl,
					name: toModelName(entry.display_name, model.name),
				};
			},
			fetch: config?.fetch,
		});
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: async hooks => {
				if (!isTokenPlanKey) {
					return fetchModels(baseUrl, hooks);
				}
				for (const url of tokenPlanBaseUrls) {
					const result = await fetchModels(url, hooks);
					if (result) return result;
				}
				return null;
			},
		}),
	};
}

export interface LiteLLMModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function mapLiteLLMOpenAICompatibleModel<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<TApi>,
	reference: ModelSpec<TApi> | undefined,
): ModelSpec<TApi> {
	const model = mapWithBundledReference(entry, defaults, reference);
	return {
		...model,
		name: stripLiteLLMResellerUsageSuffix(model.name),
	};
}

function stripLiteLLMResellerUsageSuffix(name: string): string {
	const LITELLM_RESELLER_USAGE_SUFFIX = /\s+\(\d+(?:\.\d+)?[x×] usage\)$/i;
	const cleaned = name.replace(LITELLM_RESELLER_USAGE_SUFFIX, "").trim();
	return cleaned.length > 0 ? cleaned : name;
}

export function litellmModelManagerOptions(
	config?: LiteLLMModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? Bun.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1";
	return {
		providerId: "litellm",
		cacheProviderId: `litellm:rich-v4:${Bun.hash(baseUrl).toString(36)}`,
		fetchDynamicModels: async hooks => {
			const modelsDevReferences = await loadModelsDevReferences<"openai-completions">(config?.fetch);
			const resolveReference = createReferenceResolver(modelsDevReferences);
			const richModels = await fetchLiteLLMRichModels({
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				fetch: config?.fetch,
				referenceResolver: resolveReference,
				timeoutMs: 10_000,
			});
			if (richModels && richModels.length > 0) {
				return richModels;
			}
			return fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "litellm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) =>
					mapLiteLLMOpenAICompatibleModel(entry, defaults, resolveReference(defaults.id)),
				fetch: config?.fetch,
			});
		},
	};
}

const VLLM_DISCOVERY_TIMEOUT_MS = 10_000;

export interface VllmModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function vllmModelManagerOptions(config?: VllmModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "http://127.0.0.1:8000/v1";
	const references = createBundledReferenceMap<"openai-completions">("vllm" as Parameters<typeof getBundledModels>[0]);
	return {
		providerId: "vllm",
		cacheProviderId: `vllm:${Bun.hash(baseUrl).toString(36)}`,
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "vllm",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const model = mapWithBundledReference(entry, defaults, references.get(defaults.id));
					return {
						...model,
						contextWindow: toPositiveNumber(entry.max_model_len, model.contextWindow),
					};
				},
				fetch: config?.fetch,
				timeoutMs: VLLM_DISCOVERY_TIMEOUT_MS,
			}),
	};
}

export interface NanoGptModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nanoGptModelManagerOptions(
	config?: NanoGptModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://nano-gpt.com/api/v1";
	const resolveReference = createReferenceResolver(
		createBundledReferenceMap<"openai-completions">("nanogpt" as Parameters<typeof getBundledModels>[0]),
	);
	return {
		providerId: "nanogpt",
		...(apiKey && {
			fetchDynamicModels: async hooks => {
				const thinkingBaseIds = new Set<string>();
				const models = await fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "nanogpt",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = resolveReference(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return { ...mapped, api: "openai-completions", provider: "nanogpt" };
					},
					filterModel: (_entry, model) => {
						const match = NANO_GPT_THINKING_SUFFIX_RE.exec(model.id);
						if (match) {
							thinkingBaseIds.add(model.id.slice(0, match.index));
							return false;
						}
						return isLikelyNanoGptTextModelId(model.id);
					},
					fetch: config?.fetch,
				});
				if (!models) return null;
				for (const model of models) {
					if (!model.reasoning && thinkingBaseIds.has(model.id)) {
						(model as { reasoning: boolean }).reasoning = true;
					}
				}
				return models;
			},
		}),
	};
}

export interface GithubCopilotModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function githubCopilotModelManagerOptions(config?: GithubCopilotModelManagerConfig): ModelManagerOptions<Api> {
	const rawApiKey = config?.apiKey;
	const configuredBaseUrl = config?.baseUrl ?? "https://api.githubcopilot.com";
	const parsedApiKey = rawApiKey ? parseGitHubCopilotApiKey(rawApiKey) : undefined;
	const apiKey = parsedApiKey?.accessToken;
	const baseUrl =
		parsedApiKey?.apiEndpoint && configuredBaseUrl.includes("githubcopilot.com")
			? parsedApiKey.apiEndpoint
			: parsedApiKey?.enterpriseUrl && configuredBaseUrl.includes("githubcopilot.com")
				? getGitHubCopilotBaseUrl(parsedApiKey.enterpriseUrl)
				: configuredBaseUrl;
	const providerRefs = createBundledReferenceMap<Api>("github-copilot");
	const resolveReference = createReferenceResolver(providerRefs);
	return {
		providerId: "github-copilot",
		...(apiKey && {
			fetchDynamicModels: async hooks => {
				const longContextVariants: ModelSpec<Api>[] = [];
				const models = await fetchOpenAICompatibleModels<Api>({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl,
					apiKey,
					headers: COPILOT_API_HEADERS,
					mapModel: (
						entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<Api>,
						_context: OpenAICompatibleModelMapperContext<Api>,
					): ModelSpec<Api> | null => {
						if (!isCopilotChatModel(entry)) {
							return null;
						}
						const reference = resolveReference(defaults.id);
						const copilotLimits = extractCopilotLimits(entry);
						const contextWindow = toPositiveNumber(
							copilotLimits.maxContextWindowTokens,
							toPositiveNumber(
								entry.context_length,
								toPositiveNumber(
									copilotLimits.maxPromptTokens,
									reference?.contextWindow ?? defaults.contextWindow,
								),
							),
						);
						const maxTokens = toPositiveNumber(
							copilotLimits.maxOutputTokens,
							toPositiveNumber(
								entry.max_completion_tokens,
								toPositiveNumber(
									copilotLimits.maxNonStreamingOutputTokens,
									reference?.maxTokens ?? defaults.maxTokens,
								),
							),
						);
						const name =
							typeof entry.name === "string" && entry.name.trim().length > 0
								? entry.name
								: (reference?.name ?? defaults.name);
						const api = inferCopilotApi(defaults.id);
						const supportsVision = extractCopilotSupportsVision(entry);
						const input: ModelSpec<Api>["input"] =
							supportsVision === true
								? ["text", "image"]
								: supportsVision === false || !isPersonalGitHubCopilotBaseUrl(baseUrl)
									? ["text"]
									: (reference?.input ?? defaults.input);
						const tokenPrices = extractCopilotTokenPrices(entry);
						const defaultContextMax = tokenPrices.defaultTier?.contextMax;
						const defaultTierWindow =
							defaultContextMax !== undefined &&
							defaultContextMax > 0 &&
							contextWindow !== null &&
							maxTokens !== null
								? Math.min(contextWindow, defaultContextMax + maxTokens)
								: contextWindow;
						const base: ModelSpec<Api> = reference
							? {
									...reference,
									api,
									provider: "github-copilot",
									baseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: { ...COPILOT_API_HEADERS, ...(providerRefs.get(defaults.id)?.headers ?? {}) },
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								}
							: {
									...defaults,
									api,
									baseUrl,
									name,
									input,
									contextWindow: defaultTierWindow,
									maxTokens,
									headers: { ...COPILOT_API_HEADERS },
									...(api === "openai-completions"
										? {
												compat: {
													supportsStore: false,
													supportsDeveloperRole: false,
													supportsReasoningEffort: false,
												},
											}
										: {}),
								};
						const variant = createCopilotLongContextVariant(
							base,
							contextWindow,
							maxTokens,
							tokenPrices.longContext,
						);
						if (variant) {
							longContextVariants.push(variant);
							base.contextPromotionTarget ??= `github-copilot/${variant.id}`;
						}
						return base;
					},
					fetch: config?.fetch,
				});
				if (models === null) {
					return null;
				}
				const takenIds = new Set(models.map(model => model.id));
				for (const variant of longContextVariants) {
					if (takenIds.has(variant.id)) {
						continue;
					}
					takenIds.add(variant.id);
					models.push(variant);
				}
				return models.sort((left, right) => left.id.localeCompare(right.id));
			},
		}),
	};
}

export interface AnthropicModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function anthropicModelManagerOptions(
	config?: AnthropicModelManagerConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? ANTHROPIC_BASE_URL;
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	return {
		providerId: "anthropic",
		modelsDev: {
			fetch: hooks => fetchModelsDevPayload(config?.fetch, hooks),
			map: payload => mapAnthropicModelsDev(payload, baseUrl),
		},
		...(apiKey && {
			fetchDynamicModels: async hooks => {
				const modelsDevModels = await fetchModelsDevPayload(config?.fetch)
					.then(payload => mapAnthropicModelsDev(payload, baseUrl))
					.catch(() => []);
				const references = buildAnthropicReferenceMap(modelsDevModels);
				return (
					fetchOpenAICompatibleModels({
						onFailure: hooks?.onFailure,
						api: "anthropic-messages",
						provider: "anthropic",
						baseUrl: discoveryBaseUrl,
						headers: buildAnthropicDiscoveryHeaders(apiKey),
						mapModel: (
							entry: OpenAICompatibleModelRecord,
							defaults: ModelSpec<"anthropic-messages">,
							_context: OpenAICompatibleModelMapperContext<"anthropic-messages">,
						): ModelSpec<"anthropic-messages"> => {
							const discoveredName = typeof entry.display_name === "string" ? entry.display_name : defaults.name;
							const reference = references.get(defaults.id);
							if (!reference) {
								return {
									...defaults,
									name: discoveredName,
								};
							}
							return {
								...reference,
								id: defaults.id,
								name: discoveredName,
								api: "anthropic-messages",
								provider: "anthropic",
								baseUrl,
							};
						},
						fetch: config?.fetch,
					}) ?? null
				);
			},
		}),
	};
}
