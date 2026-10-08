/**
 * Command Code's Provider API deployment contract.
 *
 * `GET /provider/v1/models` answers 69 rows that carry an id, a name and a
 * context length, and nothing else: no price, no reasoning surface, no output
 * ceiling. Discovery therefore produces a catalog where every model costs zero
 * and none of them thinks, which is how a session against a $10/M model
 * reported no spend at all. This module is the missing half of that response.
 * It is data, keyed by the served id, and the discovery mapper below is its one
 * consumer, so the runtime path and the generation pass read the same numbers.
 *
 * Rates are Command Code's published per-1M-token USD list prices. The effort
 * ladders are the ids whose upstream exposes a reasoning dial; every other
 * served id omits the control on the wire, so a missing ladder here is a
 * deliberate absence rather than a gap.
 *
 * What this does not cover: the table is a snapshot, so a model the router adds
 * arrives priced zero and unpriced-marked until someone updates it, and a rate
 * change upstream is invisible until then. `a-command-code-model-arrives-priced.test.ts`
 * fails when the served set and this table disagree, which is the signal to
 * re-read the pricing page.
 */

import { fetchOpenAICompatibleModels } from "../discovery/openai-compatible";
import { Effort } from "../effort";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, LongContextCost, ModelSpec } from "../types";
import { toPositiveNumber } from "../utils";
import { createBundledReferenceMap } from "./bundled-references";

/** The Provider API root every Command Code model is served from. */
export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";

/**
 * Output ceiling for a served model with no ceiling of its own.
 *
 * The Provider API publishes no per-model maximum, and the upstream CLI asks
 * for 64K. Leaving it null instead lets compaction and context promotion plan
 * against an output budget nobody stated.
 */
export const COMMAND_CODE_DEFAULT_MAX_TOKENS = 65_536;

/** Per-1M-token USD list prices, keyed by served id. */
export const COMMAND_CODE_COSTS: Readonly<Record<string, ModelSpec["cost"]>> = {
	"claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
	"claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	"gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0.0 },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0.0 },
	"gpt-5.3-codex": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0.0 },
	"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.0 },
	"deepseek/deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.0 },
	"deepseek/deepseek-v4-flash": { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.0 },
	"deepseek/deepseek-v4-flash-vision-exp": { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0.0 },
	"deepseek/deepseek-v4-flash-fast": { input: 0.28, output: 0.56, cacheRead: 0.07, cacheWrite: 0.0 },
	"deepseek/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.0 },
	"moonshotai/Kimi-K3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.0 },
	"moonshotai/Kimi-K2.7-Code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0.0 },
	"moonshotai/Kimi-K2.7-Code-Highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0.0 },
	"moonshotai/Kimi-K2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.0 },
	"moonshotai/Kimi-K2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0.0 },
	"z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.0 },
	"zai-org/GLM-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0.0 },
	"zai-org/GLM-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0.0 },
	"zai-org/GLM-5.2-Fast": { input: 3, output: 10.25, cacheRead: 0.5, cacheWrite: 0.0 },
	"zai-org/GLM-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0.0 },
	"zai-org/GLM-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0.0 },
	"MiniMaxAI/MiniMax-M3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.0 },
	"MiniMaxAI/MiniMax-M2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.0 },
	"MiniMaxAI/MiniMax-M2.5": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.0 },
	"xiaomi/mimo-v2.5-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0.0 },
	"xiaomi/mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.0 },
	"Qwen/Qwen3.8-Max-0902": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0.0 },
	"Qwen/Qwen3.8-Max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
	"Qwen/Qwen3.8-27B": { input: 0.4, output: 3, cacheRead: 0.04, cacheWrite: 0.0 },
	"Qwen/Qwen3.8-Flash": { input: 0.16, output: 0.47, cacheRead: 0.016, cacheWrite: 0.0 },
	"Qwen/Qwen3.7-Max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13 },
	"Qwen/Qwen3.7-Plus": { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.5 },
	"Qwen/Qwen3.7-Flash": { input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038 },
	"Qwen/Qwen3.6-Max-Preview": { input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63 },
	"Qwen/Qwen3.6-Plus": { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0.0 },
	"stepfun/Step-3.7-Flash": { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0.0 },
	"stepfun/Step-3.5-Flash": { input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0.0 },
	"tencent/hy3-paid": { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0.0 },
	"tencent/hy4-preview": { input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0.0 },
	"google/gemini-3.8-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.0 },
	"google/gemini-3.7-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.08334 },
	"google/gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.0 },
	"google/gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0.0 },
	"google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.0 },
	"google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.03, cacheWrite: 0.0 },
	"sakana/fugu-ultra": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0.0 },
	"nvidia/nemotron-3-ultra-550b-a55b": { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0.0 },
	"thinkingmachines/inkling": { input: 1, output: 4.05, cacheRead: 0.17, cacheWrite: 0.0 },
	"thinkingmachines/inkling-small": { input: 0.5, output: 1.2, cacheRead: 0.1, cacheWrite: 0.0 },
	"meta/muse-spark-1.1": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0.0 },
	"meta/muse-spark-1.2": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0.0 },
	"meta/muse-spark-1.2-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0.0 },
	"meta/muse-spark-1.3": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0.0 },
	"meta/muse-spark-1.3-contributor": { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0.0 },
	"xai/grok-4.5": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0.0 },
	"xai/grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0.0 },
};

/**
 * Served ids Command Code gives away.
 *
 * They are priced zero like an undiscovered model, and the difference matters:
 * `getModelPricing` reads a zero as free only when something recorded that the
 * upstream published it.
 */
export const COMMAND_CODE_FREE_MODELS: readonly string[] = [
	"meituan/LongCat-2.0:free",
	"poolside/laguna-s-2.1-free",
	"inclusionai/ling-3.0-flash-sante:free",
];

/** Prompt-size rate tiers for the served ids that bill at two rate cards. */
export const COMMAND_CODE_LONG_CONTEXT_COSTS: Readonly<Record<string, LongContextCost>> = {
	"Qwen/Qwen3.7-Plus": { inputThreshold: 256000, input: 1.2, output: 4.8, cacheRead: 0.24, cacheWrite: 1.5 },
	"Qwen/Qwen3.7-Flash": { inputThreshold: 32000, input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25 },
	"xai/grok-4.6": { inputThreshold: 200000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0.0 },
};

/** Reasoning ladders, for the served ids that expose an effort dial upstream. */
export const COMMAND_CODE_EFFORTS: Readonly<Record<string, readonly Effort[]>> = {
	"claude-sonnet-5": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"claude-sonnet-4-6": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"claude-fable-5-1": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"claude-fable-5": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"claude-opus-5": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"claude-opus-4-8": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"claude-opus-4-7": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"gpt-5.6-sol": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"gpt-5.6-terra": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"gpt-5.6-luna": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	"gpt-5.5": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"gpt-5.4": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"gpt-5.3-codex": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"gpt-5.4-mini": [Effort.Low, Effort.Medium, Effort.High],
	"deepseek/deepseek-v4-pro": [Effort.High, Effort.Max],
	"deepseek/deepseek-v4-flash": [Effort.High, Effort.Max],
	"deepseek/deepseek-v4-flash-vision-exp": [Effort.High, Effort.Max],
	"deepseek/deepseek-v4-flash-fast": [Effort.Low, Effort.High, Effort.Max],
	"moonshotai/Kimi-K3": [Effort.Low, Effort.High, Effort.Max],
	"z-ai/glm-5.3-flash": [Effort.Low, Effort.High, Effort.Max],
	"zai-org/GLM-5.3": [Effort.Low, Effort.High, Effort.Max],
	"zai-org/GLM-5.2": [Effort.High, Effort.Max],
	"Qwen/Qwen3.8-Max-0902": [Effort.Low, Effort.Medium, Effort.XHigh],
	"Qwen/Qwen3.8-Max": [Effort.Low, Effort.Medium, Effort.XHigh],
	"Qwen/Qwen3.8-27B": [Effort.Low, Effort.Medium, Effort.XHigh],
	"Qwen/Qwen3.8-Flash": [Effort.Low, Effort.Medium, Effort.XHigh],
	"tencent/hy4-preview": [Effort.Low, Effort.Medium, Effort.High],
	"google/gemini-3.8-flash": [Effort.Low, Effort.Medium, Effort.High],
	"google/gemini-3.7-flash": [Effort.Low, Effort.Medium, Effort.High],
	"google/gemini-3.6-flash": [Effort.Low, Effort.Medium, Effort.High],
	"google/gemini-3.5-flash": [Effort.Low, Effort.Medium, Effort.High],
	"google/gemini-3.5-flash-lite": [Effort.Low, Effort.Medium, Effort.High],
	"google/gemini-3.1-flash-lite": [Effort.Low, Effort.Medium, Effort.High],
	"sakana/fugu-ultra": [Effort.High, Effort.XHigh],
	"meta/muse-spark-1.1": [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"meta/muse-spark-1.2": [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"meta/muse-spark-1.2-contributor": [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"meta/muse-spark-1.3": [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"meta/muse-spark-1.3-contributor": [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	"xai/grok-4.5": [Effort.Low, Effort.Medium, Effort.High],
	"xai/grok-4.6": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};

/**
 * Limits that override what the Provider API reports.
 *
 * The Codex SKU reports its output budget inside the advertised window, so the
 * prompt window it will actually accept is smaller than the 400K it answers.
 */
export const COMMAND_CODE_LIMITS: Readonly<Record<string, { contextWindow?: number; maxTokens: number }>> = {
	"gpt-5.3-codex": { contextWindow: 272000, maxTokens: 65536 },
	"z-ai/glm-5.3-flash": { maxTokens: 131072 },
	"Qwen/Qwen3.8-27B": { maxTokens: 32768 },
};

/**
 * Fill in everything the Provider API response leaves out.
 *
 * Mutates in place and returns the same spec, because both callers already own
 * a freshly mapped object and a copy here would only be discarded.
 */
export function applyCommandCodeContract(model: ModelSpec<"openai-completions">): ModelSpec<"openai-completions"> {
	const cost = COMMAND_CODE_COSTS[model.id];
	if (cost) {
		model.cost = { ...cost };
		model.pricing = "published";
	} else if (COMMAND_CODE_FREE_MODELS.includes(model.id)) {
		model.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		model.pricing = "published";
	} else {
		model.pricing = "unknown";
	}

	const tier = COMMAND_CODE_LONG_CONTEXT_COSTS[model.id];
	if (tier) model.longContextCost = { ...tier };

	const efforts = COMMAND_CODE_EFFORTS[model.id];
	if (efforts) {
		model.reasoning = true;
		model.thinking = { mode: "effort", efforts };
	} else {
		model.reasoning = false;
		model.thinking = undefined;
	}

	const limits = COMMAND_CODE_LIMITS[model.id];
	model.maxTokens = limits?.maxTokens ?? COMMAND_CODE_DEFAULT_MAX_TOKENS;
	if (limits?.contextWindow !== undefined) model.contextWindow = limits.contextWindow;

	return model;
}

/** The documented flagship, seeded so a no-network generation still resolves the default. */
export const COMMAND_CODE_STATIC_MODELS: readonly ModelSpec<"openai-completions">[] = [
	applyCommandCodeContract({
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "openai-completions",
		provider: "command-code",
		baseUrl: COMMAND_CODE_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: null,
	}),
];

export interface CommandCodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

/**
 * Command Code's model discovery.
 *
 * The catalog endpoint answers without a key, so discovery runs unauthenticated
 * and the served set — not this file's seed — is what a fresh install sees.
 */
export function commandCodeModelManagerOptions(
	config?: CommandCodeModelManagerConfig,
): ModelManagerOptions<"openai-completions"> {
	const apiKey = config?.apiKey;
	const baseUrl = config?.baseUrl ?? COMMAND_CODE_BASE_URL;
	const references = createBundledReferenceMap<"openai-completions">("command-code");
	return {
		providerId: "command-code",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: hooks =>
			fetchOpenAICompatibleModels({
				onFailure: hooks?.onFailure,
				api: "openai-completions",
				provider: "command-code",
				baseUrl,
				apiKey,
				mapModel: (entry, defaults) => {
					const reference = references.get(defaults.id);
					return applyCommandCodeContract({
						...defaults,
						name: defaults.name || reference?.name || defaults.id,
						input: reference?.input ?? defaults.input,
						contextWindow: toPositiveNumber(
							entry.context_length,
							reference?.contextWindow ?? defaults.contextWindow,
						),
					});
				},
				fetch: config?.fetch,
			}),
	};
}
