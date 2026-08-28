import type { Usage } from "@veyyon/ai";
import { supportsOpenAIPromptCacheBreakpoints } from "@veyyon/catalog/identity";
import type { Component } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import { renderTranscriptDivider } from "./transcript-divider";

/** Minimum prefix the previous turn must have READ back from cache before a collapse on the current turn counts as an invalidation. Filters out tiny */
const MIN_CACHE_FOOTPRINT = 2048;

/** A prompt-cache invalidation detected from a turn's usage. */
export interface CacheInvalidation {
	/** Prompt tokens the cold turn had to (re)process instead of reading from cache. */
	reprocessedTokens: number;
	/** The provider neither read a cached prefix NOR wrote one, on a turn whose predecessor demonstrably read a warm prefix from an explicit, */
	rejected?: boolean;
	/** Why the cache went cold, when the session knows: the reason recorded by the subsystem that invalidated it (`cwd-change`, `setting:<id>`, `argot-arm`, …). */
	cause?: string;
}

/** Whether a turn's provider uses an explicit, prefix-controlled prompt cache. Only these re-create the prefix on a cold turn, and only for these does "read */
export function usesExplicitPromptCache(api: string | undefined, modelId: string | undefined): boolean {
	if (api === "anthropic-messages" || api === "bedrock-converse-stream") return true;
	if (api === "openai-responses" || api === "openai-codex-responses") {
		return modelId !== undefined && supportsOpenAIPromptCacheBreakpoints(modelId);
	}
	return false;
}

/** Decide whether `current` turn lost a *working* prompt cache that `prev` was reusing. */
export function detectCacheInvalidation(
	prev: Usage | undefined,
	current: Usage,
	cause?: string,
	options?: { explicitCache?: boolean },
): CacheInvalidation | undefined {
	if (!prev) return undefined;
	// Only flag a warm→cold transition: the previous turn must have actually read a meaningful prefix from cache. A write-only predecessor (first request, or
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	// Any cache reuse this turn means the prefix survived (at least partly).
	if (current.cacheRead > 0) return undefined;
	// Neither read nor wrote. On an implicit best-effort cache that is routine propagation noise which self-heals next turn, so it stays unflagged. On an
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
	// A blank or whitespace cause carries no information and would render a
	// trailing separator with nothing after it.
	const named = cause?.trim();
	return named ? { reprocessedTokens, cause: named } : { reprocessedTokens };
}

/** Slim divider rendered above an assistant turn whose request lost the prompt cache. Same house divider as a compaction point, and like that one it carries */
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
		// "miss" understates a rejection: a miss re-reads the prompt once and the cache works again next turn, while a rejection means nothing was cached at
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
