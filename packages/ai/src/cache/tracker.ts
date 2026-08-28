/**
 * Per-key prompt cache tracking and verdict determination.
 */
import type { Usage } from "@veyyon/catalog/types";
import type { CacheRetention } from "../types";
import { type CacheEnforcement, type CacheEnforcementDecision, decideCacheEnforcement } from "./policy";
import { type CacheExpectation, type CacheVerdict, verifyCacheUsage } from "./verdict";

/**
 * Observations for ONE cache identity.
 *
 * Kept per key rather than in a single slot because a provider-session record is
 * scoped to an endpoint and model, and several logical conversations can share
 * that scope: the auth gateway serves many clients through one `streamAnthropic`,
 * and a session runs side-channel requests alongside its main loop. With one slot
 * those interleave, each resetting the other's history, so every request looked
 * like a first request and the check silently did nothing on exactly the traffic
 * that needed it most.
 */
export interface CacheKeyObservations {
	/** Requests observed on this key, used only to know "is this the first". */
	requests: number;
	/** `performance.now()` of the previous observed request on this key. */
	lastRequestAtMs?: number;
	/** Cache tokens the previous request on this key read. */
	lastReadTokens?: number;
	/**
	 * Total prompt tokens the previous request on this key was charged for.
	 * Remembered alongside the read so a cache that has stopped growing is
	 * distinguishable from one that is keeping up: both report an unchanged read,
	 * and only the prompt tells them apart.
	 */
	lastTotalInputTokens?: number;
	/** A rejection observed on the previous request, to be raised before the next. */
	pendingFailure?: CacheVerdict;
}

/**
 * Most recently used cache identities to remember.
 *
 * Bounded because a gateway process is long-lived and its key space is its
 * clients', so an unbounded map is a slow leak. Sixteen is far more than one
 * session needs (a main loop plus its side channels share one key) and enough
 * that ordinary gateway interleaving never evicts a live conversation.
 */
export const CACHE_TRACKER_MAX_KEYS = 16;

/** Key used when a request carries no cache identity of its own. */
const UNKEYED = "\u0000unkeyed";

export interface CacheTrackerState {
	/** Insertion-ordered, so the oldest entry is the one evicted at the cap. */
	keys: Map<string, CacheKeyObservations>;
}

export function createCacheTrackerState(): CacheTrackerState {
	return { keys: new Map() };
}

/** A request being tracked, and the identity its observations belong to. */
export interface CacheTrackedRequest {
	expectation: CacheExpectation;
	/**
	 * Carried explicitly rather than remembered on the state, because the whole
	 * point of keying is that two requests can be in flight on different
	 * identities at once; a "current key" field would race exactly there.
	 */
	key: string;
}

/**
 * Facts about the request being sent, gathered at the moment it is sent.
 *
 * `anchors` MUST be counted on the serialized request rather than taken from the
 * intent to place them. The OpenRouter alias defect was an intent that never
 * became a marker on the wire, so a count taken any earlier would have agreed
 * with the broken code and reported a healthy cache.
 */
export interface CacheRequestFacts {
	anchors: number;
	retention: CacheRetention;
	reportsCacheWrites: boolean;
	cacheKey?: string;
	minCacheableTokens?: number;
}

/**
 * Record that a request is going out, and build the expectation to judge it by.
 *
 * Called immediately before the request is sent, so the elapsed gap it computes
 * is the real one the provider's cache window saw. Touching the entry moves it to
 * the end of the map, which is what makes the cap an LRU rather than a
 * first-in-first-out that could evict the busiest conversation.
 */
export function beginCacheTrackedRequest(
	state: CacheTrackerState,
	facts: CacheRequestFacts,
	nowMs: number = performance.now(),
): CacheTrackedRequest {
	const key = facts.cacheKey ?? UNKEYED;
	const existing = state.keys.get(key);
	const observations: CacheKeyObservations = existing ?? { requests: 0 };
	// Re-insert so insertion order tracks recency.
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

/**
 * Records cache read counts and evaluates prompt caching health across turns.
 */
export function recordCacheOutcome(
	state: CacheTrackerState,
	tracked: CacheTrackedRequest,
	usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
	enforcement: CacheEnforcement,
): { verdict: CacheVerdict; decision: CacheEnforcementDecision } {
	const verdict = verifyCacheUsage(tracked.expectation, usage);
	const decision = decideCacheEnforcement(verdict, enforcement);
	// The entry can have been evicted while this request was in flight, on a
	// gateway busy enough to cycle sixteen identities mid-turn. Losing the
	// observation is correct there: the next request on that key starts fresh
	// rather than comparing against a history that is no longer complete.
	const observations = state.keys.get(tracked.key);
	if (observations) {
		observations.lastReadTokens = Math.max(0, usage.cacheRead || 0);
		observations.lastTotalInputTokens =
			Math.max(0, usage.input || 0) + Math.max(0, usage.cacheRead || 0) + Math.max(0, usage.cacheWrite || 0);
		if (decision.failNext) observations.pendingFailure = verdict;
	}
	return { verdict, decision };
}

/**
 * Take any latched rejection for one cache identity, clearing it.
 *
 * Cleared on read so the failure is raised exactly once: a latch that persisted
 * would make every later request on the key fail for one historical rejection,
 * leaving no way to continue without restarting the session.
 *
 * Scoped to the key, so a rejection on one conversation cannot fail the next
 * request of an unrelated one sharing the same endpoint and model.
 */
export function takePendingCacheFailure(state: CacheTrackerState, cacheKey?: string): CacheVerdict | undefined {
	const key = cacheKey ?? UNKEYED;
	const observations = state.keys.get(key);
	if (!observations) return undefined;
	const pending = observations.pendingFailure;
	observations.pendingFailure = undefined;
	return pending;
}
