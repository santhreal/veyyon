import { supportsOpenAIPromptCacheBreakpoints } from "@veyyon/catalog/identity";
import type { CacheRetention, Model } from "../types";

export interface OpenAIExplicitCacheBreakpoint {
	mode: "explicit";
}

export interface OpenAICacheableInputText {
	type: "input_text";
	text: string;
	prompt_cache_breakpoint?: OpenAIExplicitCacheBreakpoint;
}

export interface OpenAIPromptCachePolicyInput {
	model: Model<"openai-responses">;
	promptCacheKey: string | undefined;
	cacheRetention?: CacheRetention;
}

export interface OpenAIPromptCachePolicy {
	stablePrefixBreakpoint: OpenAIExplicitCacheBreakpoint | undefined;
	promptCacheRetention: "24h" | undefined;
}

const EXPLICIT_BREAKPOINT: OpenAIExplicitCacheBreakpoint = Object.freeze({ mode: "explicit" });
export const OPENAI_PROMPT_CACHE_DISABLED: OpenAIPromptCachePolicy = Object.freeze({
	stablePrefixBreakpoint: undefined,
	promptCacheRetention: undefined,
});

export function isOfficialOpenAIResponsesEndpoint(model: Model): boolean {
	if (model.provider !== "openai") return false;
	if (!model.baseUrl) return true;
	try {
		return new URL(model.baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

/**
 * Resolve cache fields and markers for an official OpenAI Responses request.
 *
 * `prompt_cache_breakpoint` is a platform API field: only `api.openai.com`
 * accepts it. The ChatGPT Codex backend rejects it with
 * `prompt_cache_breakpoint is not supported on this model (invalid_parameter)`,
 * which fails the whole turn, and upstream codex-rs never sends it. The
 * `Model<"openai-responses">` parameter type keeps the Codex request path from
 * asking for a policy at all; do not widen it to `openai-codex-responses`
 * without a captured request from that backend proving the field is accepted.
 */
export function resolveOpenAIPromptCachePolicy({
	model,
	promptCacheKey,
	cacheRetention,
}: OpenAIPromptCachePolicyInput): OpenAIPromptCachePolicy {
	const official = model.api === "openai-responses" && isOfficialOpenAIResponsesEndpoint(model);
	const modelId = model.requestModelId ?? model.id;
	const generationSupportsBreakpoints = supportsOpenAIPromptCacheBreakpoints(modelId);
	const stablePrefixBreakpoint =
		promptCacheKey && generationSupportsBreakpoints && official ? EXPLICIT_BREAKPOINT : undefined;
	// `prompt_cache_retention` is deprecated from the 5.6 generation onward, where
	// `prompt_cache_options.ttl` replaces it; sending both is contradictory.
	const usesModernOfficialCache = generationSupportsBreakpoints && official;
	const promptCacheRetention =
		promptCacheKey &&
		cacheRetention === "long" &&
		model.compat.supportsLongPromptCacheRetention &&
		!usesModernOfficialCache
			? "24h"
			: undefined;
	return { stablePrefixBreakpoint, promptCacheRetention };
}

/** Serialize one Responses input-text block under the resolved cache policy. */
export function formatOpenAIInputText(
	text: string,
	policy: OpenAIPromptCachePolicy = OPENAI_PROMPT_CACHE_DISABLED,
): OpenAICacheableInputText {
	const breakpoint = policy.stablePrefixBreakpoint;
	return breakpoint ? { type: "input_text", text, prompt_cache_breakpoint: breakpoint } : { type: "input_text", text };
}
