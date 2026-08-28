import type { DiscoveryHooks } from "../../discovery/failure";
import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../../discovery/openai-compatible";
import type { ModelManagerOptions } from "../../model-manager";
import type { getBundledModels } from "../../models";
import type { Api, FetchImpl, ModelSpec, Provider } from "../../types";
import { toPositiveNumber } from "../../utils";
import { coreWeaveProjectHeaders } from "../../wire/coreweave";
import {
	COPILOT_API_HEADERS,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	parseGitHubCopilotApiKey,
} from "../../wire/github-copilot";
import { createBundledReferenceMap, createReferenceResolver } from "../bundled-references";
import {
	buildAnthropicDiscoveryHeaders,
	buildAnthropicReferenceMap,
	createSimpleAnthropicProviderOptions,
	createSimpleOpenAICompletionsOptions,
	fetchModelsDevPayload,
	isLikelyNanoGptTextModelId,
	mapAnthropicModelsDev,
	mapWithBundledReference,
	NANO_GPT_THINKING_SUFFIX_RE,
	toAnthropicDiscoveryBaseUrl,
	toModelName,
} from "./helpers";
import {
	ANTHROPIC_BASE_URL,
	createCopilotLongContextVariant,
	extractCopilotLimits,
	extractCopilotSupportsVision,
	extractCopilotTokenPrices,
	fetchLiteLLMRichModels,
	inferCopilotApi,
	isCopilotChatModel,
	isNousToolCapableChatModel,
	isSakanaFuguModelId,
	mapNousResearchModel,
	NOUS_RESEARCH_BASE_URL,
	normalizeSakanaBaseUrl,
	SAKANA_FUGU_STATIC_MODEL_BY_ID,
	SAKANA_FUGU_STATIC_MODEL_IDS,
	SAKANA_FUGU_THINKING,
	SAKANA_RESPONSES_COMPAT,
	XIAOMI_TOKEN_PLAN_BASE_URLS,
	XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS,
	type XiaomiTokenPlanRegion,
} from "./overrides";
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

export {
	type AlibabaCodingPlanModelManagerConfig,
	alibabaCodingPlanModelManagerOptions,
	type BasetenModelManagerConfig,
	basetenModelManagerOptions,
	fetchLmStudioNativeModelMetadata,
	type KiloModelManagerConfig,
	type KimiCodeModelManagerConfig,
	kiloModelManagerOptions,
	kimiCodeModelManagerOptions,
	type LmStudioModelManagerConfig,
	type LmStudioNativeModelMetadata,
	type LmStudioNativeModelMetadataOptions,
	lmStudioModelManagerOptions,
	type OpenRouterModelManagerConfig,
	ollamaModelManagerOptions,
	openrouterModelManagerOptions,
	type SyntheticModelManagerConfig,
	syntheticModelManagerOptions,
	type VeniceModelManagerConfig,
	type VercelAiGatewayModelManagerConfig,
	veniceModelManagerOptions,
	vercelAiGatewayModelManagerOptions,
	type ZenMuxModelManagerConfig,
	zenmuxModelManagerOptions,
} from "./providers-helpers-2";

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
