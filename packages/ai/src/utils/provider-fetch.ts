/**
 * `fetchWithRetry` with the registry's verdict installed. `@veyyon/utils` owns the retry loop (attempt
 * bound, backoff, HTTP/2 verdict) but not the decision — a status means something only next to the body.
 * Every provider fetches through this function; a provider states only its {@link ResponseRetryPolicy}.
 * A provider needing the loop without the verdict passes `shouldRetryResponse`; nothing here widens the gate.
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
