import * as AIError from "../error";
import type { FetchImpl } from "../types";

/**
 * Fetch a URL and parse the body as JSON, throwing
 * {@link AIError.ProviderHttpError} (with the response body in the message)
 * on any non-2xx status.
 */
export async function fetchJsonOrThrow(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<unknown> {
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new AIError.ProviderHttpError(`${response.status} ${response.statusText}: ${text}`, response.status);
	}
	return response.json();
}
