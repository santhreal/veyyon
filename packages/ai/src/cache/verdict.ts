import type { Usage } from "@veyyon/catalog/types";
import type { CacheRetention } from "../types";

export const CACHE_TTL_MS: Readonly<Record<Exclude<CacheRetention, "none">, number>> = Object.freeze({
	short: 5 * 60_000,
	long: 60 * 60_000,
});

export const CACHE_WINDOW_GRACE = 0.8;

export function cacheWindowGraceMs(retention: Exclude<CacheRetention, "none">): number {
	return CACHE_TTL_MS[retention] * CACHE_WINDOW_GRACE;
}

export const MIN_CACHEABLE_TOKENS = 2048;

export interface CacheExpectation {
	anchors: number;
	retention: CacheRetention;
	firstRequest: boolean;
	msSincePreviousRequest?: number;
	previousReadTokens?: number;
	previousTotalInputTokens?: number;
	reportsCacheWrites: boolean;
	minCacheableTokens?: number;
}

export type CacheVerdict =
	| { kind: "not-requested" }
	| { kind: "ok"; readTokens: number; totalInputTokens: number; ratio: number }
	| {
			kind: "cold";
			reason: "first-request" | "window-expired" | "below-minimum";
			writeTokens: number;
			elapsedMs?: number;
	  }
	| { kind: "invalidated"; writeTokens: number; totalInputTokens: number }
	| { kind: "degraded"; readTokens: number; previousReadTokens: number; shortfall: number }
	| {
			kind: "stalled";
			readTokens: number;
			totalInputTokens: number;
			uncachedTokens: number;
			growthTokens: number;
	  }
	| { kind: "rejected"; totalInputTokens: number; anchors: number }
	| { kind: "unverifiable"; totalInputTokens: number };

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
		const promptStillCoversPrefix = previous !== undefined && totalInputTokens >= previous;
		if (
			previous !== undefined &&
			previous > MIN_CACHEABLE_TOKENS &&
			readTokens < previous / 2 &&
			promptStillCoversPrefix
		) {
			return { kind: "degraded", readTokens, previousReadTokens: previous, shortfall: previous - readTokens };
		}
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

	const graceMs = cacheWindowGraceMs(expectation.retention);
	const elapsed = expectation.msSincePreviousRequest;
	if (elapsed !== undefined && elapsed > graceMs) {
		return { kind: "cold", reason: "window-expired", writeTokens, elapsedMs: elapsed };
	}

	if (writeTokens > 0) {
		return { kind: "invalidated", writeTokens, totalInputTokens };
	}

	if (expectation.reportsCacheWrites || (expectation.previousReadTokens ?? 0) > 0) {
		return { kind: "rejected", totalInputTokens, anchors: expectation.anchors };
	}
	return { kind: "unverifiable", totalInputTokens };
}

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

function formatGapMs(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

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
