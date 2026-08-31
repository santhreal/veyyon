/**
 * One HTTP request, bounded.
 *
 * Every request this package sent was unbounded, in three places at once: the dashboard's own calls,
 * the trace report's, and the vmnet forward that carries an agent's auth request out of a container.
 * A peer that accepted the connection and answered nothing left each of them waiting on a promise
 * that never settled — a page with no rows and no error, a report command that printed nothing, an
 * agent whose token request never returned.
 *
 * No node imports here: the dashboard bundle imports this module directly.
 */

import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";

/** How long a caller waits for an answer before it reports the peer as unreachable. */
export const REQUEST_TIMEOUT_MS = 15_000;

export interface BoundedFetchOptions {
	readonly timeoutMs?: number;
	/** What the failure names as not having answered. */
	readonly subject?: string;
}

/**
 * Sends one request and rejects when nothing answers within the bound. A caller's own signal still
 * cancels: whichever fires first ends the request, and only the bound produces the timeout message.
 */
export async function fetchWithin(
	url: string,
	init?: RequestInit,
	options: BoundedFetchOptions = {},
): Promise<Response> {
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	// Scoped, not a bare abort-signal timeout: the backing timer is cleared the instant the request
	// settles, so a long-lived dashboard never accumulates armed timers.
	const bound = scopedTimeoutSignal(timeoutMs);
	const signal = init?.signal ? AbortSignal.any([init.signal, bound.signal]) : bound.signal;
	try {
		return await fetch(url, { ...init, signal });
	} catch (err) {
		if (bound.signal.aborted) {
			const bounds = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
			throw new Error(`${options.subject ?? "the manager"} did not answer ${url} within ${bounds}`);
		}
		throw err;
	} finally {
		bound.cancel();
	}
}
