import { errorMessage } from "@veyyon/utils/type-guards";
import type { DiscoveryHooks } from "../../discovery/failure";
import {
	fetchOpenAICompatibleModels,
	type OpenAICompatibleModelMapperContext,
	type OpenAICompatibleModelRecord,
} from "../../discovery/openai-compatible";
import type { Effort } from "../../effort";
import { toFireworksPublicModelId } from "../../fireworks-model-id";
import { isGlmVisionModelId, isReasoningGlmModelId } from "../../identity/family";
import type { ModelManagerOptions } from "../../model-manager";
import type { getBundledModels } from "../../models";
import type { Api, FetchImpl, ModelSpec, ThinkingConfig } from "../../types";
import { discoveryFetch, isRecord, toBoolean, toPositiveNumber } from "../../utils";
import { createBundledReferenceMap, createReferenceResolver } from "../bundled-references";
import {
	createSimpleOpenAICompletionsOptions,
	createSimpleOpenAIResponsesOptions,
	isLikelyAimlApiChatModelId,
	isLikelyOpenAIResponsesModelId,
	mapWithBundledReference,
	normalizeAnthropicBaseUrl,
	toAnthropicDiscoveryBaseUrl,
	toInputCapabilities,
	toModelName,
} from "./helpers";
import {
	applyCerebrasDiscoveryOverrides,
	applyHuggingfaceProviderCapabilities,
	applyXAIOAuthCuration,
	buildXaiOAuthStaticSeed,
	clampFireworksKimiMaxTokens,
	FIREWORKS_KIMI_MAX_TOKENS,
	isFireworksKimiK2ModelId,
	resolveWaferServerlessThinkingFormat,
	stripFireworksDeepSeekThinkingToggle,
	UMANS_BASE_URL,
	UMANS_DEFAULT_REASONING_EFFORTS,
	UMANS_MODELS_INFO_PATH,
	UMANS_REASONING_EFFORT_BY_LEVEL,
	UMANS_VIA_HANDOFF_MODEL_IDS,
	WAFER_DEFAULT_BASE_URL,
	WAFER_MAX_TOKENS_CAP,
} from "./overrides";
import { loadModelsDevReferences } from "./resolvers";

export interface UmansModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface UmansModelInfo {
	name?: unknown;
	display_name?: unknown;
	capabilities?: unknown;
}

export function normalizeUmansBaseUrl(baseUrl: string | undefined): string {
	const normalized = normalizeAnthropicBaseUrl(baseUrl, UMANS_BASE_URL);
	return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function umansSupportsVision(value: unknown): boolean {
	return value === true;
}

function umansReasoningSupported(value: unknown): boolean {
	return isRecord(value) ? value.supported === true : value === true;
}

function mapUmansReasoningEfforts(value: unknown): readonly Effort[] {
	if (!isRecord(value) || !Array.isArray(value.levels)) {
		return UMANS_DEFAULT_REASONING_EFFORTS;
	}
	const efforts: Effort[] = [];
	for (const level of value.levels) {
		if (typeof level !== "string") continue;
		const effort = UMANS_REASONING_EFFORT_BY_LEVEL[level];
		if (effort !== undefined && !efforts.includes(effort)) {
			efforts.push(effort);
		}
	}
	return efforts.length > 0 ? efforts : UMANS_DEFAULT_REASONING_EFFORTS;
}

function umansHasMaxReasoningLevel(value: unknown): boolean {
	return isRecord(value) && Array.isArray(value.levels) && value.levels.includes("max");
}

function mapUmansThinkingConfig(value: unknown): ThinkingConfig | undefined {
	if (!umansReasoningSupported(value)) return undefined;
	const efforts = mapUmansReasoningEfforts(value);
	const thinking: ThinkingConfig = {
		mode: umansHasMaxReasoningLevel(value) ? "anthropic-budget-effort" : "budget",
		efforts,
	};
	if (isRecord(value)) {
		if (value.can_disable === false) {
			thinking.requiresEffort = true;
		}
		if (typeof value.default_level === "string") {
			const defaultLevel = UMANS_REASONING_EFFORT_BY_LEVEL[value.default_level];
			if (defaultLevel !== undefined && efforts.includes(defaultLevel)) {
				thinking.defaultLevel = defaultLevel;
			}
		}
	}
	return thinking;
}

function mapUmansModelInfo(
	modelId: string,
	raw: UmansModelInfo,
	baseUrl: string,
	reference: ModelSpec<"anthropic-messages"> | undefined,
): ModelSpec<"anthropic-messages"> | null {
	if (!modelId) return null;
	const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
	const supportsTools = capabilities.supports_tools;
	const thinking = mapUmansThinkingConfig(capabilities.reasoning);
	return {
		...reference,
		id: modelId,
		name: toModelName(raw.display_name, toModelName(raw.name, modelId)),
		api: "anthropic-messages",
		provider: "umans",
		baseUrl,
		compat: { ...reference?.compat, escapeBuiltinToolNames: true },
		reasoning: thinking !== undefined,
		...(thinking ? { thinking } : {}),
		input: umansSupportsVision(capabilities.supports_vision) ? ["text", "image"] : ["text"],
		...(supportsTools === false ? { supportsTools: false } : {}),
		cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: toPositiveNumber(capabilities.context_window, reference?.contextWindow ?? null),
		maxTokens: toPositiveNumber(
			capabilities.recommended_max_tokens,
			toPositiveNumber(capabilities.max_completion_tokens, reference?.maxTokens ?? null),
		),
	};
}

async function fetchUmansModelsInfo(options: {
	baseUrl: string;
	apiKey?: string;
	fetch?: FetchImpl;
	references: Map<string, ModelSpec<"anthropic-messages">>;
	onFailure?: DiscoveryHooks["onFailure"];
}): Promise<ModelSpec<"anthropic-messages">[] | null> {
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(options.baseUrl);
	const requestHeaders: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		requestHeaders["x-api-key"] = options.apiKey;
	}
	const fetchImpl = discoveryFetch(options.fetch);
	const url = `${discoveryBaseUrl}${UMANS_MODELS_INFO_PATH}`;
	let payload: unknown;
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: requestHeaders,
		});
		if (!response.ok) {
			options.onFailure?.({
				stage: "status",
				url,
				detail: `HTTP ${response.status} ${response.statusText}`.trim(),
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		throw new Error("Failed to fetch Umans models info", { cause: error });
	}
	if (!isRecord(payload)) {
		options.onFailure?.({ stage: "payload", url, detail: "models-info response was not an object" });
		return null;
	}
	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;
		const mapped = mapUmansModelInfo(modelId, value, options.baseUrl, options.references.get(modelId));
		if (mapped) {
			models.push(mapped);
		}
	}
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

export function umansModelManagerOptions(config?: UmansModelManagerConfig): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeUmansBaseUrl(config?.baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">("umans");
	return {
		providerId: "umans",
		dynamicModelsAuthoritative: true,
		dropCachedModelIdsOnStaticMismatch: UMANS_VIA_HANDOFF_MODEL_IDS,
		fetchDynamicModels: hooks =>
			fetchUmansModelsInfo({ baseUrl, apiKey, fetch: config?.fetch, references, onFailure: hooks?.onFailure }),
	};
}

export interface OpenAIModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function openaiModelManagerOptions(config?: OpenAIModelManagerConfig): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.openai.com/v1";
	const references = createBundledReferenceMap<"openai-responses">("openai");
	return {
		providerId: "openai",
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-responses",
					provider: "openai",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelyOpenAIResponsesModelId(model.id, references),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface GroqModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}

export interface CerebrasModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function cerebrasModelManagerOptions(
	config?: CerebrasModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.cerebras.ai/v1";
	const references = createBundledReferenceMap<"openai-completions">("cerebras");
	return {
		providerId: "cerebras",
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						return applyCerebrasDiscoveryOverrides(model);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface HuggingfaceModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function huggingfaceModelManagerOptions(
	config?: HuggingfaceModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions(
		"huggingface",
		"https://router.huggingface.co/v1",
		config,
		applyHuggingfaceProviderCapabilities,
	);
}

export interface NvidiaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function nvidiaModelManagerOptions(
	config?: NvidiaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("nvidia", "https://integrate.api.nvidia.com/v1", config);
}

export interface NovitaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function novitaArrayIncludes(value: unknown, expected: string): boolean {
	return Array.isArray(value) && value.some(item => item === expected);
}

function isPublicNovitaModelId(id: string): boolean {
	return !id.toLowerCase().startsWith("ai_infer_test");
}

function toNovitaCostPerMillion(value: unknown): number {
	return toPositiveNumber(value, 0) / 10_000;
}

function getNovitaCacheReadPricePerMillion(entry: OpenAICompatibleModelRecord): number {
	const pricing = entry.pricing;
	if (!isRecord(pricing)) {
		return 0;
	}
	const cacheRead = pricing.input_cache_read;
	if (!isRecord(cacheRead)) {
		return 0;
	}
	return toNovitaCostPerMillion(cacheRead.price_per_m);
}

function mapNovitaModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	const model = mapWithBundledReference(
		{
			...entry,
			name: entry.display_name ?? entry.title ?? entry.name,
		},
		defaults,
		reference,
	);
	return {
		...model,
		reasoning: novitaArrayIncludes(entry.features, "reasoning"),
		supportsTools: novitaArrayIncludes(entry.features, "function-calling"),
		input: toInputCapabilities(entry.input_modalities),
		cost: {
			input: toNovitaCostPerMillion(entry.input_token_price_per_m),
			output: toNovitaCostPerMillion(entry.output_token_price_per_m),
			cacheRead: getNovitaCacheReadPricePerMillion(entry),
			cacheWrite: 0,
		},
		contextWindow: toPositiveNumber(entry.context_size, model.contextWindow),
		maxTokens: toPositiveNumber(entry.max_output_tokens, model.maxTokens),
	};
}

export function novitaModelManagerOptions(
	config?: NovitaModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.novita.ai/openai/v1";
	const references = createBundledReferenceMap<"openai-completions">("novita");
	return {
		providerId: "novita",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: async hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "novita",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => mapNovitaModel(entry, defaults, references.get(defaults.id)),
				filterModel: (entry, model) => {
					const active = typeof entry.status !== "number" || entry.status === 1;
					return (
						active &&
						isPublicNovitaModelId(model.id) &&
						novitaArrayIncludes(entry.endpoints, "chat/completions") &&
						toPositiveNumber(entry.max_output_tokens, 0) > 0
					);
				},
				fetch: config?.fetch,
			}),
	};
}

export interface XaiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function xaiModelManagerOptions(config?: XaiModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config);
}

export interface XaiOAuthModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function xaiOAuthModelManagerOptions(
	config?: XaiOAuthModelManagerConfig,
): ModelManagerOptions<"openai-responses"> {
	const defaultBaseUrl = "https://api.x.ai/v1";
	const resolvedBaseUrl = config?.baseUrl ?? defaultBaseUrl;
	const base = createSimpleOpenAIResponsesOptions(
		"xai-oauth" as Parameters<typeof getBundledModels>[0],
		defaultBaseUrl,
		config,
	);
	const staticModels = buildXaiOAuthStaticSeed(resolvedBaseUrl);
	if (!base.fetchDynamicModels) {
		return { ...base, staticModels };
	}
	const inner = base.fetchDynamicModels;
	return {
		...base,
		staticModels,
		fetchDynamicModels: async hooks => {
			const dynamic = await inner(hooks);
			return dynamic == null ? dynamic : applyXAIOAuthCuration(dynamic);
		},
	};
}

export interface AimlApiModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function aimlApiModelManagerOptions(
	config?: AimlApiModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.aimlapi.com/v1";
	const references = createBundledReferenceMap<"openai-completions">("aimlapi");
	return {
		providerId: "aimlapi",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "aimlapi",
					baseUrl,
					apiKey,
					filterModel: (_entry, model) => isLikelyAimlApiChatModelId(model.id),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface DeepSeekModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function deepseekModelManagerOptions(
	config?: DeepSeekModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("deepseek", "https://api.deepseek.com", config);
}

export interface ZhipuCodingPlanModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function zhipuCodingPlanModelManagerOptions(
	config?: ZhipuCodingPlanModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4";
	return {
		providerId: "zhipu-coding-plan",
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: "zhipu-coding-plan",
					baseUrl,
					apiKey,
					mapModel: (
						_entry: OpenAICompatibleModelRecord,
						defaults: ModelSpec<"openai-completions">,
						_context: OpenAICompatibleModelMapperContext<"openai-completions">,
					): ModelSpec<"openai-completions"> => {
						const id = defaults.id;
						return {
							...defaults,
							reasoning: isReasoningGlmModelId(id) || id.includes("thinking"),
							input: isGlmVisionModelId(id) ? (["text", "image"] as const) : ["text"],
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

export interface FireworksModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export const FIREWORKS_CONTROL_PLANE_ACCOUNT = "fireworks";
export const FIREWORKS_SERVERLESS_FILTER = "supports_serverless=true";
export const FIREWORKS_CONTROL_PLANE_PAGE_SIZE = 200;
export const FIREWORKS_CONTROL_PLANE_MAX_PAGES = 25;

export interface FireworksControlPlaneModel {
	name?: unknown;
	displayName?: unknown;
	contextLength?: unknown;
	supportsImageInput?: unknown;
	supportsTools?: unknown;
	supportsServerless?: unknown;
	state?: unknown;
}

function toFireworksControlPlaneModelsUrl(baseUrl: string, account: string): string | null {
	try {
		return `${new URL(baseUrl).origin}/v1/accounts/${account}/models`;
	} catch {
		return null;
	}
}

function mapFireworksControlPlaneModel(
	record: FireworksControlPlaneModel,
	publicModelId: string,
	reference: ModelSpec<"openai-completions"> | undefined,
	baseUrl: string,
): ModelSpec<"openai-completions"> {
	const name = toModelName(record.displayName, reference?.name ?? publicModelId);
	const supportsImage = toBoolean(record.supportsImageInput) === true;
	const supportsTools = toBoolean(record.supportsTools);
	const contextWindow = toPositiveNumber(record.contextLength, reference?.contextWindow ?? null);
	const fallbackMaxTokens = isFireworksKimiK2ModelId(publicModelId) ? FIREWORKS_KIMI_MAX_TOKENS : null;
	const maxTokens = clampFireworksKimiMaxTokens(publicModelId, reference?.maxTokens ?? fallbackMaxTokens);
	const base: ModelSpec<"openai-completions"> = reference ?? {
		id: publicModelId,
		name,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
	const model: ModelSpec<"openai-completions"> = {
		...base,
		id: publicModelId,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl,
		name,
		reasoning: reference?.reasoning ?? true,
		input: supportsImage ? ["text", "image"] : (reference?.input ?? ["text"]),
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools: false } : {}),
	};
	return stripFireworksDeepSeekThinkingToggle(model, publicModelId);
}

async function fetchFireworksServerlessModels(options: {
	baseUrl: string;
	apiKey: string;
	resolveReference: (publicModelId: string) => ModelSpec<"openai-completions"> | undefined;
	fetch?: FetchImpl;
	onFailure?: DiscoveryHooks["onFailure"];
}): Promise<ModelSpec<"openai-completions">[] | null> {
	const listUrl = toFireworksControlPlaneModelsUrl(options.baseUrl, FIREWORKS_CONTROL_PLANE_ACCOUNT);
	if (!listUrl) {
		options.onFailure?.({ stage: "base-url", url: options.baseUrl, detail: "not a Fireworks control-plane URL" });
		return null;
	}
	const fetchImpl = discoveryFetch(options.fetch);
	const collected = new Map<string, ModelSpec<"openai-completions">>();
	let pageToken = "";
	for (let page = 0; page < FIREWORKS_CONTROL_PLANE_MAX_PAGES; page++) {
		const url = new URL(listUrl);
		url.searchParams.set("filter", FIREWORKS_SERVERLESS_FILTER);
		url.searchParams.set("pageSize", String(FIREWORKS_CONTROL_PLANE_PAGE_SIZE));
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		let response: Response;
		try {
			response = await fetchImpl(url.toString(), {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
			});
		} catch (error) {
			options.onFailure?.({ stage: "request", url: url.toString(), detail: errorMessage(error) });
			return null;
		}
		if (!response.ok) {
			options.onFailure?.({
				stage: "status",
				url: url.toString(),
				detail: `HTTP ${response.status} ${response.statusText}`.trim(),
			});
			return null;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			options.onFailure?.({ stage: "body", url: url.toString(), detail: errorMessage(error) });
			return null;
		}
		if (!isRecord(payload)) {
			options.onFailure?.({ stage: "payload", url: url.toString(), detail: "response was not an object" });
			return null;
		}
		const models = Array.isArray(payload.models) ? payload.models : [];
		for (const entry of models) {
			if (!isRecord(entry)) continue;
			const record = entry as FireworksControlPlaneModel;
			if (toBoolean(record.supportsServerless) !== true) continue;
			if (typeof record.state === "string" && record.state !== "READY") continue;
			const wireName = typeof record.name === "string" ? record.name : "";
			if (!wireName) continue;
			const publicModelId = toFireworksPublicModelId(wireName);
			if (!publicModelId) continue;
			collected.set(
				publicModelId,
				mapFireworksControlPlaneModel(
					record,
					publicModelId,
					options.resolveReference(publicModelId),
					options.baseUrl,
				),
			);
		}
		const next = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
		if (!next) break;
		pageToken = next;
	}
	return Array.from(collected.values());
}

export function fireworksModelManagerOptions(
	config?: FireworksModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? "https://api.fireworks.ai/inference/v1";
	const bundledReferences = createReferenceResolver(createBundledReferenceMap<"openai-completions">("fireworks"));
	return {
		providerId: "fireworks",
		...(apiKey && {
			fetchDynamicModels: async hooks => {
				const modelsDevReferences = await loadModelsDevReferences<"openai-completions">(config?.fetch);
				return fetchFireworksServerlessModels({
					baseUrl,
					apiKey,
					resolveReference: publicModelId =>
						modelsDevReferences.get(publicModelId) ?? bundledReferences(publicModelId),
					fetch: config?.fetch,
					onFailure: hooks?.onFailure,
				});
			},
		}),
	};
}

export interface FirepassModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function firepassModelManagerOptions(
	_config?: FirepassModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return {
		providerId: "firepass",
	};
}

export interface WaferModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export interface WaferRecord {
	context_length?: unknown;
	tier?: unknown;
	provider?: unknown;
	capabilities?: { vision?: unknown; reasoning?: unknown; tools?: unknown };
	pricing?: {
		input_cents_per_million?: unknown;
		output_cents_per_million?: unknown;
		cache_read_cents_per_million?: unknown;
	};
	display_name?: unknown;
}

function readWaferRecord(entry: OpenAICompatibleModelRecord): WaferRecord | undefined {
	if (isRecord(entry) && "wafer" in entry && isRecord(entry.wafer)) {
		return entry.wafer as WaferRecord;
	}
	return undefined;
}

function mapWaferModel(
	providerId: "wafer-serverless",
	baseUrl: string,
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	const wafer = readWaferRecord(entry);
	const capabilities = wafer?.capabilities ?? {};
	const reasoning = capabilities.reasoning === true;
	const vision = capabilities.vision === true;
	const supportsTools = toBoolean(capabilities.tools) === false ? false : undefined;
	const maxModelLen = isRecord(entry) && "max_model_len" in entry ? entry.max_model_len : undefined;
	const contextWindow = toPositiveNumber(wafer?.context_length, toPositiveNumber(maxModelLen, defaults.contextWindow));
	const maxTokens = contextWindow !== null ? Math.min(contextWindow, WAFER_MAX_TOKENS_CAP) : null;
	const pricing = wafer?.pricing ?? {};
	const cost = {
		input: (toPositiveNumber(pricing.input_cents_per_million, 0) * 125) / 10000,
		output: (toPositiveNumber(pricing.output_cents_per_million, 0) * 125) / 10000,
		cacheRead: (toPositiveNumber(pricing.cache_read_cents_per_million, 0) * 125) / 10000,
		cacheWrite: 0,
	};
	const name = toModelName(wafer?.display_name, defaults.name);
	const base: ModelSpec<"openai-completions"> = {
		...defaults,
		id: defaults.id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		reasoning,
		input: vision ? (["text", "image"] as const) : ["text"],
		cost,
		contextWindow,
		maxTokens,
		...(supportsTools === false ? { supportsTools } : {}),
	};
	if (reasoning) {
		const thinkingFormat = resolveWaferServerlessThinkingFormat(defaults.id, wafer?.provider);
		return {
			...base,
			compat: {
				...(thinkingFormat ? { thinkingFormat } : {}),
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		};
	}
	return {
		...base,
		compat: { supportsDeveloperRole: false },
	};
}

export function waferServerlessModelManagerOptions(
	config?: WaferModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? WAFER_DEFAULT_BASE_URL;
	const providerId = "wafer-serverless" as const;
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: providerId,
					baseUrl,
					apiKey,
					mapModel: (entry, defaults) => mapWaferModel(providerId, baseUrl, entry, defaults),
					fetch: config?.fetch,
				}),
		}),
	};
}

export interface MistralModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function mistralModelManagerOptions(
	config?: MistralModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("mistral", "https://api.mistral.ai/v1", config);
}

export interface OpenCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

function normalizeOpenCodeBasePath(baseUrl: string | undefined, fallbackBasePath: string): string {
	const value = normalizeAnthropicBaseUrl(baseUrl, fallbackBasePath);
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

function openCodeBaseUrlForApi(api: Api, basePath: string): string {
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

function openCodeModelCacheProviderId(
	providerId: "opencode-go" | "opencode-zen",
	apiKey: string | undefined,
	discoveryBaseUrl: string,
): string {
	const scope = `${apiKey ?? ""}\u0000${discoveryBaseUrl}`;
	return `${providerId}:models-v1:${Bun.hash(scope).toString(36)}`;
}

function openCodeModelManagerOptions(
	providerId: "opencode-go" | "opencode-zen",
	defaultBasePath: string,
	config?: OpenCodeModelManagerConfig,
): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const basePath = normalizeOpenCodeBasePath(config?.baseUrl, defaultBasePath);
	const discoveryBaseUrl = openCodeBaseUrlForApi("openai-completions", basePath);
	const references = createBundledReferenceMap<Api>(providerId);
	return {
		providerId,
		cacheProviderId: openCodeModelCacheProviderId(providerId, apiKey, discoveryBaseUrl),
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels<Api>({
					onFailure: hooks?.onFailure,
					api: "openai-completions",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					apiKey,
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const name = toModelName(entry.name, reference?.name ?? defaults.name);
						if (!reference) {
							return {
								...defaults,
								name,
							};
						}
						return {
							...reference,
							id: defaults.id,
							name,
							baseUrl: openCodeBaseUrlForApi(reference.api, basePath),
							contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
							maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export function opencodeZenModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-zen", "https://opencode.ai/zen", config);
}

export function opencodeGoModelManagerOptions(config?: OpenCodeModelManagerConfig): ModelManagerOptions<Api> {
	return openCodeModelManagerOptions("opencode-go", "https://opencode.ai/zen/go", config);
}

export interface OllamaModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}
