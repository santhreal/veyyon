import { type FetchWithRetryOptions, fetchWithRetry } from "@veyyon/utils/fetch-retry";
import { type ResponseRetryPolicy, retryResponse } from "../error/response";

export interface ProviderFetchOptions extends FetchWithRetryOptions {
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
