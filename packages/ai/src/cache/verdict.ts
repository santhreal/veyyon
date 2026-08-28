/**
 * Verifies prompt caching behavior against provider-reported metrics and request expectations.
 */
import type { Usage } from "@veyyon/catalog/types";
import type { CacheRetention } from "../types";

/** Nominal lifetime of a cache entry, by requested retention. */
export const CACHE_TTL_MS: Readonly<Record<Exclude<CacheRetention, "none">, number>> = Object.freeze({
	short: 5 * 60_000,
	long: 60 * 60_000,
});

/** Fraction of the nominal lifetime after which a miss is treated as expiry. */
export const CACHE_WINDOW_GRACE = 0.8;

/** How long since the previous request still counts as inside the window. */
export function cacheWindowGraceMs(retention: Exclude<CacheRetention, "none">): number {
	return CACHE_TTL_MS[retention] * CACHE_WINDOW_GRACE;
}

/** Smallest prefix any supported provider will cache, in tokens. */
export const MIN_CACHEABLE_TOKENS = 2048;

export interface CacheExpectation {
	/** How many cache anchors the request carried on the wire. */
	anchors: number;
	/** Retention the request asked for; `none` means caching was off. */
	retention: CacheRetention;
	/** True when this is the first request on this cache key, where a miss is correct. */
	firstRequest: boolean;
	/** Milliseconds since the previous request on this cache key. */
	msSincePreviousRequest?: number;
	/** Cache tokens read by previous request on this key. */
	previousReadTokens?: number;
	/** Total prompt tokens charged for previous request on this key. */
	previousTotalInputTokens?: number;
	/** Whether provider reports cache writes. */
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
	| {
			kind: "cold";
			reason: "first-request" | "window-expired" | "below-minimum";
			writeTokens: number;
			/** Elapsed time since previous request on key. */
			elapsedMs?: number;
	  }
	/** Prefix changed under request; provider wrote a new entry instead of reading. */
	| { kind: "invalidated"; writeTokens: number; totalInputTokens: number }
	/** Cache served far less of the prompt than the previous turn on this key did. */
	| { kind: "degraded"; readTokens: number; previousReadTokens: number; shortfall: number }
	/** Cache entry stopped growing while prompt continues growing. */
	| {
			kind: "stalled";
			readTokens: number;
			totalInputTokens: number;
			/** Prompt tokens past the frozen prefix, re-billed this turn. */
			uncachedTokens: number;
			/** How much that remainder grew since the previous turn. */
			growthTokens: number;
	  }
	/** Provider neither read nor wrote a cache entry despite valid request. */
	| { kind: "rejected"; totalInputTokens: number; anchors: number }
	/** Unverifiable miss when provider does not report writes. */
	| { kind: "unverifiable"; totalInputTokens: number };

/** Judge one completed request against what it asked the provider to cache. */
export function verifyCacheUsage(
	expectation: CacheExpectation,
	usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
): CacheVerdict {
	const readTokens = Math.max(0, usage.cacheRead || 0);
	const writeTokens = Math.max(0, usage.cacheWrite || 0);
	const inputTokens = Math.max(0, usage.input || 0);
	const totalInputTokens = inputTokens + readTokens + writeTokens;

	if (expectation.anchors <= 0 || expectation.retention === "none") {
		return { kind: "not-requested" };
	}

	if (readTokens > 0) {
		const previous = expectation.previousReadTokens;
		// Significant drop in cache read ratio indicates degraded cache performance.
		const promptStillCoversPrefix = previous !== undefined && totalInputTokens >= previous;
		if (
			previous !== undefined &&
			previous > MIN_CACHEABLE_TOKENS &&
			readTokens < previous / 2 &&
			promptStillCoversPrefix
		) {
			return { kind: "degraded", readTokens, previousReadTokens: previous, shortfall: previous - readTokens };
		}
		// Detect when cache read size is frozen while prompt size continues growing.
		const previousTotal = expectation.previousTotalInputTokens;
		const uncachedTokens = totalInputTokens - readTokens;
		if (
			previous !== undefined &&
			previousTotal !== undefined &&
			readTokens > MIN_CACHEABLE_TOKENS &&
			readTokens === previous &&
			totalInputTokens > previousTotal &&
			uncachedTokens >= readTokens
		) {
			return {
				kind: "stalled",
				readTokens,
				totalInputTokens,
				uncachedTokens,
				growthTokens: totalInputTokens - previousTotal,
			};
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

	// Compare against grace window rather than strict nominal TTL.
	const graceMs = cacheWindowGraceMs(expectation.retention);
	const elapsed = expectation.msSincePreviousRequest;
	if (elapsed !== undefined && elapsed > graceMs) {
		return { kind: "cold", reason: "window-expired", writeTokens, elapsedMs: elapsed };
	}

	// Inside window with write tokens indicates prefix churn rather than rejection.
	if (writeTokens > 0) {
		return { kind: "invalidated", writeTokens, totalInputTokens };
	}

	// Rejection check when write reporting or previous reads are present.
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
		case "stalled":
		case "invalidated":
		case "rejected":
		case "unverifiable":
			return false;
	}
}

/** Format millisecond duration to human readable format. */
function formatGapMs(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/** One line naming what happened and what it cost, for a log or an error. */
export function describeCacheVerdict(verdict: CacheVerdict): string {
	switch (verdict.kind) {
		case "not-requested":
			return "prompt caching was not requested for this turn";
		case "ok":
			return `prompt cache read ${verdict.readTokens} of ${verdict.totalInputTokens} input tokens (${Math.round(verdict.ratio * 100)}%)`;
		case "cold": {
			const gap = verdict.elapsedMs === undefined ? "" : ` after a ${formatGapMs(verdict.elapsedMs)} gap`;
			return `prompt cache was cold (${verdict.reason})${gap}; wrote ${verdict.writeTokens} tokens`;
		}
		case "invalidated":
			return `prompt cache prefix changed: rewrote ${verdict.writeTokens} of ${verdict.totalInputTokens} input tokens instead of reading them`;
		case "degraded":
			return `prompt cache served ${verdict.readTokens} tokens where the previous turn served ${verdict.previousReadTokens} (${verdict.shortfall} fewer)`;
		case "stalled":
			return `prompt cache stopped growing: it has served the same ${verdict.readTokens} tokens since the previous turn while the prompt reached ${verdict.totalInputTokens}, so ${verdict.uncachedTokens} tokens were re-billed (${verdict.growthTokens} more than last turn)`;
		case "rejected":
			return `prompt cache was NOT accepted: the request carried ${verdict.anchors} cache ${verdict.anchors === 1 ? "anchor" : "anchors"} and the provider reported neither a read nor a write for ${verdict.totalInputTokens} input tokens`;
		case "unverifiable":
			return `prompt cache reported no read for ${verdict.totalInputTokens} input tokens, and this provider does not report cache writes`;
	}
}
