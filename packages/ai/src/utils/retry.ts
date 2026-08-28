import { scheduler } from "node:timers/promises";
import { isCopilotTransientModelError, status } from "../error/flags";
import { isProviderRetryableError } from "../error/retryable";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./retry-after";

const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 3;
const COPILOT_MODEL_RETRY_BASE_DELAY_MS = 400;
const COPILOT_RETRY_AFTER_MAX_WAIT_MS = 30_000;

export async function callWithCopilotModelRetry<T>(
	fn: () => Promise<T>,
	options: { provider: string; signal?: AbortSignal; retryBaseDelayMs?: number },
): Promise<T> {
	if (options.provider !== "github-copilot") return fn();

	let lastError: unknown;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? COPILOT_MODEL_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; attempt < COPILOT_MODEL_RETRY_MAX_ATTEMPTS; attempt++) {
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
		}
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (options.signal?.aborted) throw options.signal.reason ?? error;
			const transientModelError = isCopilotTransientModelError(error);
			if (!transientModelError && !isProviderRetryableError(error)) throw error;
			if (attempt === COPILOT_MODEL_RETRY_MAX_ATTEMPTS - 1) break;
			let delayMs = retryBaseDelayMs * (attempt + 1);
			if (!transientModelError) {
				const errorStatus = status(error);
				if (errorStatus !== undefined) {
					const retryAfterMs = getRetryAfterMsFromHeaders(getHeadersFromError(error));
					if (errorStatus === 429 && retryAfterMs === undefined) throw error;
					if (retryAfterMs !== undefined) {
						if (retryAfterMs > COPILOT_RETRY_AFTER_MAX_WAIT_MS) throw error;
						delayMs = Math.max(delayMs, retryAfterMs);
					}
				}
			}
			try {
				await scheduler.wait(delayMs, { signal: options.signal });
			} catch (waitError) {
				if (options.signal?.aborted) throw options.signal.reason ?? waitError;
				throw waitError;
			}
		}
	}
	throw lastError;
}
