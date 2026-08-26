/**
 * Model-family ID predicates for wire-level compatibility and capability gating
 * across hosts and providers.
 */

import {
	bareModelId,
	isAnthropicAdaptiveGenAtLeast,
	isFableOrMythos,
	parseAnthropicModel,
	parseGlmModel,
	parseKnownModel,
	parseOpenAIModel,
	semverGte,
} from "./classify";

/** Bounded process-lifetime cache memo helper. */
function memo<T>(fn: (modelId: string) => T): (modelId: string) => T {
	const cache = new Map<string, T>();
	return (modelId: string) => {
		if (cache.has(modelId)) {
			return cache.get(modelId) as T;
		}
		const result = fn(modelId);
		cache.set(modelId, result);
		return result;
	};
}

/** Kimi family ids in any namespace form (`moonshotai/kimi-*`, `kimi-k2.6`, `vendor/kimi.x`). */
export const isKimiModelId = memo((modelId: string): boolean => {
	return modelId.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(modelId);
});

/** Kimi K2.6 specifically, including router ids that spell the version `k2p6`. */
export const isKimiK26ModelId = memo((modelId: string): boolean => {
	return /(^|\/)kimi-k2(?:\.6|p6)(?:[-:]|$)/i.test(modelId);
});

/**
 * Claude IDs in any namespace form (bare, path-namespaced, or Bedrock dot-prefixed
 * cross-region inference profiles).
 */
export const isClaudeModelId = memo((modelId: string): boolean => {
	return /(^|[/.])claude[-.]/i.test(modelId);
});

/** `anthropic/`-namespaced ids (aggregator catalogs like OpenRouter). */
export const isAnthropicNamespacedModelId = memo((modelId: string): boolean => {
	return /(^|\/)anthropic\//i.test(modelId);
});

/** Qwen family ids (substring match — Qwen SKUs have no stable prefix shape). */
export const isQwenModelId = memo((modelId: string): boolean => {
	return modelId.toLowerCase().includes("qwen");
});

/** Gemma open-weights family (`gemma-3-27b-it`, `google/gemma-4-E2B-it`, `gemma2-9b`). */
export const isGemmaModelId = memo((modelId: string): boolean => {
	return /(^|\/)gemma[-.]?\d/i.test(modelId);
});

/** DeepSeek family by id or display name (proxies often rename the id but keep the name). */
export const isDeepseekModelIdOrName = memo((value: string): boolean => {
	return value.toLowerCase().includes("deepseek");
});

/** Xiaomi MiMo family by id or display name. */
export const isMimoModelIdOrName = memo((value: string): boolean => {
	return value.toLowerCase().includes("mimo");
});

/**
 * OpenAI o-series models (o1/o3/o4, variants, snapshots).
 * Used by catalog generators to ensure reasoning capability is enabled.
 */
export const isOpenAIOSeriesModelId = memo((modelId: string): boolean => {
	const bare = bareModelId(modelId).trim().toLowerCase();
	return /^o[134](-|$)/.test(bare);
});

const GROK_EFFORT_CAPABLE_PREFIXES = [
	"grok-3-mini",
	"grok-4.20-multi-agent",
	"grok-4.3",
	"grok-4.5",
	// models.dev's xai declaration lists an effort ladder for grok-4.6 on the
	// same host the OAuth surface talks to.
	"grok-4.6",
	"grok-build",
] as const;

/**
 * Grok SKUs that expose the wire `reasoning.effort` dial. Other Grok reasoners
 * (e.g. `grok-4.20-0309-reasoning`) think natively but reject the param, so
 * callers must omit reasoning effort for them.
 */
export const isGrokReasoningEffortCapable = memo((modelId: string): boolean => {
	const bare = bareModelId(modelId).trim().toLowerCase();
	if (!bare) return false;
	return GROK_EFFORT_CAPABLE_PREFIXES.some(prefix => bare.startsWith(prefix));
});

/**
 * MiniMax M2-generation family (M2, M2.1, M2.5, M2.7 and variants).
 * Clamps `reasoning_effort` to supported `low|medium|high` tiers.
 */
export const isMinimaxM2FamilyModelId = memo((modelId: string): boolean => {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;
	// Boundary-delimited `m2` token followed by zero or more digits (dotless
	// variants like `m21`/`m25`/`m27`) and an optional dotted minor version.
	return /(?:^|[/.-])m2\d*(?:[.-]\d+)?(?:[-.:_]|$)/i.test(lower);
});

/** MiniMax M3 family ids in bundled/default and aggregator namespace forms. */
export const isMinimaxM3FamilyModelId = memo((modelId: string): boolean => {
	const lower = modelId.toLowerCase();
	if (!lower.includes("minimax")) return false;
	return /(?:^|[/._-])(?:minimax[/._-])?m3(?:[-.:_]|$)/i.test(lower);
});

/**
 * OpenAI gpt-oss family (`gpt-oss-20b`, `gpt-oss-120b`, `gpt-oss:120b`,
 * `vendor/gpt-oss-…`). The Harmony reasoning format only accepts
 * `low|medium|high` for `reasoning_effort` and rejects `minimal`, `xhigh`,
 * and `none`.
 */
export const isOpenAIGptOssModelId = memo((modelId: string): boolean => {
	return /(^|\/)gpt-oss[-:]/i.test(modelId);
});

/** OpenAI model ids (gpt-*, chatgpt-*, o1/o3/o4 SKUs, codex-*, or openai/*). */
export const isOpenAIModelId = memo((modelId: string): boolean => {
	return (
		/(^|\/)(?:gpt|chatgpt|codex)[-.]/i.test(modelId) ||
		/(^|\/)o[134](?:[-.]|$)/i.test(modelId) ||
		modelId.toLowerCase().includes("openai/")
	);
});

/** OpenAI models at or above the gpt-5.4 wire generation, keyed off the parsed version. */
const isOpenAIWireGen54Plus = memo((modelId: string): boolean => {
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "5.4");
});

/**
 * Whether the model meets the OpenAI wire generation floor (5.6+) for
 * `prompt_cache_breakpoint` support.
 */
export const supportsOpenAIPromptCacheBreakpoints = memo((modelId: string): boolean => {
	const parsed = parseOpenAIModel(bareModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "5.6");
});

/**
 * OpenAI Codex models (generation 5.4+) that accept `reasoning.context: "all_turns"`
 * for cross-turn reasoning replay.
 */
export const supportsAllTurnsReasoningContext = isOpenAIWireGen54Plus;

/**
 * Whether the model ID specifies a parsable OpenAI wire generation version,
 * distinguishing unversioned codenames from below-floor versions.
 */
export const statesOpenAIWireGeneration = memo((modelId: string): boolean => {
	return parseOpenAIModel(bareModelId(modelId)) !== null;
});

/**
 * OpenAI Codex models (generation 5.4+) that support `reasoning.summary`
 * for human-readable reasoning summary streams.
 */
export const supportsCodexReasoningSummary = isOpenAIWireGen54Plus;

/**
 * Reasoning-capable GLM coding models (glm-4.5+ base, air, and turbo variants;
 * excludes vision and flash/preview variants).
 */
export const isReasoningGlmModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "4.5");
});

/** GLM-5.2+ coding SKUs accept `reasoning_effort` in addition to binary thinking. */
export const isGlm52ReasoningEffortModelId = memo((modelId: string): boolean => {
	const glm = parseGlmModel(bareModelId(modelId));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "5.2");
});

/** GLM vision SKUs — the `v` that attaches to the version (`glm-4v`, `glm-4.5v`). */
export const isGlmVisionModelId = memo((modelId: string): boolean => {
	return parseGlmModel(bareModelId(modelId))?.vision === true;
});

/**
 * Coarse vendor-lineage token for model comparison checks (e.g. cross-family selection).
 * Returns normalized vendor family string or empty string if unclassified.
 */
export const modelFamilyToken = memo((modelId: string): string => {
	const parsed = parseKnownModel(modelId);
	if (parsed.family !== "unknown") return parsed.family;
	if (isClaudeModelId(modelId) || isAnthropicNamespacedModelId(modelId)) return "anthropic";
	if (isOpenAIModelId(modelId)) return "openai";
	if (isKimiModelId(modelId)) return "kimi";
	if (isQwenModelId(modelId)) return "qwen";
	if (isMinimaxM2FamilyModelId(modelId) || isMinimaxM3FamilyModelId(modelId)) return "minimax";
	if (isOpenAIGptOssModelId(modelId)) return "gpt-oss";
	if (isDeepseekModelIdOrName(modelId)) return "deepseek";
	if (isMimoModelIdOrName(modelId)) return "mimo";
	if (isGemmaModelId(modelId)) return "gemma";
	if (parseGlmModel(bareModelId(modelId))) return "glm";
	return "";
});

/**
 * Whether Claude model supports adaptive thinking `display` (Opus 4.7+,
 * Sonnet 5+, Fable/Mythos 5+).
 */
export const supportsAdaptiveThinkingDisplay = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.7");
});

/**
 * Returns true for Anthropic models with Opus 4.7+, Sonnet 5+, and Fable/Mythos 5+
 * API restrictions:
 * - Sampling parameters (temperature/top_p/top_k) return 400 error
 * - Thinking content is omitted by default (needs display: "summarized")
 */
export const hasOpus47ApiRestrictions = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.7");
});

/**
 * Whether Claude model supports mid-conversation `role: "system"` messages
 * (Opus 4.8+, Sonnet 5+, Fable/Mythos 5+).
 */
export const supportsMidConversationSystemMessages = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isAnthropicAdaptiveGenAtLeast(parsed, "4.8");
});

export const isAnthropicFableOrMythosModel = memo((modelId: string): boolean => {
	const parsed = parseAnthropicModel(bareModelId(modelId));
	return parsed !== null && isFableOrMythos(parsed.kind);
});

/** Thinking-variant token location inside a model id. */
export interface ThinkingVariantToken {
	index: number;
	length: number;
}

const THINKING_VARIANT_TOKEN_RE = /-(?:thinking|reasoner|reasoning)(?=$|[^a-z0-9])/gi;

/**
 * Locates the first thinking-variant token (`-thinking`, `-reasoner`,
 * `-reasoning`; trailing or infix) in a model id. The token ends at the id
 * end or any non-alphanumeric boundary, and negated forms (`non-thinking`,
 * `no-thinking`) never match — those name the NON-thinking SKU.
 */
export function findThinkingVariantToken(modelId: string): ThinkingVariantToken | undefined {
	THINKING_VARIANT_TOKEN_RE.lastIndex = 0;
	let match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	while (match !== null) {
		const preceding = /([a-z0-9]+)$/i.exec(modelId.slice(0, match.index))?.[1]?.toLowerCase();
		if (preceding !== "non" && preceding !== "no") {
			return { index: match.index, length: match[0].length };
		}
		match = THINKING_VARIANT_TOKEN_RE.exec(modelId);
	}
	return undefined;
}

/**
 * Removes thinking-variant tokens (e.g. `-thinking`, `-reasoning`) from a model ID.
 * Returns undefined if no token exists or stripped result is empty.
 */
export const stripThinkingVariantToken = memo((modelId: string): string | undefined => {
	const token = findThinkingVariantToken(modelId);
	if (!token) return undefined;
	const stripped = modelId.slice(0, token.index) + modelId.slice(token.index + token.length);
	return stripped.length > 0 ? stripped : undefined;
});
