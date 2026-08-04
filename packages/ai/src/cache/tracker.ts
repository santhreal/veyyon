/**
 * Per-key cache state, so a verdict can be reached at all.
 *
 * `verifyCacheUsage` needs three things a single request cannot know about
 * itself: whether this is the first turn on the key, how long ago the previous
 * turn was, and how much that turn read from cache. Those live here, on the
 * provider's existing per-session state record, which is why this is a set of
 * functions over a plain state object rather than a class — providers already
 * carry one of these per endpoint and model, and adding a second lifetime to
 * manage would be a second thing to get wrong.
 *
 * It also holds the latch that defers a failure to the next request. A rejection
 * is only knowable after the response, once usage arrives, and by then the money
 * is spent. Throwing there would destroy a completed assistant turn as well, so
 * the caller loses the work AND the money. Latching instead means the finished
 * turn is kept and the session stops before paying the same full price twice.
 */
import type { Usage } from "@veyyon/catalog/types";
import type { CacheRetention } from "../types";
import { type CacheEnforcement, type CacheEnforcementDecision, decideCacheEnforcement } from "./policy";
import { type CacheExpectation, type CacheVerdict, verifyCacheUsage } from "./verdict";

export interface CacheTrackerState {
	/**
	 * The cache identity these observations belong to. When it changes the
	 * history is worthless — a different key has a different prefix — so it is
	 * reset rather than compared against, which would report every switch as a
	 * regression.
	 */
	cacheKey?: string;
	/** Requests observed on the current key, used only to know "is this the first". */
	requests: number;
	/** `performance.now()` of the previous observed request on this key. */
	lastRequestAtMs?: number;
	/** Cache tokens the previous request on this key read. */
	lastReadTokens?: number;
	/** A rejection observed on the previous request, to be raised before the next. */
	pendingFailure?: CacheVerdict;
}

export function createCacheTrackerState(): CacheTrackerState {
	return { requests: 0 };
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
 * is the real one the provider's cache window saw.
 */
export function beginCacheTrackedRequest(
	state: CacheTrackerState,
	facts: CacheRequestFacts,
	nowMs: number = performance.now(),
): CacheExpectation {
	if (facts.cacheKey !== state.cacheKey) {
		state.cacheKey = facts.cacheKey;
		state.requests = 0;
		state.lastRequestAtMs = undefined;
		state.lastReadTokens = undefined;
	}
	const expectation: CacheExpectation = {
		anchors: facts.anchors,
		retention: facts.retention,
		reportsCacheWrites: facts.reportsCacheWrites,
		firstRequest: state.requests === 0,
		...(state.lastRequestAtMs === undefined ? {} : { msSincePreviousRequest: nowMs - state.lastRequestAtMs }),
		...(state.lastReadTokens === undefined ? {} : { previousReadTokens: state.lastReadTokens }),
		...(facts.minCacheableTokens === undefined ? {} : { minCacheableTokens: facts.minCacheableTokens }),
	};
	state.requests += 1;
	state.lastRequestAtMs = nowMs;
	return expectation;
}

/**
 * Judge a completed request and decide what to do about it.
 *
 * The read count is remembered even when the verdict is bad, because the next
 * turn's comparison should be against what actually happened rather than
 * against the last healthy turn — otherwise one bad turn reports as bad forever.
 *
 * It is also remembered for a side-channel request, whose smaller read lowers the
 * baseline for one turn. That looks like something to guard against and is not.
 * The tempting fixes both end worse:
 *
 * - Keeping the MAXIMUM read makes compaction permanently over-report. After a
 *   compaction the conversation is genuinely smaller, so every later turn reads
 *   less than the pre-compaction peak forever.
 * - Refusing to update on a non-comparable turn creates a permanent blind spot.
 *   Post-compaction turns are all non-comparable against the old high baseline,
 *   so the baseline would never move again and `degraded` could never fire on
 *   that key.
 *
 * Overwriting every turn costs exactly one turn of blindness after a side
 * request and then self-corrects, which is the smallest of the three failures.
 * `verifyCacheUsage` is what keeps the stale baseline harmless: it only claims a
 * collapse when the current prompt still covers the previously cached prefix.
 */
export function recordCacheOutcome(
	state: CacheTrackerState,
	expectation: CacheExpectation,
	usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
	enforcement: CacheEnforcement,
): { verdict: CacheVerdict; decision: CacheEnforcementDecision } {
	const verdict = verifyCacheUsage(expectation, usage);
	const decision = decideCacheEnforcement(verdict, enforcement);
	state.lastReadTokens = Math.max(0, usage.cacheRead || 0);
	if (decision.failNext) state.pendingFailure = verdict;
	return { verdict, decision };
}

/**
 * Take any latched rejection, clearing it.
 *
 * Cleared on read so the failure is raised exactly once: a latch that persisted
 * would make every later request on the key fail for one historical rejection,
 * leaving no way to continue without restarting the session.
 */
export function takePendingCacheFailure(state: CacheTrackerState): CacheVerdict | undefined {
	const pending = state.pendingFailure;
	state.pendingFailure = undefined;
	return pending;
}
