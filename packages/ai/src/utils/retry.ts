import { scheduler } from "node:timers/promises";
import { isCopilotTransientModelError, status } from "../error/flags";
import { isProviderRetryableError } from "../error/retryable";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./retry-after";

const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 3;
const COPILOT_MODEL_RETRY_BASE_DELAY_MS = 400;
/** Longest server-requested backoff we are willing to sit out before giving up. */
const COPILOT_RETRY_AFTER_MAX_WAIT_MS = 30_000;

/**
 * Wrap an initial Copilot request so transient `model_not_supported` 400s are
 * retried a small number of times. No-op for non-Copilot providers.
 *
 * The callback **MUST** create a fresh in-flight request each invocation — a
 * once-consumed AsyncIterable cannot be re-iterated.
 */
export async function callWithCopilotModelRetry<T>(
	fn: () => Promise<T>,
	options: { provider: string; signal?: AbortSignal; retryBaseDelayMs?: number },
): Promise<T> {
	if (options.provider !== "github-copilot") return fn();

	const { signal } = options;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? COPILOT_MODEL_RETRY_BASE_DELAY_MS;
	// Ends by returning or throwing: the last attempt has no retry delay.
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
		}
		try {
			return await fn();
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error;
			const delayMs = copilotRetryDelayMs(error, attempt, retryBaseDelayMs);
			if (delayMs === undefined) throw error;
			await waitForRetry(delayMs, signal);
		}
	}
}

/** Sleep `delayMs` before a retry; a cancelled sleep rethrows the caller's reason over the timer's AbortError. */
async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	try {
		await scheduler.wait(delayMs, { signal });
	} catch (waitError) {
		// `reason` is undefined until the signal aborts, so a timer failure of its own passes through.
		throw signal?.reason ?? waitError;
	}
}

/**
 * The wait before retrying `error` after the zero-based `attempt`, or `undefined`
 * when `error` is not retried: `attempt` is the last one, `error` is not retryable,
 * it is a 429 without a server delay, or its server delay exceeds
 * {@link COPILOT_RETRY_AFTER_MAX_WAIT_MS}.
 */
function copilotRetryDelayMs(error: unknown, attempt: number, retryBaseDelayMs: number): number | undefined {
	if (attempt >= COPILOT_MODEL_RETRY_MAX_ATTEMPTS - 1) return undefined;
	const backoffMs = retryBaseDelayMs * (attempt + 1);
	if (isCopilotTransientModelError(error)) return backoffMs;
	// ONE PREDICATE DECIDES. This asked `@veyyon/utils/fetch-retry`'s `isRetryableError`, a
	// second classifier with its own transient vocabulary, so this ladder retried failures the
	// provider ladders refused and refused ones they retried. `isProviderRetryableError` also
	// brings the vetoes this loop never had: an account-level cap belongs to credential
	// rotation rather than to a 30-second backoff, and a refused HTTP/2 code or an
	// undelimited frame reproduces on every attempt.
	if (!isProviderRetryableError(error)) return undefined;
	const errorStatus = status(error);
	if (errorStatus === undefined) return backoffMs;
	const retryAfterMs = getRetryAfterMsFromHeaders(getHeadersFromError(error));
	// An unguided rate limit is not useful to blind-retry. Other transient
	// statuses (408/5xx) retain the normal backoff, while any supplied server
	// delay still governs the retry.
	if (retryAfterMs === undefined) return errorStatus === 429 ? undefined : backoffMs;
	return retryAfterMs > COPILOT_RETRY_AFTER_MAX_WAIT_MS ? undefined : Math.max(backoffMs, retryAfterMs);
}
