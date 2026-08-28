import type { Usage } from "@veyyon/catalog/types";
import type { CacheRetention } from "../types";
import { type CacheEnforcement, type CacheEnforcementDecision, decideCacheEnforcement } from "./policy";
import { type CacheExpectation, type CacheVerdict, verifyCacheUsage } from "./verdict";

export interface CacheKeyObservations {
	requests: number;
	lastRequestAtMs?: number;
	lastReadTokens?: number;
	lastTotalInputTokens?: number;
	pendingFailure?: CacheVerdict;
}

export const CACHE_TRACKER_MAX_KEYS = 16;

const UNKEYED = "\u0000unkeyed";

export interface CacheTrackerState {
	keys: Map<string, CacheKeyObservations>;
}

export function createCacheTrackerState(): CacheTrackerState {
	return { keys: new Map() };
}

export interface CacheTrackedRequest {
	expectation: CacheExpectation;
	key: string;
}

export interface CacheRequestFacts {
	anchors: number;
	retention: CacheRetention;
	reportsCacheWrites: boolean;
	cacheKey?: string;
	minCacheableTokens?: number;
}

export function beginCacheTrackedRequest(
	state: CacheTrackerState,
	facts: CacheRequestFacts,
	nowMs: number = performance.now(),
): CacheTrackedRequest {
	const key = facts.cacheKey ?? UNKEYED;
	const existing = state.keys.get(key);
	const observations: CacheKeyObservations = existing ?? { requests: 0 };
	state.keys.delete(key);
	state.keys.set(key, observations);
	while (state.keys.size > CACHE_TRACKER_MAX_KEYS) {
		const oldest = state.keys.keys().next();
		if (oldest.done) break;
		state.keys.delete(oldest.value);
	}
	const expectation: CacheExpectation = {
		anchors: facts.anchors,
		retention: facts.retention,
		reportsCacheWrites: facts.reportsCacheWrites,
		firstRequest: observations.requests === 0,
		...(observations.lastRequestAtMs === undefined
			? {}
			: { msSincePreviousRequest: nowMs - observations.lastRequestAtMs }),
		...(observations.lastReadTokens === undefined ? {} : { previousReadTokens: observations.lastReadTokens }),
		...(observations.lastTotalInputTokens === undefined
			? {}
			: { previousTotalInputTokens: observations.lastTotalInputTokens }),
		...(facts.minCacheableTokens === undefined ? {} : { minCacheableTokens: facts.minCacheableTokens }),
	};
	observations.requests += 1;
	observations.lastRequestAtMs = nowMs;
	return { expectation, key };
}

export function recordCacheOutcome(
	state: CacheTrackerState,
	tracked: CacheTrackedRequest,
	usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
	enforcement: CacheEnforcement,
): { verdict: CacheVerdict; decision: CacheEnforcementDecision } {
	const verdict = verifyCacheUsage(tracked.expectation, usage);
	const decision = decideCacheEnforcement(verdict, enforcement);
	const observations = state.keys.get(tracked.key);
	if (observations) {
		observations.lastReadTokens = Math.max(0, usage.cacheRead || 0);
		observations.lastTotalInputTokens =
			Math.max(0, usage.input || 0) + Math.max(0, usage.cacheRead || 0) + Math.max(0, usage.cacheWrite || 0);
		if (decision.failNext) observations.pendingFailure = verdict;
	}
	return { verdict, decision };
}

export function takePendingCacheFailure(state: CacheTrackerState, cacheKey?: string): CacheVerdict | undefined {
	const key = cacheKey ?? UNKEYED;
	const observations = state.keys.get(key);
	if (!observations) return undefined;
	const pending = observations.pendingFailure;
	observations.pendingFailure = undefined;
	return pending;
}
