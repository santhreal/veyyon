/**
 * Exponential backoff with jitter for reconnect and retry loops.
 *
 * Every loop that waits longer after each failure takes its delay from here: the
 * collab relay clients, the provider retry ladders, the SQLite open retries, the
 * daemon restart schedule. The module has no dependencies, so browser bundles
 * reach it through `@veyyon/utils/backoff`.
 *
 * The delay for a given attempt is the base delay doubled per attempt, capped at
 * a maximum, then spread by a jitter fraction so many clients that failed
 * together do not retry in lockstep. The random source is injectable so tests
 * can pin the jitter to a known value.
 */

export interface ExponentialBackoffOptions {
	/** Delay for attempt 0 before jitter, in milliseconds. Defaults to 1000. */
	baseMs?: number;
	/**
	 * Upper bound on the pre-jitter delay, in milliseconds. Defaults to 30000.
	 * `Number.POSITIVE_INFINITY` leaves the schedule uncapped, for a loop whose
	 * attempt budget is its only bound.
	 */
	maxMs?: number;
	/**
	 * Jitter as a fraction of the capped delay. Defaults to 0.25. `0` returns the
	 * capped delay unchanged.
	 */
	jitter?: number;
	/**
	 * Which side of the capped delay the jitter spreads over. Defaults to
	 * `"both"`.
	 *
	 * - `"both"`: `[capped * (1 - jitter), capped * (1 + jitter))`.
	 * - `"below"`: `(capped * (1 - jitter), capped]`. Jitter only shortens the
	 *   wait, so `maxMs` is also the longest wait.
	 */
	jitterSpread?: "both" | "below";
	/** Source of a `[0, 1)` value for the jitter. Defaults to `Math.random`. */
	random?: () => number;
}

/**
 * Return the backoff delay in milliseconds for a zero-based `attempt`.
 *
 * The pre-jitter delay is `min(baseMs * 2 ** attempt, maxMs)`. A negative
 * attempt reads as attempt 0, and a `baseMs` of zero or less yields 0 at every
 * attempt. From the first attempt whose doubled delay reaches `maxMs`, every
 * later attempt returns the same capped value, including attempts past the
 * point where `2 ** attempt` overflows to `Infinity`.
 *
 * With the default `"both"` spread the result is
 * `capped * (1 - jitter + random() * 2 * jitter)`, which with the defaults is
 * the classic `capped * (0.75 + random() * 0.5)` schedule. With `"below"` it is
 * `capped * (1 - random() * jitter)`. Increment the attempt counter in the
 * caller after reading the delay so the first retry uses attempt 0.
 */
export function exponentialBackoffDelay(attempt: number, options: ExponentialBackoffOptions = {}): number {
	const { baseMs = 1_000, maxMs = 30_000, jitter = 0.25, jitterSpread = "both", random = Math.random } = options;
	if (baseMs <= 0) return 0;
	const capped = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
	if (jitter === 0) return capped;
	if (jitterSpread === "below") return capped * (1 - random() * jitter);
	return capped * (1 - jitter + random() * (2 * jitter));
}
