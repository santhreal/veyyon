import type { Usage } from "@veyyon/ai";
import { supportsOpenAIPromptCacheBreakpoints } from "@veyyon/catalog/identity";
import type { Component } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import { renderTranscriptDivider } from "./transcript-divider";

const MIN_CACHE_FOOTPRINT = 2048;

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

export class CacheInvalidationMarkerComponent implements Component {
	#cache?: { width: number; lines: string[] };

	constructor(private readonly info: CacheInvalidation) {}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const icon = theme.icon.cacheMiss;
		const name = this.info.rejected ? "cache rejected" : "cache miss";
		const head = icon ? `${icon} ${name}` : name;
		const tokens = this.info.reprocessedTokens;
		const dot = theme.sep.dot.trim();
		const parts = [head];
		if (tokens > 0) parts.push(`${formatNumber(tokens)} tokens`);
		if (this.info.cause) parts.push(this.info.cause);
		return renderTranscriptDivider(width, parts.join(` ${dot} `));
	}
}
