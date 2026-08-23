/**
 * `fetchWithRetry` with the registry's verdict already installed.
 *
 * `@veyyon/utils` owns the retry LOOP — the attempt bound, the backoff, the `Retry-After` hint, the
 * HTTP/2 verdict — and it cannot own the DECISION, because a status means something only next to the
 * body and the classifier that reads bodies lives here. So the loop's own gate admits the canonical
 * transient set and every caller was free to narrow it, which meant a provider that passed no gate at
 * all silently accepted the loop's reading: a bare 429 was re-sent against the same spent credential
 * while the credential layer, looking at the identical failure, was rotating away from it.
 *
 * Every provider in this package fetches through this function, so the decision has one home for the
 * whole package and a provider states only what is genuinely its own — its {@link ResponseRetryPolicy}.
 * A provider that needs the loop without the verdict passes its own `shouldRetryResponse`, which is
 * still honoured; nothing here can widen the loop's gate, which is why a policy's `alsoRetry` belongs
 * to a ladder that runs its own loop.
 */
import { type FetchWithRetryOptions, fetchWithRetry } from "@veyyon/utils/fetch-retry";
import { type ResponseRetryPolicy, retryResponse } from "../error/response";

export interface ProviderFetchOptions extends FetchWithRetryOptions {
	/** What this provider states about its own responses; the registry decides the rest. */
	retry?: ResponseRetryPolicy;
}

export function fetchProviderWithRetry(
	url: string | URL | ((attempt: number) => string | URL),
	options: ProviderFetchOptions = {},
): Promise<Response> {
	const { retry, shouldRetryResponse, ...rest } = options;
	return fetchWithRetry(url, {
		...rest,
		shouldRetryResponse:
			shouldRetryResponse ?? ((response, bodyText) => retryResponse(response, bodyText, retry ?? {})),
	});
}
