/**
 * Exponential backoff with jitter for reconnect and retry loops.
 *
 * This is the ONE owner for the delay schedule that the collab relay clients
 * (the browser `collab-web` socket and the node `coding-agent` relay client)
 * previously hand-wrote as identical copies. The module has no dependencies, so
 * browser bundles reach it through `@veyyon/utils/backoff`.
 *
 * The delay for a given attempt is the base delay doubled per attempt, capped at
 * a maximum, then spread by a symmetric jitter fraction so many clients that
 * dropped together do not reconnect in lockstep. The random source is injectable
 * so tests can pin the jitter to a known value.
 */

export interface ExponentialBackoffOptions {
	/** Delay for attempt 0 before jitter, in milliseconds. Defaults to 1000. */
	baseMs?: number;
	/** Upper bound on the pre-jitter delay, in milliseconds. Defaults to 30000. */
	maxMs?: number;
	/**
	 * Symmetric jitter as a fraction of the capped delay. `0.25` spreads the
	 * result across `[capped * 0.75, capped * 1.25)`. Defaults to 0.25.
	 */
	jitter?: number;
	/** Source of a `[0, 1)` value for the jitter. Defaults to `Math.random`. */
	random?: () => number;
}

/**
 * Return the backoff delay in milliseconds for a zero-based `attempt`.
 *
 * The pre-jitter delay is `min(baseMs * 2 ** attempt, maxMs)`. The returned
 * value multiplies that by `1 - jitter + random() * 2 * jitter`, so with the
 * defaults a caller sees the classic `capped * (0.75 + random() * 0.5)` schedule.
 * Increment the attempt counter in the caller after reading the delay so the
 * first reconnect uses attempt 0.
 */
export function exponentialBackoffDelay(attempt: number, options: ExponentialBackoffOptions = {}): number {
	const { baseMs = 1_000, maxMs = 30_000, jitter = 0.25, random = Math.random } = options;
	const capped = Math.min(baseMs * 2 ** attempt, maxMs);
	return capped * (1 - jitter + random() * (2 * jitter));
}
