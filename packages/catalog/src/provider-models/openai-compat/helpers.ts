import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { DiscoveryFailure, DiscoveryHooks } from "../../discovery/failure";
import { fetchOpenAICompatibleModels, type OpenAICompatibleModelRecord } from "../../discovery/openai-compatible";
import { canonicalizeEfforts, type Effort, isEffort } from "../../effort";
import type { ModelManagerOptions } from "../../model-manager";
import { OLLAMA_WIRE_EFFORTS } from "../../model-thinking";
import { getBundledModels } from "../../models";
import type { Api, FetchImpl, Model, ModelReasoningOptions, ModelSpec, ThinkingConfig } from "../../types";
import { discoveryFetch, isAnthropicOAuthToken, isRecord, toNumber, toPositiveNumber } from "../../utils";
import { createBundledReferenceMap, toModelSpec } from "../bundled-references";

const MODELS_DEV_URL = "https://models.dev/api.json";

export async function withCatalogDiscoveryTimeout<T>(
	timeoutMs: number,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

export interface ModelsDevModel {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
	status?: string;
	provider?: { npm?: string };
}

export interface ModelsDevReasoningOption {
	type?: string;
	values?: unknown[];
	min?: number;
	max?: number;
}

const REASONING_NON_LEVEL_VALUES: Record<string, true> = { none: true, default: true, auto: true };

export function mapModelsDevReasoningOptions(
	options: readonly ModelsDevReasoningOption[] | undefined,
	modelId?: string,
): ModelReasoningOptions | undefined {
	if (!options) return undefined;
	const effortOption = options.find(option => option.type === "effort");
	if (effortOption) {
		const values = Array.isArray(effortOption.values) ? effortOption.values : undefined;
		const efforts = (values ?? []).filter((value): value is Effort => isEffort(value));
		if (efforts.length > 0) {
			if (efforts.length === 1 && modelId !== undefined && modelId.toLowerCase().endsWith(`-${efforts[0]}`)) {
				return { noEffortControl: true };
			}
			return { efforts: canonicalizeEfforts(efforts) };
		}
		const levelless = values?.every(
			value => value === null || (typeof value === "string" && Object.hasOwn(REASONING_NON_LEVEL_VALUES, value)),
		);
		if (levelless) {
			return { noEffortControl: true };
		}
		return undefined;
	}
	if (options.some(option => option.type === "budget_tokens")) {
		return undefined;
	}
	return { noEffortControl: true };
}

export function toModelName(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

export function toInputCapabilities(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) {
		return ["text"];
	}
	const supportsImage = value.some(item => item === "image");
	return supportsImage ? ["text", "image"] : ["text"];
}

export async function fetchModelsDevPayload(
	fetchImpl: FetchImpl = discoveryFetch(),
	hooks?: DiscoveryHooks,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(MODELS_DEV_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch (error) {
		hooks?.onFailure?.({ stage: "request", url: MODELS_DEV_URL, detail: errorMessage(error) });
		return null;
	}
	if (!response.ok) {
		hooks?.onFailure?.({
			stage: "status",
			url: MODELS_DEV_URL,
			detail: `HTTP ${response.status} ${response.statusText}`.trim(),
		});
		return null;
	}
	try {
		return await response.json();
	} catch (error) {
		hooks?.onFailure?.({ stage: "body", url: MODELS_DEV_URL, detail: errorMessage(error) });
		return null;
	}
}

export function mapAnthropicModelsDev(payload: unknown, baseUrl: string): ModelSpec<"anthropic-messages">[] {
	if (!isRecord(payload)) {
		return [];
	}
	const anthropicPayload = payload.anthropic;
	if (!isRecord(anthropicPayload)) {
		return [];
	}
	const modelsValue = anthropicPayload.models;
	if (!isRecord(modelsValue)) {
		return [];
	}

	const models: ModelSpec<"anthropic-messages">[] = [];
	for (const [modelId, rawModel] of Object.entries(modelsValue)) {
		if (!isRecord(rawModel)) {
			continue;
		}
		const model = rawModel as ModelsDevModel;
		if (model.tool_call !== true) {
			continue;
		}
		const reasoningOptions =
			model.reasoning === true ? mapModelsDevReasoningOptions(model.reasoning_options, modelId) : undefined;
		models.push({
			id: modelId,
			name: toModelName(model.name, modelId),
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl,
			reasoning: model.reasoning === true,
			...(reasoningOptions !== undefined ? { reasoningOptions } : {}),
			input: toInputCapabilities(model.modalities?.input),
			cost: {
				input: toNumber(model.cost?.input) ?? 0,
				output: toNumber(model.cost?.output) ?? 0,
				cacheRead: toNumber(model.cost?.cache_read) ?? 0,
				cacheWrite: toNumber(model.cost?.cache_write) ?? 0,
			},
			contextWindow: toPositiveNumber(model.limit?.context, null),
			maxTokens: toPositiveNumber(model.limit?.output, null),
		});
	}

	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

export function buildAnthropicDiscoveryHeaders(apiKey: string): Record<string, string> {
	const oauthToken = isAnthropicOAuthToken(apiKey);
	const headers: Record<string, string> = {
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-beta":
			"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
	};
	if (oauthToken) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else {
		headers["x-api-key"] = apiKey;
	}
	return headers;
}

export function buildAnthropicReferenceMap(
	modelsDevModels: readonly ModelSpec<"anthropic-messages">[],
): Map<string, ModelSpec<"anthropic-messages">> {
	const merged = new Map<string, ModelSpec<"anthropic-messages">>();
	for (const model of modelsDevModels) {
		merged.set(model.id, model);
	}
	const bundledModels = getBundledModels("anthropic").filter(
		(model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages",
	);
	for (const model of bundledModels) {
		merged.set(model.id, toModelSpec(model));
	}
	return merged;
}

export function mapWithBundledReference<TApi extends Api>(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<TApi>,
	reference: ModelSpec<TApi> | undefined,
): ModelSpec<TApi> {
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
		api: defaults.api,
		provider: defaults.provider,
		baseUrl: defaults.baseUrl,
		contextWindow: toPositiveNumber(entry.context_length, reference.contextWindow),
		maxTokens: toPositiveNumber(entry.max_completion_tokens, reference.maxTokens),
	};
}

export function normalizeAnthropicBaseUrl(baseUrl: string | undefined, fallback: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return fallback;
	}
	return trimTrailingSlashes(value);
}

export function toAnthropicDiscoveryBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

export function normalizeOllamaBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "http://127.0.0.1:11434/v1";
	}
	const trimmed = trimTrailingSlashes(value);
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function toOllamaNativeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

export interface OllamaResolvedMetadata {
	contextWindow: number;
	maxTokens: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

export interface OllamaShowMetadata {
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: string[];
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
}

function getOllamaContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number" || value <= 0) {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getOllamaCapabilities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === "string");
}

interface OllamaShowPayload {
	capabilities?: unknown;
	model_info?: Record<string, unknown>;
}

interface OllamaTagsPayload {
	models?: Array<{ name?: string; model?: string }>;
}

function getOllamaThinkingConfig(capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	return { mode: "effort", efforts: OLLAMA_WIRE_EFFORTS.slice() };
}

async function fetchOllamaShowMetadata(
	nativeBaseUrl: string,
	modelId: string,
	fetchImpl: FetchImpl = discoveryFetch(),
	onFailure?: DiscoveryHooks["onFailure"],
): Promise<OllamaShowMetadata | undefined> {
	const url = `${nativeBaseUrl}/api/show`;
	const report = (stage: DiscoveryFailure["stage"], detail: string): void =>
		onFailure?.({ stage, url, detail: `${modelId}: ${detail}` });
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
	} catch (error) {
		report("request", errorMessage(error));
		return undefined;
	}
	if (!response.ok) {
		report("status", `HTTP ${response.status} ${response.statusText}`.trim());
		return undefined;
	}
	let payload: OllamaShowPayload;
	try {
		const json: unknown = await response.json();
		payload = isRecord(json) ? (json as OllamaShowPayload) : {};
	} catch (error) {
		report("body", errorMessage(error));
		return undefined;
	}
	const capabilities = getOllamaCapabilities(payload.capabilities);
	const contextWindow = getOllamaContextWindow(payload.model_info);
	return {
		contextWindow,
		maxTokens: contextWindow ? 8192 : undefined,
		capabilities,
		reasoning: capabilities ? capabilities.includes("thinking") : undefined,
		thinking: getOllamaThinkingConfig(capabilities),
		input: capabilities
			? capabilities.includes("vision")
				? (["text", "image"] as Array<"text" | "image">)
				: (["text"] as Array<"text">)
			: undefined,
	};
}

export function createOllamaMetadataResolver(
	nativeBaseUrl: string,
	fetchImpl?: FetchImpl,
): (modelId: string, onFailure?: DiscoveryHooks["onFailure"]) => Promise<OllamaResolvedMetadata> {
	const cache = new Map<string, Promise<OllamaResolvedMetadata>>();
	return (modelId, onFailure) => {
		const cached = cache.get(modelId);
		if (cached) return cached;
		const pending = (async () => {
			const metadata = await fetchOllamaShowMetadata(nativeBaseUrl, modelId, fetchImpl, onFailure);
			if (!metadata) {
				cache.delete(modelId);
				return { contextWindow: 128_000, maxTokens: 8192 };
			}
			return {
				...metadata,
				contextWindow: metadata.contextWindow ?? 128_000,
				maxTokens: metadata.maxTokens ?? 8192,
			};
		})();
		cache.set(modelId, pending);
		void pending.catch(() => cache.delete(modelId));
		return pending;
	};
}

export async function fetchOllamaNativeModels(
	baseUrl: string,
	resolveMetadata: (modelId: string, onFailure?: DiscoveryHooks["onFailure"]) => Promise<OllamaResolvedMetadata>,
	fetchImpl: FetchImpl = discoveryFetch(),
	onFailure?: DiscoveryHooks["onFailure"],
): Promise<ModelSpec<"openai-responses">[] | null> {
	const nativeBaseUrl = toOllamaNativeBaseUrl(baseUrl);
	const url = `${nativeBaseUrl}/api/tags`;
	const report = (stage: DiscoveryFailure["stage"], detail: string): void => onFailure?.({ stage, url, detail });
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
	} catch (error) {
		report("request", errorMessage(error));
		return null;
	}
	if (!response.ok) {
		report("status", `HTTP ${response.status} ${response.statusText}`.trim());
		return null;
	}
	let payload: OllamaTagsPayload;
	try {
		const json: unknown = await response.json();
		payload = isRecord(json) ? (json as OllamaTagsPayload) : {};
	} catch (error) {
		report("body", errorMessage(error));
		return null;
	}
	const entries = payload.models ?? [];
	const resolved = await Promise.all(
		entries.map(async (entry): Promise<ModelSpec<"openai-responses"> | null> => {
			const id = entry.model ?? entry.name;
			if (!id) return null;
			const metadata = await resolveMetadata(id, onFailure);
			return {
				id,
				name: entry.name ?? id,
				api: "openai-responses",
				provider: "ollama",
				baseUrl,
				reasoning: metadata.reasoning ?? false,
				thinking: metadata.thinking,
				input: metadata.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.contextWindow,
				maxTokens: metadata.maxTokens,
			};
		}),
	);
	const models: ModelSpec<"openai-responses">[] = resolved.filter(
		(m): m is ModelSpec<"openai-responses"> => m !== null,
	);
	return models.sort((left, right) => left.id.localeCompare(right.id));
}

const OPENAI_NON_RESPONSES_PREFIXES = [
	"text-embedding",
	"whisper-",
	"tts-",
	"omni-moderation",
	"omni-transcribe",
	"omni-speech",
	"gpt-image-",
	"gpt-realtime",
] as const;

export function isLikelyOpenAIResponsesModelId(
	id: string,
	references: Map<string, ModelSpec<"openai-responses">>,
): boolean {
	const trimmed = id.trim();
	if (!trimmed) {
		return false;
	}
	if (references.has(trimmed)) {
		return true;
	}
	const normalized = trimmed.toLowerCase();
	if (OPENAI_NON_RESPONSES_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
		return false;
	}
	if (normalized.includes("embedding")) {
		return false;
	}
	return (
		normalized.startsWith("gpt-") ||
		normalized.startsWith("o1") ||
		normalized.startsWith("o3") ||
		normalized.startsWith("o4") ||
		normalized.startsWith("chatgpt")
	);
}

const NANO_GPT_NON_TEXT_MODEL_TOKENS = [
	"embedding",
	"image",
	"vision",
	"audio",
	"speech",
	"transcribe",
	"moderation",
	"realtime",
	"whisper",
	"tts",
] as const;

export const NANO_GPT_THINKING_SUFFIX_RE = /:thinking(:[^:]+)?$/;

export function isLikelyNanoGptTextModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	if (NANO_GPT_THINKING_SUFFIX_RE.test(normalized)) {
		return false;
	}
	return !NANO_GPT_NON_TEXT_MODEL_TOKENS.some(token => normalized.includes(token));
}

const AIML_API_NON_CHAT_MODEL_ID_PATTERN =
	/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i;

const AIML_API_NON_CHAT_MODEL_ID_SUBSTRINGS = ["dall-e", "dalle", "flux", "imagen", "sora", "veo", "whisper"] as const;

export function isLikelyAimlApiChatModelId(id: string): boolean {
	const normalized = id.trim().toLowerCase();
	if (!normalized) return false;
	return (
		!AIML_API_NON_CHAT_MODEL_ID_PATTERN.test(normalized) &&
		!AIML_API_NON_CHAT_MODEL_ID_SUBSTRINGS.some(token => normalized.includes(token))
	);
}

export type SimpleProviderDiscoveryHeaders = Record<string, string> | (() => Record<string, string> | undefined);

export type SimpleProviderConfig = {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	headers?: SimpleProviderDiscoveryHeaders;
};

function resolveSimpleProviderHeaders(
	headers: SimpleProviderDiscoveryHeaders | undefined,
): Record<string, string> | undefined {
	return typeof headers === "function" ? headers() : headers;
}

export function createSimpleOpenAICompletionsOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
	refineModel?: (
		entry: OpenAICompatibleModelRecord,
		model: ModelSpec<"openai-completions">,
	) => ModelSpec<"openai-completions">,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	const references = createBundledReferenceMap<"openai-completions">(providerId);
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
					headers: resolveSimpleProviderHeaders(config?.headers),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const mapped = mapWithBundledReference(entry, defaults, reference);
						return refineModel ? refineModel(entry, mapped) : mapped;
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export function createSimpleOpenAIResponsesOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrl: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"openai-responses"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? defaultBaseUrl;
	const references = createBundledReferenceMap<"openai-responses">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "openai-responses",
					provider: providerId,
					baseUrl,
					apiKey,
					headers: resolveSimpleProviderHeaders(config?.headers),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						return mapWithBundledReference(entry, defaults, reference);
					},
					fetch: config?.fetch,
				}),
		}),
	};
}

export function createSimpleAnthropicProviderOptions(
	providerId: Parameters<typeof getBundledModels>[0],
	defaultBaseUrlFallback: string,
	config?: SimpleProviderConfig,
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeAnthropicBaseUrl(config?.baseUrl, defaultBaseUrlFallback);
	const discoveryBaseUrl = toAnthropicDiscoveryBaseUrl(baseUrl);
	const references = createBundledReferenceMap<"anthropic-messages">(providerId);
	return {
		providerId,
		...(apiKey && {
			fetchDynamicModels: hooks =>
				fetchOpenAICompatibleModels({
					onFailure: hooks?.onFailure,
					api: "anthropic-messages",
					provider: providerId,
					baseUrl: discoveryBaseUrl,
					headers: buildAnthropicDiscoveryHeaders(apiKey),
					mapModel: (entry, defaults) => {
						const reference = references.get(defaults.id);
						const model = mapWithBundledReference(entry, defaults, reference);
						return {
							...model,
							name: toModelName(entry.display_name, model.name),
							baseUrl,
						};
					},
					fetch: config?.fetch,
				}),
		}),
	};
}
