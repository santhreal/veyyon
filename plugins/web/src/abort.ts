// The owner module, not the `@veyyon/utils` barrel: `loadPage` sits in the `read` tool's closure and
// the barrel is 81 leaves.
import { AbortError, isCancellation } from "@veyyon/utils/abortable";

/**
 * Throw for a signal that has already been aborted, keeping what aborted it.
 *
 * {@link AbortError} takes both the name and the message from `signal.reason`, so a deadline stays a
 * `TimeoutError` and a cancellation stays an `AbortError`. `isAbortError`, `isTimeoutError` and
 * `isCancellation` classify by that name, which is how a scraper's cancellation reaches the fetch
 * dispatcher as a stop rather than as a site that failed. A bare `new Error("aborted")` carries no
 * name and reads as a scrape failure, which makes the dispatcher fall through to the generic fetch
 * and re-issue the request that was just cancelled.
 *
 * A REASON WITH AN ORDINARY NAME IS THE TRAP. `controller.abort(new Error("session ended"))` is how
 * a parent tool cancels its children, and the adopted name is then `Error`, which no predicate
 * recognises — the cancellation would arrive at the dispatcher looking exactly like a site that
 * broke. Such a name is replaced with `AbortError` and the reason survives on `cause`, so nothing
 * about why the work stopped is lost.
 */
export function throwIfCancelled(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new AbortError(signal);
	if (!isCancellation(error)) error.name = "AbortError";
	throw error;
}
