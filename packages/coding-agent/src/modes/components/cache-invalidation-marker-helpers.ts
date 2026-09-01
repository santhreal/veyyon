import type { Usage } from "@veyyon/ai";
import { supportsOpenAIPromptCacheBreakpoints } from "@veyyon/catalog/identity";

export const MIN_CACHE_FOOTPRINT = 2048;

export interface CacheInvalidation {
	reprocessedTokens: number;
	rejected?: boolean;
	cause?: string;
}

export function usesExplicitPromptCache(api: string | undefined, modelId: string | undefined): boolean {
	if (api === "anthropic-messages" || api === "bedrock-converse-stream") return true;
	if (api === "openai-responses" || api === "openai-codex-responses") {
		return modelId !== undefined && supportsOpenAIPromptCacheBreakpoints(modelId);
	}
	return false;
}

export function detectCacheInvalidation(
	prev: Usage | undefined,
	current: Usage,
	cause?: string,
	options?: { explicitCache?: boolean },
): CacheInvalidation | undefined {
	if (!prev) return undefined;
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	if (current.cacheRead > 0) return undefined;
	if (current.cacheWrite <= 0) {
		if (options?.explicitCache !== true) return undefined;
		const rejectedTokens = current.input;
		if (rejectedTokens < MIN_CACHE_FOOTPRINT) return undefined;
		const rejectedCause = cause?.trim();
		return rejectedCause
			? { reprocessedTokens: rejectedTokens, rejected: true, cause: rejectedCause }
			: { reprocessedTokens: rejectedTokens, rejected: true };
	}
	const reprocessedTokens = current.cacheWrite + current.input;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	const named = cause?.trim();
	return named ? { reprocessedTokens, cause: named } : { reprocessedTokens };
}
