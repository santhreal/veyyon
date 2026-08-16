import type { Usage } from "@veyyon/ai";
import { supportsOpenAIPromptCacheBreakpoints } from "@veyyon/catalog/identity";
import type { Component } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { theme } from "../../modes/theme/theme";
import { renderTranscriptDivider } from "./transcript-divider";

/**
 * Minimum prefix the previous turn must have READ back from cache before a
 * collapse on the current turn counts as an invalidation. Filters out tiny
 * contexts and providers below the cacheable-prefix floor, where a zero
 * `cacheRead` is expected rather than a reset.
 */
const MIN_CACHE_FOOTPRINT = 2048;

/** A prompt-cache invalidation detected from a turn's usage. */
export interface CacheInvalidation {
	/** Prompt tokens the cold turn had to (re)process instead of reading from cache. */
	reprocessedTokens: number;
	/**
	 * The provider neither read a cached prefix NOR wrote one, on a turn whose
	 * predecessor demonstrably read a warm prefix from an explicit,
	 * prefix-controlled cache.
	 *
	 * A different event from a cold re-write, and it reads differently to an
	 * operator: a re-write means the prefix moved and the cache still works, while
	 * this means the markers had no effect at all, so nothing is cached for the
	 * next turn either and the cost repeats until something changes. It is the
	 * shape of every prompt-cache defect shipped so far, and it used to be the one
	 * case this detector discarded.
	 */
	rejected?: boolean;
	/**
	 * Why the cache went cold, when the session knows: the reason recorded by the
	 * subsystem that invalidated it (`cwd-change`, `setting:<id>`, `argot-arm`, …).
	 *
	 * The marker used to report only a token count, which tells an operator that
	 * they just paid to re-read the conversation and nothing about what to stop
	 * doing. A measured session showed four such rebuilds, each around 32k
	 * characters of prompt, all of them caused by re-rooting the working directory,
	 * and none of that was visible anywhere. Absent on a transcript rebuilt from
	 * disk, where a recorded reason cannot be correlated to a specific turn.
	 */
	cause?: string;
}

/**
 * Whether a turn's provider uses an explicit, prefix-controlled prompt cache.
 *
 * Only these re-create the prefix on a cold turn, and only for these does "read
 * nothing and wrote nothing" mean the markers were ignored rather than routine
 * propagation noise. Anthropic and Bedrock always report cache writes; OpenAI
 * does from the generation that accepts explicit breakpoints, which is the same
 * predicate the request builder uses to decide whether to send one — asking the
 * catalog rather than restating the version test keeps the two from drifting.
 *
 * Everything else (Google, Fireworks, older OpenAI) caches implicitly and drops
 * `cacheRead` to zero intermittently, so a zero-write turn there is noise.
 */
export function usesExplicitPromptCache(api: string | undefined, modelId: string | undefined): boolean {
	if (api === "anthropic-messages" || api === "bedrock-converse-stream") return true;
	if (api === "openai-responses" || api === "openai-codex-responses") {
		return modelId !== undefined && supportsOpenAIPromptCacheBreakpoints(modelId);
	}
	return false;
}

/**
 * Decide whether `current` turn lost a *working* prompt cache that `prev` was
 * reusing.
 *
 * The provider reports a warm prefix as `cacheRead`; a model/thinking/tool/
 * system-prompt change (or a history rewrite) breaks the prefix, so the next
 * request reads nothing from cache and re-pays for the whole prompt. We flag
 * only the transition where a demonstrably warm cache goes cold: the previous
 * turn must have actually READ a meaningful prefix back, and this turn's
 * `cacheRead` collapsed to zero while it still reprocessed a non-trivial prompt.
 *
 * Requiring a prior warm read is deliberate. A turn that merely WROTE the prefix
 * (`cacheRead` 0) has not proven the cache is live — that is the session's first
 * request, or a re-write after expiry — so a following cold turn there is
 * expected, not an invalidation the user caused (e.g. a long-running first tool
 * call outliving the provider's 5-minute cache TTL surfaced a spurious "cache
 * miss" right under the opening message). It also collapses a run of consecutive
 * cold turns to the single marker at the moment the cache actually broke, instead
 * of repeating the banner on every turn while it re-warms.
 *
 * Returns `undefined` (no marker) for the first turn, turns whose predecessor
 * never read a warm prefix, tiny contexts, turns that reused any cache, and —
 * crucially — turns on providers with *implicit* best-effort caching. Only an
 * explicit, prefix-controlled cache (Anthropic / Bedrock `cache_control`)
 * re-creates the prefix on a cold turn (`cacheWrite > 0`). That now includes
 * OpenAI from the GPT-5.6 generation, which reports `cache_write_tokens` for
 * explicit breakpoints; earlier OpenAI models and other implicit caches
 * (Google / Fireworks) report `cacheWrite: 0` and drop `cacheRead` to zero
 * intermittently as routine propagation noise that self-heals the next turn, so
 * flagging those would be a false positive.
 */
export function detectCacheInvalidation(
	prev: Usage | undefined,
	current: Usage,
	cause?: string,
	options?: { explicitCache?: boolean },
): CacheInvalidation | undefined {
	if (!prev) return undefined;
	// Only flag a warm→cold transition: the previous turn must have actually read
	// a meaningful prefix from cache. A write-only predecessor (first request, or
	// a re-write after expiry) has not proven the cache is live, so a cold turn
	// behind it is expected — not an invalidation worth surfacing.
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	// Any cache reuse this turn means the prefix survived (at least partly).
	if (current.cacheRead > 0) return undefined;
	// Neither read nor wrote. On an implicit best-effort cache that is routine
	// propagation noise which self-heals next turn, so it stays unflagged. On an
	// explicit, prefix-controlled cache it is the opposite of noise: the markers
	// were sent and had no effect, nothing is cached for the next turn either, and
	// the cost repeats. The caller supplies which kind of cache this is, because
	// usage alone cannot tell them apart — and dropping this case unconditionally
	// is what made every shipped cache defect invisible in the UI.
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

/**
 * Slim divider rendered above an assistant turn whose request lost the prompt
 * cache. Same house divider as a compaction point, and like that one it carries
 * no expandable detail:
 *
 *   ────────── ⊘ cache miss · 50.9k tokens
 */
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
		// "miss" understates a rejection: a miss re-reads the prompt once and the
		// cache works again next turn, while a rejection means nothing was cached at
		// all, so the same cost recurs every turn until something changes. Naming
		// them the same thing tells the operator to shrug at both.
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
