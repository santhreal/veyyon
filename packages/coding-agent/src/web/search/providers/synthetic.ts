/**
 * Synthetic Web Search Provider
 *
 * Uses Synthetic's zero-data-retention web search API for coding agents.
 * Endpoint: POST https://api.synthetic.new/v2/search
 */

import type { ApiKey, AuthStorage, FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { applyResultLimit } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";

interface SyntheticSearchResult {
	url: string;
	title: string;
	text?: string;
	published?: string;
}

interface SyntheticSearchResponse {
	results: SyntheticSearchResult[];
}

/** Resolve Synthetic API key through the shared auth storage pipeline. */
export function findApiKey(
	authStorage: AuthStorage,
	sessionId?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return authStorage.getApiKey("synthetic", sessionId, { signal });
}

/** Call Synthetic search API. */
async function callSyntheticSearch(
	apiKey: string,
	query: string,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	resolveTextTransform?: SearchParams["resolveProviderTextTransform"],
): Promise<SyntheticSearchResponse> {
	return withHardTimeout(signal, async hardSignal => {
		const transform = resolveProviderTextTransform(resolveTextTransform, "Synthetic search request");
		const requestBody = transformProviderPayload({ query }, transform, "Synthetic search request");
		const response = await fetchImpl(SYNTHETIC_SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(requestBody),
			signal: hardSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("synthetic", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError(
				"synthetic",
				`Synthetic API error (${response.status}).`,
				response.status,
			);
		}

		return (await response.json()) as SyntheticSearchResponse;
	});
}

/** Execute Synthetic web search. */
export async function searchSynthetic(params: SearchParamsWithFetch): Promise<SearchResponse> {
	const keyOrResolver: ApiKey = params.authStorage.resolver("synthetic", {
		sessionId: params.sessionId,
	});

	const fetchImpl = params.fetch;
	const data = await withAuth(
		keyOrResolver,
		key =>
			callSyntheticSearch(
				key,
				params.query,
				params.signal,
				fetchImpl,
				params.resolveProviderTextTransform,
			),
		{
			signal: params.signal,
			missingKeyMessage:
				"Synthetic credentials not found. Set SYNTHETIC_API_KEY or login with 'veyyon /login synthetic'.",
		},
	);
	const sources: SearchSource[] = [];

	for (const result of data.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.text ?? undefined,
			publishedDate: result.published ?? undefined,
		});
	}

	return {
		provider: "synthetic",
		sources: applyResultLimit(sources, params.numSearchResults ?? params.limit),
	};
}

/** Search provider for Synthetic. */
export class SyntheticProvider extends SearchProvider {
	readonly id = "synthetic";
	readonly label = "Synthetic";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("synthetic") || !!getEnvApiKey("synthetic");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchSynthetic(params);
	}
}
