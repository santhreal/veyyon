/**
 * Did the prompt cache actually work?
 *
 * Nothing in this repo used to ask. Every provider placed its cache markers and
 * then read `cacheRead` only to price the turn: the number was summed, billed
 * and displayed, and never once compared against what the request had asked the
 * provider to cache. That silence is why four separate cache defects shipped and
 * were found by reading a bill rather than by a failing check:
 *
 * - Codex Responses Lite stamped `prompt_cache_breakpoint` on a model that
 *   answers `invalid_parameter`, so every turn on that path cached nothing.
 * - Claude served through OpenRouter under a `~anthropic/…` alias failed a
 *   `startsWith("anthropic/")` test, so no breakpoint was ever written and the
 *   whole conversation was re-read at full input rate on every turn.
 * - `prompt_cache_retention: "24h"` reached generations that reject it.
 * - `/branch` and `/btw` re-prefilled the entire retained transcript.
 *
 * Each one is invisible to a cost meter and obvious to this module: the request
 * carried anchors, the prompt was well over the provider's minimum, it was not
 * the first turn on the key, the window had not closed, and the provider
 * reported neither a read nor a write. That combination cannot happen when
 * caching works, so it is reported as `rejected` rather than guessed at.
 *
 * The judgement uses ONLY numbers the provider reported plus facts the caller
 * already knows. It never estimates a prefix size, because an estimate that
 * drifts from the tokenizer would turn this into a source of false alarms, and
 * a check that cries wolf gets turned off.
 */
import type { Usage } from "@veyyon/catalog/types";
import type { CacheRetention } from "../types";

/**
 * How long a provider keeps a cache entry warm, by requested retention.
 *
 * Anthropic documents 5 minutes for an ephemeral breakpoint and 1 hour with
 * `ttl: "1h"`; OpenAI's implicit prefix cache is documented as "a few minutes"
 * of inactivity, which the short window covers. These bound the window in which
 * a miss is a DEFECT rather than an ordinary expiry, so they are deliberately
 * generous: over-estimating the window would call a legitimate expiry a
 * rejection, and that is the false positive that discredits the whole check.
 */
export const CACHE_TTL_MS: Readonly<Record<Exclude<CacheRetention, "none">, number>> = Object.freeze({
	short: 5 * 60_000,
	long: 60 * 60_000,
});

/**
 * Smallest prefix any supported provider will cache, in tokens.
 *
 * Anthropic's floor is 1024 for most models (2048 for the small Haiku tier) and
 * OpenAI's is 1024. Using the highest documented floor means a prompt below it
 * is never called a rejection, at the cost of not judging small prompts — which
 * is the right trade, since a sub-2048-token prompt has almost nothing to save.
 */
export const MIN_CACHEABLE_TOKENS = 2048;

export interface CacheExpectation {
	/**
	 * How many cache anchors the request actually carried on the wire.
	 *
	 * Zero means the request never asked to cache anything, which is a valid
	 * state (a model without cache support, retention `none`) and must never be
	 * reported as a failure. It counts anchors ON THE WIRE, not the intent to
	 * place them: the OpenRouter alias defect was precisely an intent that never
	 * became a marker, so a count taken before serialization would have missed it.
	 */
	anchors: number;
	/** Retention the request asked for; `none` means caching was off. */
	retention: CacheRetention;
	/** True when this is the first request on this cache key, where a miss is correct. */
	firstRequest: boolean;
	/**
	 * Milliseconds since the previous request on this cache key, when known.
	 * Undefined is treated as "inside the window", because an unknown gap must
	 * not be used to excuse a miss it cannot vouch for.
	 */
	msSincePreviousRequest?: number;
	/**
	 * Cache tokens the previous request on this key read, when known. A key that
	 * demonstrably read from cache and now reads nothing is a regression even on
	 * a provider that never reports writes.
	 */
	previousReadTokens?: number;
	/**
	 * Whether this provider reports cache WRITES. OpenAI-family surfaces report
	 * only `cached_tokens`, so a cold-but-working first turn is indistinguishable
	 * from an ignored marker unless something else vouches for the key.
	 */
	reportsCacheWrites: boolean;
	/** Provider's minimum cacheable prefix; defaults to {@link MIN_CACHEABLE_TOKENS}. */
	minCacheableTokens?: number;
}

export type CacheVerdict =
	/** The request asked to cache nothing. Not a failure. */
	| { kind: "not-requested" }
	/** Cache worked: the provider served a prefix from cache. */
	| { kind: "ok"; readTokens: number; totalInputTokens: number; ratio: number }
	/** A miss that is explained. Not a failure, but worth recording. */
	| { kind: "cold"; reason: "first-request" | "window-expired" | "below-minimum"; writeTokens: number }
	/**
	 * The prefix changed under us: the provider wrote a new entry instead of
	 * reading one, inside the window and not on the first turn. Something in the
	 * request's cached prefix is unstable.
	 */
	| { kind: "invalidated"; writeTokens: number; totalInputTokens: number }
	/** Cache served far less of the prompt than the previous turn on this key did. */
	| { kind: "degraded"; readTokens: number; previousReadTokens: number; shortfall: number }
	/**
	 * We asked, it was big enough, it was not the first turn, the window was
	 * open, and the provider neither read nor wrote a cache entry. The markers
	 * did not take effect.
	 */
	| { kind: "rejected"; totalInputTokens: number; anchors: number }
	/**
	 * A miss that cannot be attributed, because the provider does not report
	 * writes and nothing vouches for this key having ever cached. Reported so it
	 * is visible, never thrown on.
	 */
	| { kind: "unverifiable"; totalInputTokens: number };

/** Judge one completed request against what it asked the provider to cache. */
export function verifyCacheUsage(
	expectation: CacheExpectation,
	usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
): CacheVerdict {
	const readTokens = Math.max(0, usage.cacheRead || 0);
	const writeTokens = Math.max(0, usage.cacheWrite || 0);
	const inputTokens = Math.max(0, usage.input || 0);
	// Everything the provider charged as input. `input` excludes the cached
	// buckets on every provider pi-ai normalizes, so the prompt is the sum.
	const totalInputTokens = inputTokens + readTokens + writeTokens;

	if (expectation.anchors <= 0 || expectation.retention === "none") {
		return { kind: "not-requested" };
	}

	if (readTokens > 0) {
		const previous = expectation.previousReadTokens;
		// A key that read 40k last turn and 900 now did not "work": the prefix
		// moved. The threshold is deliberately coarse — halving is unambiguous,
		// while small drops are ordinary turn-to-turn movement of the window.
		if (previous !== undefined && previous > MIN_CACHEABLE_TOKENS && readTokens < previous / 2) {
			return { kind: "degraded", readTokens, previousReadTokens: previous, shortfall: previous - readTokens };
		}
		return {
			kind: "ok",
			readTokens,
			totalInputTokens,
			ratio: totalInputTokens > 0 ? readTokens / totalInputTokens : 0,
		};
	}

	const minimum = expectation.minCacheableTokens ?? MIN_CACHEABLE_TOKENS;
	if (totalInputTokens < minimum) {
		return { kind: "cold", reason: "below-minimum", writeTokens };
	}
	if (expectation.firstRequest) {
		return { kind: "cold", reason: "first-request", writeTokens };
	}

	const ttl = CACHE_TTL_MS[expectation.retention];
	const elapsed = expectation.msSincePreviousRequest;
	if (elapsed !== undefined && elapsed > ttl) {
		return { kind: "cold", reason: "window-expired", writeTokens };
	}

	// Inside the window, past the first turn, above the floor, and the provider
	// wrote an entry: it honoured the markers, but the prefix it had cached no
	// longer matched. That is prefix churn, not a rejection.
	if (writeTokens > 0) {
		return { kind: "invalidated", writeTokens, totalInputTokens };
	}

	// No read and no write. On a provider that reports writes this is provable:
	// the markers did nothing. Without write reporting, only a key that has read
	// before can distinguish a rejection from an unreported cold write.
	if (expectation.reportsCacheWrites || (expectation.previousReadTokens ?? 0) > 0) {
		return { kind: "rejected", totalInputTokens, anchors: expectation.anchors };
	}
	return { kind: "unverifiable", totalInputTokens };
}

/** Whether a verdict describes a working cache (or a state that is not its fault). */
export function isCacheHealthy(verdict: CacheVerdict): boolean {
	switch (verdict.kind) {
		case "ok":
		case "not-requested":
		case "cold":
			return true;
		case "degraded":
		case "invalidated":
		case "rejected":
		case "unverifiable":
			return false;
	}
}

/** One line naming what happened and what it cost, for a log or an error. */
export function describeCacheVerdict(verdict: CacheVerdict): string {
	switch (verdict.kind) {
		case "not-requested":
			return "prompt caching was not requested for this turn";
		case "ok":
			return `prompt cache read ${verdict.readTokens} of ${verdict.totalInputTokens} input tokens (${Math.round(verdict.ratio * 100)}%)`;
		case "cold":
			return `prompt cache was cold (${verdict.reason}); wrote ${verdict.writeTokens} tokens`;
		case "invalidated":
			return `prompt cache prefix changed: rewrote ${verdict.writeTokens} of ${verdict.totalInputTokens} input tokens instead of reading them`;
		case "degraded":
			return `prompt cache served ${verdict.readTokens} tokens where the previous turn served ${verdict.previousReadTokens} (${verdict.shortfall} fewer)`;
		case "rejected":
			return `prompt cache was NOT accepted: the request carried ${verdict.anchors} cache ${verdict.anchors === 1 ? "anchor" : "anchors"} and the provider reported neither a read nor a write for ${verdict.totalInputTokens} input tokens`;
		case "unverifiable":
			return `prompt cache reported no read for ${verdict.totalInputTokens} input tokens, and this provider does not report cache writes`;
	}
}
