import type { OpenAICompatibleModelRecord } from "../../discovery/openai-compatible";
import { canonicalizeEfforts, Effort, isEffort } from "../../effort";
import { FIREWORKS_FAST_SUFFIX } from "../../fireworks-model-id";
import { isGrokReasoningEffortCapable, isKimiModelId, isReasoningGlmModelId } from "../../identity/family";
import { ANTHROPIC_API_ENDPOINT } from "../../provider-endpoints";
import type { Api, ModelReasoningOptions, ModelSpec } from "../../types";
import { isRecord, toPositiveNumber } from "../../utils";
import { createBundledReferenceMap } from "../bundled-references";
import { mapWithBundledReference, toInputCapabilities } from "./helpers";

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
