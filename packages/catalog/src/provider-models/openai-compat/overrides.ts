import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { OpenAICompatibleModelRecord } from "../../discovery/openai-compatible";
import { canonicalizeEfforts, Effort, isEffort } from "../../effort";
import { FIREWORKS_FAST_SUFFIX } from "../../fireworks-model-id";
import { isGrokReasoningEffortCapable, isKimiModelId, isReasoningGlmModelId } from "../../identity/family";
import { ANTHROPIC_API_ENDPOINT } from "../../provider-endpoints";
import type {
	Api,
	FetchImpl,
	ModelReasoningOptions,
	ModelSpec,
	OpenAICompat,
	Provider,
	ThinkingConfig,
} from "../../types";
import { discoveryFetch, isRecord, toBoolean, toNumber, toPositiveNumber } from "../../utils";
import { createBundledReferenceMap } from "../bundled-references";
import { mapWithBundledReference, toInputCapabilities, withCatalogDiscoveryTimeout } from "./helpers";

export const ANTHROPIC_BASE_URL = `${ANTHROPIC_API_ENDPOINT}/v1`;
export const ANTHROPIC_OAUTH_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";

export const ANTHROPIC_CURATED_REASONING_OPTIONS: ModelReasoningOptions = {
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
};

export const ANTHROPIC_CURATED_FALLBACK_MODELS: readonly ModelSpec<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: ANTHROPIC_API_ENDPOINT,
		reasoning: true,
		reasoningOptions: ANTHROPIC_CURATED_REASONING_OPTIONS,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: ANTHROPIC_API_ENDPOINT,
		reasoning: true,
		reasoningOptions: ANTHROPIC_CURATED_REASONING_OPTIONS,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-mythos-5",
		name: "Claude Mythos 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: ANTHROPIC_API_ENDPOINT,
		reasoning: true,
		reasoningOptions: ANTHROPIC_CURATED_REASONING_OPTIONS,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

export const OLLAMA_FALLBACK_CONTEXT_WINDOW = 128_000;
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;

export const OPENAI_PRO_REASONING_BASE_IDS: Record<string, true> = {
	"gpt-5.6-luna": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
};

export const OPENAI_PRO_REASONING_SWEEP_PROVIDERS: Record<string, true> = { openai: true, "openai-codex": true };

export function isGeneratedOpenAIProReasoningAlias(model: ModelSpec<Api>): boolean {
	return (
		OPENAI_PRO_REASONING_SWEEP_PROVIDERS[model.provider] === true &&
		model.reasoningMode !== undefined &&
		model.id.endsWith("-pro") &&
		OPENAI_PRO_REASONING_BASE_IDS[model.id.slice(0, -"-pro".length)] === true
	);
}

export function projectOpenAIProReasoningAliases(models: readonly ModelSpec<Api>[]): ModelSpec<Api>[] {
	const kept = models.filter(model => !isGeneratedOpenAIProReasoningAlias(model));
	const ids = new Set(kept.map(model => `${model.provider}/${model.id}`));
	const out = kept.slice();
	for (const model of kept) {
		if (model.provider !== "openai") continue;
		if (!OPENAI_PRO_REASONING_BASE_IDS[model.id]) continue;
		const aliasId = `${model.id}-pro`;
		const aliasKey = `${model.provider}/${aliasId}`;
		if (ids.has(aliasKey)) continue;
		ids.add(aliasKey);
		out.push({
			...model,
			id: aliasId,
			name: `${model.name} Pro`,
			requestModelId: model.id,
			reasoningMode: "pro",
		});
	}
	return out;
}

export const UMANS_BASE_URL = "https://api.code.umans.ai";
export const UMANS_MODELS_INFO_PATH = "/models/info";
export const UMANS_REASONING_EFFORT_BY_LEVEL: Record<string, Effort> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};
export const UMANS_DEFAULT_REASONING_EFFORTS = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
] as const;
export const UMANS_VIA_HANDOFF_MODEL_IDS = ["umans-glm-5.1", "umans-glm-5.2"] as const;

export const CEREBRAS_IMAGE_INPUT_MODEL_IDS = new Set(["gemma-4-31b"]);

export function applyCerebrasDiscoveryOverrides(
	model: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	if (!CEREBRAS_IMAGE_INPUT_MODEL_IDS.has(model.id)) {
		return model;
	}
	return {
		...model,
		input: ["text", "image"],
	};
}

export function applyHuggingfaceProviderCapabilities(
	entry: OpenAICompatibleModelRecord,
	model: ModelSpec<"openai-completions">,
): ModelSpec<"openai-completions"> {
	if (!Array.isArray(entry.providers)) return model;
	const upstreams = entry.providers.filter(isRecord);
	if (upstreams.length === 0) return model;
	if (upstreams.every(upstream => upstream.supports_tools === false)) {
		return { ...model, supportsTools: false };
	}
	return model;
}

export interface XAICuratedModel {
	id: string;
	contextWindow: number;
	name?: string;
	reasoning?: boolean;
	supportsReasoningEffort?: boolean;
	input?: ("text" | "image")[];
}

export const XAI_OAUTH_CURATED_MODELS: readonly XAICuratedModel[] = [
	{
		id: "grok-build",
		contextWindow: 512_000,
		name: "Grok Build",
		input: ["text", "image"],
	},
	{
		id: "grok-build-0.1",
		contextWindow: 256_000,
		name: "Grok Build 0.1",
		input: ["text", "image"],
	},
	{ id: "grok-4.3", contextWindow: 1_000_000, name: "Grok 4.3", input: ["text", "image"] },
	{ id: "grok-4.5", contextWindow: 500_000, name: "Grok 4.5", input: ["text", "image"] },
	{ id: "grok-4.6", contextWindow: 500_000, name: "Grok 4.6", input: ["text", "image"] },
	{ id: "grok-4.20-multi-agent-0309", contextWindow: 2_000_000, name: "Grok 4.20 (Multi-Agent)" },
	{
		id: "grok-4.20-0309-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Reasoning)",
		supportsReasoningEffort: false,
		input: ["text", "image"],
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		contextWindow: 2_000_000,
		name: "Grok 4.20 (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
	},
	{
		id: "grok-composer-2.5-fast",
		contextWindow: 200_000,
		name: "Grok Composer 2.5 Fast",
		reasoning: false,
		input: ["text"],
	},
] as const;

export const XAI_NON_CHAT_PREFIXES = ["grok-imagine-", "grok-stt-", "grok-voice-"] as const;

export const XAI_REASONING_EFFORT_MAP = { minimal: "low" } as const;

export function withXaiOAuthCompatDefaults(model: ModelSpec<"openai-responses">): ModelSpec<"openai-responses"> {
	const compat = {
		...(model.compat ?? {}),
		includeEncryptedReasoning: model.compat?.includeEncryptedReasoning ?? false,
		filterReasoningHistory: model.compat?.filterReasoningHistory ?? true,
		supportsImageDetailOriginal: model.compat?.supportsImageDetailOriginal ?? false,
		omitReasoningEffort: model.compat?.omitReasoningEffort ?? !isGrokReasoningEffortCapable(model.id),
	};
	return { ...model, compat };
}

export function mergeCuratedIntoModel(
	base: ModelSpec<"openai-responses">,
	curated: XAICuratedModel,
): ModelSpec<"openai-responses"> {
	const effortCapable = curated.supportsReasoningEffort ?? isGrokReasoningEffortCapable(curated.id);
	const compat = {
		...(base.compat ?? {}),
		reasoningEffortMap: { ...XAI_REASONING_EFFORT_MAP, ...(base.compat?.reasoningEffortMap ?? {}) },
		includeEncryptedReasoning: base.compat?.includeEncryptedReasoning ?? false,
		filterReasoningHistory: base.compat?.filterReasoningHistory ?? true,
		supportsImageDetailOriginal: base.compat?.supportsImageDetailOriginal ?? false,
		omitReasoningEffort: !effortCapable,
		supportsReasoningEffort: effortCapable,
	};
	return {
		...base,
		contextWindow: curated.contextWindow,
		maxTokens: curated.contextWindow,
		name: curated.name ?? base.name,
		reasoning: curated.reasoning ?? true,
		input: curated.input ?? base.input,
		compat,
	};
}

export function applyXAIOAuthCuration(
	dynamic: readonly ModelSpec<"openai-responses">[],
): ModelSpec<"openai-responses">[] {
	const filtered = dynamic.filter(e => !XAI_NON_CHAT_PREFIXES.some(p => e.id.startsWith(p)));

	const byId = new Map<string, ModelSpec<"openai-responses">>(filtered.map(e => [e.id, e]));
	for (const curated of XAI_OAUTH_CURATED_MODELS) {
		const existing = byId.get(curated.id);
		if (existing) {
			byId.set(curated.id, mergeCuratedIntoModel(existing, curated));
		}
	}

	const template = filtered[0];
	if (template) {
		for (const curated of XAI_OAUTH_CURATED_MODELS) {
			if (!byId.has(curated.id)) {
				const base: ModelSpec<"openai-responses"> = { ...template, id: curated.id, name: curated.id };
				byId.set(curated.id, mergeCuratedIntoModel(base, curated));
			}
		}
	}

	const curatedIds = new Set(XAI_OAUTH_CURATED_MODELS.map(c => c.id));
	const curatedFirst = XAI_OAUTH_CURATED_MODELS.map(c => byId.get(c.id)).filter(
		(e): e is ModelSpec<"openai-responses"> => e !== undefined,
	);
	const rest = filtered.filter(e => !curatedIds.has(e.id)).map(withXaiOAuthCompatDefaults);
	return curatedFirst.concat(rest);
}

export function buildXaiOAuthStaticSeed(baseUrl?: string): ModelSpec<"openai-responses">[] {
	const resolvedBaseUrl = baseUrl ?? "https://api.x.ai/v1";
	return XAI_OAUTH_CURATED_MODELS.map(curated => {
		const base: ModelSpec<"openai-responses"> = {
			id: curated.id,
			name: curated.id,
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: resolvedBaseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: curated.contextWindow,
			maxTokens: curated.contextWindow,
			compat: { reasoningEffortMap: XAI_REASONING_EFFORT_MAP },
		};
		return mergeCuratedIntoModel(base, curated);
	});
}

export const FIREWORKS_KIMI_MAX_TOKENS = 32_768;

export function isFireworksKimiK2ModelId(modelId: string): boolean {
	const trimmed = modelId.toLowerCase();
	if (trimmed.startsWith("kimi-k2")) return true;
	return /\/kimi-k2(?:p\d+)?(?:[._-]|$)/.test(trimmed);
}

export function clampFireworksKimiMaxTokens(modelId: string, candidate: number): number;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampFireworksKimiMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isFireworksKimiK2ModelId(modelId) ? Math.min(candidate, FIREWORKS_KIMI_MAX_TOKENS) : candidate;
}

export const KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS = 32_768;

export function isKimiK27CodeModelId(modelId: string): boolean {
	return /(?:^|\/)kimi[-._]?k2(?:[._-]?|p)7[-._]?code(?:[-._]?highspeed)?$/i.test(modelId);
}

export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number): number;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null;
export function clampKimiK27CodeMaxTokens(modelId: string, candidate: number | null): number | null {
	if (candidate === null) return null;
	return isKimiK27CodeModelId(modelId) ? Math.min(candidate, KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS) : candidate;
}

export const FIREWORKS_FAST_VARIANT_SPECS: ReadonlyArray<{
	base: string;
	name: string;
	cost: { input: number; output: number; cacheRead: number };
}> = [
	{ base: "kimi-k2.7-code", name: "Kimi K2.7 Code Fast", cost: { input: 1.9, output: 8, cacheRead: 0.38 } },
	{ base: "kimi-k2.6", name: "Kimi K2.6 Fast", cost: { input: 2, output: 8, cacheRead: 0.3 } },
	{ base: "glm-5.1", name: "GLM-5.1 Fast", cost: { input: 2.8, output: 8.8, cacheRead: 0.52 } },
];

export function buildFireworksFastSeed(): ModelSpec<"openai-completions">[] {
	const bundled = createBundledReferenceMap<"openai-completions">("fireworks");
	const seeds: ModelSpec<"openai-completions">[] = [];
	for (const variant of FIREWORKS_FAST_VARIANT_SPECS) {
		const base = bundled.get(variant.base);
		if (!base) continue;
		seeds.push({
			...base,
			id: `${variant.base}${FIREWORKS_FAST_SUFFIX}`,
			name: variant.name,
			cost: {
				input: variant.cost.input,
				output: variant.cost.output,
				cacheRead: variant.cost.cacheRead,
				cacheWrite: 0,
			},
		});
	}
	return seeds;
}

export function stripFireworksDeepSeekThinkingToggle(
	model: ModelSpec<"openai-completions">,
	publicModelId: string,
): ModelSpec<"openai-completions"> {
	if (!publicModelId.startsWith("deepseek-v4")) return model;
	const compat = model.compat;
	if (!compat?.extraBody || !("thinking" in compat.extraBody)) return model;

	const extraBody = { ...compat.extraBody };
	delete extraBody.thinking;
	if (Object.keys(extraBody).length > 0) {
		return { ...model, compat: { ...compat, extraBody } };
	}

	const nextCompat = { ...compat };
	delete nextCompat.extraBody;
	return { ...model, compat: nextCompat };
}

export const WAFER_DEFAULT_BASE_URL = "https://pass.wafer.ai/v1";
export const WAFER_MAX_TOKENS_CAP = 65536;

export type WaferThinkingFormat = "zai" | "qwen";

export function resolveWaferServerlessThinkingFormat(
	modelId: string,
	upstreamProvider: unknown,
): WaferThinkingFormat | undefined {
	const upstream = typeof upstreamProvider === "string" ? upstreamProvider.trim().toLowerCase() : "";
	if (upstream) {
		if (
			upstream === "zai" ||
			upstream === "z.ai" ||
			upstream === "z-ai" ||
			upstream.includes("zhipu") ||
			upstream.includes("moonshot") ||
			upstream.includes("kimi")
		) {
			return "zai";
		}
		if (upstream.includes("qwen") || upstream.includes("alibaba") || upstream.includes("dashscope")) {
			return "qwen";
		}
		return undefined;
	}

	return isReasoningGlmModelId(modelId.toLowerCase()) || isKimiModelId(modelId) ? "zai" : undefined;
}

export const COMMAND_CODE_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "moonshotai/Kimi-K2.7-Code",
		name: "Kimi K2.7 Code",
		api: "openai-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: null,
	},
	{
		id: "zai-org/GLM-5.3",
		name: "GLM-5.3",
		api: "openai-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: null,
	},
	{
		id: "MiniMaxAI/MiniMax-M3",
		name: "MiniMax M3",
		api: "openai-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: null,
	},
];

export const NOUS_RESEARCH_BASE_URL = "https://inference-api.nousresearch.com/v1";

export const NOUS_RESEARCH_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	{
		id: "anthropic/claude-sonnet-4.6",
		name: "Anthropic: Claude Sonnet 4.6",
		api: "openai-completions",
		provider: "nous-research",
		baseUrl: NOUS_RESEARCH_BASE_URL,
		reasoning: true,
		input: ["text"],
		supportsTools: true,
		compat: { supportsToolChoice: false },
		cost: { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 },
		pricing: "published",
		contextWindow: 1000000,
		maxTokens: null,
	},
];

export const NOUS_RESEARCH_BUNDLED_MODELS = NOUS_RESEARCH_STATIC_MODELS;

export function isNousToolCapableChatModel(entry: OpenAICompatibleModelRecord): boolean {
	const parameters = Array.isArray(entry.supported_parameters)
		? entry.supported_parameters.filter((value): value is string => typeof value === "string")
		: [];
	if (!parameters.includes("tools")) {
		return false;
	}
	const architecture = isRecord(entry.architecture) ? entry.architecture : {};
	const outputModalities = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
	if (outputModalities.length > 0) {
		return outputModalities.includes("text");
	}
	const modality = typeof architecture.modality === "string" ? architecture.modality : "";
	return modality.length === 0 || modality.split("->").at(-1) === "text";
}

export function mapNousResearchModel(
	entry: OpenAICompatibleModelRecord,
	defaults: ModelSpec<"openai-completions">,
	reference: ModelSpec<"openai-completions"> | undefined,
): ModelSpec<"openai-completions"> {
	const baseModel = mapWithBundledReference(entry, defaults, reference);
	const parameters = Array.isArray(entry.supported_parameters)
		? entry.supported_parameters.filter((value): value is string => typeof value === "string")
		: [];
	const architecture = isRecord(entry.architecture) ? entry.architecture : {};
	const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const reasoningMetadata = isRecord(entry.reasoning) ? entry.reasoning : undefined;
	const reasoning =
		parameters.includes("reasoning") ||
		parameters.includes("reasoning_effort") ||
		parameters.includes("include_reasoning") ||
		reasoningMetadata !== undefined;
	const efforts = Array.isArray(reasoningMetadata?.supported_efforts)
		? reasoningMetadata.supported_efforts.filter((value): value is Effort => isEffort(value))
		: [];
	const inputModalities = Array.isArray(architecture.input_modalities)
		? architecture.input_modalities
		: typeof architecture.modality === "string" && architecture.modality.includes("image")
			? ["text", "image"]
			: ["text"];

	return {
		...baseModel,
		reasoning,
		...(reasoning && efforts.length > 0
			? { reasoningOptions: { efforts: canonicalizeEfforts(efforts) } }
			: { reasoningOptions: undefined }),
		input: toInputCapabilities(inputModalities),
		supportsTools: true,
		cost: {
			input: toPositiveNumber(pricing?.prompt, 0) * 1000000,
			output: toPositiveNumber(pricing?.completion, 0) * 1000000,
			cacheRead: toPositiveNumber(pricing?.input_cache_read, 0) * 1000000,
			cacheWrite: toPositiveNumber(pricing?.input_cache_write, 0) * 1000000,
		},
		pricing: pricing ? "published" : "unknown",
		contextWindow: toPositiveNumber(
			topProvider?.context_length,
			toPositiveNumber(entry.context_length, baseModel.contextWindow),
		),
		maxTokens: toPositiveNumber(topProvider?.max_completion_tokens, null),
		compat: {
			...(baseModel.compat ?? {}),
			supportsToolChoice: parameters.includes("tool_choice"),
		},
	};
}

export const SAKANA_DEFAULT_BASE_URL = "https://api.sakana.ai/v1";
export const SAKANA_FREE_ROUTER_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const SAKANA_FUGU_ULTRA_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } as const;
export const SAKANA_FUGU_ULTRA_CONTEXT_WINDOW = 1_000_000;
export const SAKANA_FUGU_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.Max],
};
export const SAKANA_RESPONSES_COMPAT: ModelSpec<"openai-responses">["compat"] = {
	includeEncryptedReasoning: false,
	streamIdleTimeoutMs: 0,
};

export function normalizeSakanaBaseUrl(baseUrl: string | undefined): string {
	const value = baseUrl?.trim() || SAKANA_DEFAULT_BASE_URL;
	const normalized = trimTrailingSlashes(value);
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function isSakanaFuguModelId(modelId: string): boolean {
	return /^fugu(?:$|-)/i.test(modelId);
}

export function createSakanaFuguStaticModel(
	id: string,
	name: string,
	cost: ModelSpec<"openai-responses">["cost"],
	contextWindow: number | null,
): ModelSpec<"openai-responses"> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "sakana",
		baseUrl: SAKANA_DEFAULT_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { ...cost },
		contextWindow,
		maxTokens: null,
		thinking: { ...SAKANA_FUGU_THINKING },
		compat: { ...SAKANA_RESPONSES_COMPAT },
	};
}

export const SAKANA_FUGU_STATIC_MODELS: readonly ModelSpec<"openai-responses">[] = [
	createSakanaFuguStaticModel("fugu", "Fugu", SAKANA_FREE_ROUTER_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel("fugu-ultra", "Fugu Ultra", SAKANA_FUGU_ULTRA_COST, SAKANA_FUGU_ULTRA_CONTEXT_WINDOW),
	createSakanaFuguStaticModel(
		"fugu-ultra-20260615",
		"Fugu Ultra 20260615",
		SAKANA_FUGU_ULTRA_COST,
		SAKANA_FUGU_ULTRA_CONTEXT_WINDOW,
	),
];

export const SAKANA_FUGU_STATIC_MODEL_BY_ID = new Map(
	SAKANA_FUGU_STATIC_MODELS.map(model => [model.id, model] as const),
);
export const SAKANA_FUGU_STATIC_MODEL_IDS = SAKANA_FUGU_STATIC_MODELS.map(model => model.id);

export type XiaomiTokenPlanRegion = "sgp" | "ams" | "cn";

export const XIAOMI_TOKEN_PLAN_BASE_URLS: Record<XiaomiTokenPlanRegion, string> = {
	sgp: "https://token-plan-sgp.xiaomimimo.com/v1",
	ams: "https://token-plan-ams.xiaomimimo.com/v1",
	cn: "https://token-plan-cn.xiaomimimo.com/v1",
};

export const XIAOMI_TOKEN_PLAN_FALLBACK_BASE_URLS = [
	XIAOMI_TOKEN_PLAN_BASE_URLS.sgp,
	XIAOMI_TOKEN_PLAN_BASE_URLS.ams,
	XIAOMI_TOKEN_PLAN_BASE_URLS.cn,
];

export const ZENMUX_OPENAI_BASE_URL = "https://zenmux.ai/api/v1";
export const ZENMUX_ANTHROPIC_BASE_URL = "https://zenmux.ai/api/anthropic";

export function normalizeZenMuxOpenAiBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return ZENMUX_OPENAI_BASE_URL;
	}
	const normalized = trimTrailingSlashes(value);
	if (normalized.endsWith("/api/anthropic")) {
		return normalized.replace("/api/anthropic", "/api/v1");
	}
	return normalized;
}

export function toZenMuxAnthropicBaseUrl(openAiBaseUrl: string): string {
	try {
		const parsed = new URL(openAiBaseUrl);
		const trimmedPath = trimTrailingSlashes(parsed.pathname);
		parsed.pathname = trimmedPath.endsWith("/api/v1")
			? `${trimmedPath.slice(0, -"/api/v1".length)}/api/anthropic`
			: "/api/anthropic";
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return ZENMUX_ANTHROPIC_BASE_URL;
	}
}

export function isZenMuxAnthropicModel(entry: OpenAICompatibleModelRecord, modelId: string): boolean {
	if (typeof entry.owned_by === "string" && entry.owned_by.toLowerCase() === "anthropic") {
		return true;
	}
	return modelId.toLowerCase().startsWith("anthropic/");
}

export function getZenMuxPricingValue(pricings: Record<string, unknown> | undefined, key: string): number {
	const bucket = pricings?.[key];
	if (!Array.isArray(bucket)) {
		return 0;
	}
	for (const item of bucket) {
		if (!isRecord(item)) {
			continue;
		}
		const value = toNumber(item.value);
		if (value !== undefined) {
			return value;
		}
	}
	return 0;
}

export function getZenMuxCacheWritePrice(pricings: Record<string, unknown> | undefined): number {
	const oneHour = getZenMuxPricingValue(pricings, "input_cache_write_1_h");
	if (oneHour > 0) {
		return oneHour;
	}
	const fiveMinute = getZenMuxPricingValue(pricings, "input_cache_write_5_min");
	if (fiveMinute > 0) {
		return fiveMinute;
	}
	return getZenMuxPricingValue(pricings, "input_cache_write");
}

export interface FetchLiteLLMRichModelsOptions<TApi extends Api> {
	api: TApi;
	provider: Provider;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	referenceResolver?: (modelId: string) => ModelSpec<TApi> | undefined;
}

export type LiteLLMRichModelEntry = Record<string, unknown>;
export type LiteLLMRichEndpointModel<TApi extends Api> = {
	model: ModelSpec<TApi>;
	supportsVision: unknown;
	supportsReasoning: unknown;
	hasContextWindow: boolean;
	hasMaxTokens: boolean;
	hasToolMetadata: boolean;
	hasSupportedOpenAIParams: boolean;
};

export const LITELLM_RICH_ENDPOINTS = ["/model_group/info", "/v2/model/info", "/model/info", "/v1/model/info"] as const;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW = 128_000;
export const OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS = 32_768;
export const UNKNOWN_PROXY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
export const LITELLM_UNUSABLE_SENTINEL_IDS: Record<string, true> = {
	"all-team-models": true,
	"all-proxy-models": true,
	"no-default-models": true,
};

export function normalizeLiteLLMManagementBaseUrl(baseUrl: string): string {
	const trimmed = trimTrailingSlashes(baseUrl.trim());
	if (!trimmed) {
		return "";
	}
	try {
		const parsed = new URL(trimmed);
		const path = trimTrailingSlashes(parsed.pathname);
		parsed.pathname = path.endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
		const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		return trimTrailingSlashes(normalized);
	} catch {
		return trimmed.replace(/\/v1$/, "");
	}
}

export function normalizeLiteLLMRuntimeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	return trimTrailingSlashes(trimmed);
}

const LITELLM_RESELLER_USAGE_SUFFIX = /\s+\(\d+(?:\.\d+)?[x×] usage\)$/i;

export function stripLiteLLMResellerUsageSuffix(name: string): string {
	const cleaned = name.replace(LITELLM_RESELLER_USAGE_SUFFIX, "").trim();
	return cleaned.length > 0 ? cleaned : name;
}

export function toLiteLLMDisplayName(
	modelName: string | undefined,
	referenceName: string | undefined,
	id: string,
): string {
	const cleanedModelName = modelName ? stripLiteLLMResellerUsageSuffix(modelName) : undefined;
	if (cleanedModelName && cleanedModelName !== id) {
		return cleanedModelName;
	}
	return referenceName ? stripLiteLLMResellerUsageSuffix(referenceName) : id;
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function extractLiteLLMRichEntries(payload: unknown): LiteLLMRichModelEntry[] | null {
	if (Array.isArray(payload)) {
		return payload.flatMap(entry => (isRecord(entry) ? [entry] : []));
	}
	if (!isRecord(payload)) {
		return null;
	}
	for (const candidate of [payload.data, payload.models, payload.result, payload.items]) {
		if (candidate === undefined) {
			continue;
		}
		const entries = extractLiteLLMRichEntries(candidate);
		if (entries !== null) {
			return entries;
		}
	}
	return null;
}

export function getLiteLLMModelInfo(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.model_info) ? entry.model_info : undefined;
}

export function getLiteLLMParams(entry: LiteLLMRichModelEntry): LiteLLMRichModelEntry | undefined {
	return isRecord(entry.litellm_params) ? entry.litellm_params : undefined;
}

export function getLiteLLMMetadataValue(entry: LiteLLMRichModelEntry, key: string): unknown {
	return entry[key] ?? getLiteLLMModelInfo(entry)?.[key];
}

export function getLiteLLMRichModelId(entry: LiteLLMRichModelEntry): string | undefined {
	return (
		toNonEmptyString(entry.model_group) ??
		toNonEmptyString(entry.model_name) ??
		toNonEmptyString(entry.id) ??
		toNonEmptyString(getLiteLLMParams(entry)?.model)
	);
}

export function getSupportedOpenAIParams(entry: LiteLLMRichModelEntry): string[] | undefined {
	const value = getLiteLLMMetadataValue(entry, "supported_openai_params");
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.flatMap(item => (typeof item === "string" ? [item] : []));
}

export function isLiteLLMUnusableSentinelPlaceholder(entry: LiteLLMRichModelEntry): boolean {
	const modelGroup = toNonEmptyString(entry.model_group);
	const id = toNonEmptyString(entry.id);
	if (
		(modelGroup === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[modelGroup] !== true) &&
		(id === undefined || LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true)
	) {
		return false;
	}
	const providers = entry.providers;
	if (providers !== undefined && (!Array.isArray(providers) || providers.length > 0)) {
		return false;
	}
	const modelName = toNonEmptyString(entry.model_name);
	if (modelName && LITELLM_UNUSABLE_SENTINEL_IDS[modelName] !== true) {
		return false;
	}
	if (id && LITELLM_UNUSABLE_SENTINEL_IDS[id] !== true) {
		return false;
	}
	const backendModel = toNonEmptyString(getLiteLLMParams(entry)?.model);
	if (backendModel && LITELLM_UNUSABLE_SENTINEL_IDS[backendModel] !== true) {
		return false;
	}
	if (
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null ||
		toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null
	) {
		return false;
	}
	if (
		getLiteLLMMetadataValue(entry, "supports_vision") === true ||
		getLiteLLMMetadataValue(entry, "supports_reasoning") === true ||
		getLiteLLMMetadataValue(entry, "supports_function_calling") === true ||
		getLiteLLMMetadataValue(entry, "supports_tools") === true
	) {
		return false;
	}
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	if (supportedOpenAIParams && supportedOpenAIParams.length > 0) {
		return false;
	}
	return true;
}

export function mapLiteLLMRichEntry<TApi extends Api>(
	entry: LiteLLMRichModelEntry,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	runtimeBaseUrl: string,
): ModelSpec<TApi> | null {
	if (isLiteLLMUnusableSentinelPlaceholder(entry)) {
		return null;
	}
	const id = getLiteLLMRichModelId(entry);
	if (!id) {
		return null;
	}
	const reference = options.referenceResolver?.(id);
	const modelName = toNonEmptyString(entry.model_name);
	const contextWindow = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_input_tokens"),
		reference?.contextWindow ?? OPENAI_COMPAT_DISCOVERY_DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = toPositiveNumber(
		getLiteLLMMetadataValue(entry, "max_output_tokens"),
		reference?.maxTokens ?? Math.min(contextWindow, OPENAI_COMPAT_DISCOVERY_DEFAULT_MAX_TOKENS),
	);
	const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
	const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
	const supportedOpenAIParams = getSupportedOpenAIParams(entry);
	const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
	const supportsTools =
		supportsFunctionCalling === true
			? true
			: supportsFunctionCalling === false
				? false
				: supportedOpenAIParams !== undefined
					? supportedOpenAIParams.some(param =>
							["tools", "tool_choice", "functions", "function_call"].includes(param),
						)
					: reference?.supportsTools;
	const compat: OpenAICompat = {
		...(reference?.compat ?? {}),
		supportsStore: false,
		supportsDeveloperRole: false,
		...(supportedOpenAIParams !== undefined
			? { supportsReasoningEffort: supportedOpenAIParams.includes("reasoning_effort") }
			: {}),
	};
	return {
		id,
		name: toLiteLLMDisplayName(modelName, reference?.name, id),
		api: options.api,
		provider: options.provider,
		baseUrl: runtimeBaseUrl,
		contextWindow,
		maxTokens,
		input:
			supportsVision === true
				? ["text", "image"]
				: supportsVision === false
					? ["text"]
					: (reference?.input ?? ["text"]),
		reasoning: typeof supportsReasoning === "boolean" ? supportsReasoning : (reference?.reasoning ?? false),
		thinking: reference?.thinking,
		cost: reference?.cost ?? UNKNOWN_PROXY_COST,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		compat: compat as ModelSpec<TApi>["compat"],
	};
}

export async function fetchLiteLLMRichEndpoint<TApi extends Api>(
	endpoint: string,
	options: FetchLiteLLMRichModelsOptions<TApi>,
	managementBaseUrl: string,
	runtimeBaseUrl: string,
	signal?: AbortSignal,
): Promise<{ models: LiteLLMRichEndpointModel<TApi>[]; incompleteVisionMetadata: boolean } | null> {
	const fetchImpl = discoveryFetch(options.fetch);
	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
		...options.headers,
	};
	if (options.apiKey) {
		requestHeaders.Authorization = `Bearer ${options.apiKey}`;
	}
	let response: Response;
	try {
		response = await fetchImpl(`${managementBaseUrl}${endpoint}`, {
			method: "GET",
			headers: requestHeaders,
			signal,
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		return null;
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	const entries = extractLiteLLMRichEntries(payload);
	if (!entries || entries.length === 0) {
		return null;
	}
	const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
	let incompleteVisionMetadata = false;
	for (const entry of entries) {
		const model = mapLiteLLMRichEntry(entry, options, runtimeBaseUrl);
		if (model) {
			const supportsVision = getLiteLLMMetadataValue(entry, "supports_vision");
			const supportsReasoning = getLiteLLMMetadataValue(entry, "supports_reasoning");
			const supportsFunctionCalling = getLiteLLMMetadataValue(entry, "supports_function_calling");
			const supportedOpenAIParams = getSupportedOpenAIParams(entry);
			if (supportsVision !== true && supportsVision !== false) {
				incompleteVisionMetadata = true;
			}
			deduped.set(model.id, {
				model,
				supportsVision,
				supportsReasoning,
				hasContextWindow: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_input_tokens"), null) !== null,
				hasMaxTokens: toPositiveNumber(getLiteLLMMetadataValue(entry, "max_output_tokens"), null) !== null,
				hasToolMetadata:
					supportsFunctionCalling === true ||
					supportsFunctionCalling === false ||
					supportedOpenAIParams !== undefined,
				hasSupportedOpenAIParams: supportedOpenAIParams !== undefined,
			});
		}
	}
	if (deduped.size === 0) {
		return null;
	}
	return {
		models: Array.from(deduped.values()).sort((left, right) => left.model.id.localeCompare(right.model.id)),
		incompleteVisionMetadata,
	};
}

export async function fetchLiteLLMRichModels<TApi extends Api>(
	options: FetchLiteLLMRichModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const managementBaseUrl = normalizeLiteLLMManagementBaseUrl(options.baseUrl);
	const runtimeBaseUrl = normalizeLiteLLMRuntimeBaseUrl(options.baseUrl);
	if (!managementBaseUrl || !runtimeBaseUrl) {
		return null;
	}
	const fetchModels = async (signal?: AbortSignal): Promise<ModelSpec<TApi>[] | null> => {
		const deduped = new Map<string, LiteLLMRichEndpointModel<TApi>>();
		for (const endpoint of LITELLM_RICH_ENDPOINTS) {
			const result = await fetchLiteLLMRichEndpoint(endpoint, options, managementBaseUrl, runtimeBaseUrl, signal);
			if (!result) {
				continue;
			}
			const hadPriorModels = deduped.size > 0;
			for (const next of result.models) {
				const existing = deduped.get(next.model.id);
				if (!existing) {
					if (!hadPriorModels) {
						deduped.set(next.model.id, next);
					}
					continue;
				}
				const model: ModelSpec<TApi> = {
					...existing.model,
					name: next.model.name === next.model.id ? existing.model.name : next.model.name,
					contextWindow: next.hasContextWindow ? next.model.contextWindow : existing.model.contextWindow,
					maxTokens: next.hasMaxTokens ? next.model.maxTokens : existing.model.maxTokens,
					input:
						next.supportsVision === true || next.supportsVision === false
							? next.model.input
							: existing.model.input,
					reasoning: typeof next.supportsReasoning === "boolean" ? next.model.reasoning : existing.model.reasoning,
					compat: next.hasSupportedOpenAIParams ? next.model.compat : existing.model.compat,
				};
				if (next.hasToolMetadata) {
					model.supportsTools = next.model.supportsTools;
				}
				deduped.set(next.model.id, { ...next, model });
			}
			let hasIncompleteVisionMetadata = false;
			for (const entry of deduped.values()) {
				if (entry.supportsVision !== true && entry.supportsVision !== false) {
					hasIncompleteVisionMetadata = true;
					break;
				}
			}
			if (!hasIncompleteVisionMetadata) {
				break;
			}
		}
		if (deduped.size === 0) {
			return null;
		}
		return Array.from(deduped.values())
			.map(entry => entry.model)
			.sort((left, right) => left.id.localeCompare(right.id));
	};
	if (options.signal !== undefined) {
		return fetchModels(options.signal);
	}
	return options.timeoutMs !== undefined ? withCatalogDiscoveryTimeout(options.timeoutMs, fetchModels) : fetchModels();
}

export const COPILOT_ANTHROPIC_MODEL_PATTERN = /^claude-(haiku|sonnet|opus|fable|mythos)-\d/;
export const isCopilotResponsesModelId = (modelId: string): boolean =>
	modelId.startsWith("gpt-5") || modelId.startsWith("oswe");

export function inferCopilotApi(modelId: string): Api {
	if (COPILOT_ANTHROPIC_MODEL_PATTERN.test(modelId)) {
		return "anthropic-messages";
	}
	if (isCopilotResponsesModelId(modelId)) {
		return "openai-responses";
	}
	return "openai-completions";
}

export function extractCopilotLimits(entry: OpenAICompatibleModelRecord): {
	maxPromptTokens?: number;
	maxContextWindowTokens?: number;
	maxOutputTokens?: number;
	maxNonStreamingOutputTokens?: number;
} {
	if (!isRecord(entry.capabilities)) {
		return {};
	}
	const limitsValue = entry.capabilities.limits;
	if (!isRecord(limitsValue)) {
		return {};
	}
	return {
		maxPromptTokens: toNumber(limitsValue.max_prompt_tokens),
		maxContextWindowTokens: toNumber(limitsValue.max_context_window_tokens),
		maxOutputTokens: toNumber(limitsValue.max_output_tokens),
		maxNonStreamingOutputTokens: toNumber(limitsValue.max_non_streaming_output_tokens),
	};
}

export const COPILOT_LONG_CONTEXT_ID_SUFFIX = "-1m";
export const COPILOT_LONG_CONTEXT_NAME_SUFFIX = " (1M)";

export interface CopilotTokenPriceTier {
	contextMax?: number;
	inputPrice?: number;
	outputPrice?: number;
	cachePrice?: number;
}

export function parseCopilotTokenPriceTier(value: unknown): CopilotTokenPriceTier | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		contextMax: toNumber(value.context_max),
		inputPrice: toNumber(value.input_price),
		outputPrice: toNumber(value.output_price),
		cachePrice: toNumber(value.cache_price),
	};
}

export function extractCopilotTokenPrices(entry: OpenAICompatibleModelRecord): {
	defaultTier?: CopilotTokenPriceTier;
	longContext?: CopilotTokenPriceTier;
} {
	if (!isRecord(entry.billing)) {
		return {};
	}
	const tokenPrices = entry.billing.token_prices;
	if (!isRecord(tokenPrices)) {
		return {};
	}
	return {
		defaultTier: parseCopilotTokenPriceTier(tokenPrices.default),
		longContext: parseCopilotTokenPriceTier(tokenPrices.long_context),
	};
}

export function extractCopilotSupportsVision(entry: OpenAICompatibleModelRecord): boolean | undefined {
	if (!isRecord(entry.capabilities)) {
		return undefined;
	}
	const supports = entry.capabilities.supports;
	if (!isRecord(supports)) {
		return undefined;
	}
	return toBoolean(supports.vision);
}

export function isCopilotChatModel(entry: OpenAICompatibleModelRecord): boolean {
	if (!isRecord(entry.capabilities)) {
		return true;
	}
	const type = entry.capabilities.type;
	return typeof type !== "string" || type === "chat";
}

export function copilotTierCost(
	tier: CopilotTokenPriceTier | undefined,
): Omit<ModelSpec<Api>["cost"], "cacheWrite"> | undefined {
	if (tier?.inputPrice === undefined || tier.outputPrice === undefined) {
		return undefined;
	}
	return {
		input: tier.inputPrice / 100,
		output: tier.outputPrice / 100,
		cacheRead: (tier.cachePrice ?? 0) / 100,
	};
}

export function createCopilotLongContextVariant(
	base: ModelSpec<Api>,
	fullContextWindow: number | null,
	maxTokens: number | null,
	longContext: CopilotTokenPriceTier | undefined,
): ModelSpec<Api> | undefined {
	const longContextMax = longContext?.contextMax;
	if (longContextMax === undefined || longContextMax <= 0 || fullContextWindow === null || maxTokens === null) {
		return undefined;
	}
	const variantWindow = Math.min(fullContextWindow, longContextMax + maxTokens);
	if (base.contextWindow === null || variantWindow <= base.contextWindow) {
		return undefined;
	}
	const longCost = copilotTierCost(longContext);
	return {
		...base,
		id: `${base.id}${COPILOT_LONG_CONTEXT_ID_SUFFIX}`,
		requestModelId: base.id,
		name: `${base.name}${COPILOT_LONG_CONTEXT_NAME_SUFFIX}`,
		contextWindow: variantWindow,
		...(longCost && { cost: { ...longCost, cacheWrite: base.cost.cacheWrite } }),
		contextPromotionTarget: undefined,
	};
}
