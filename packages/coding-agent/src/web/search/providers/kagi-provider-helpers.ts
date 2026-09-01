import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { KagiApiError, searchWithKagi } from "../../kagi";
import { clampNumResults, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { classifyProviderHttpError, toSearchSources } from "./utils";

export type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

export const MAX_NUM_RESULTS = 40;

/** Execute Kagi web search. */
export async function searchKagi(params: {
	query: string;
	num_results?: number;
	recency?: SearchParams["recency"];
	signal?: AbortSignal;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
	resolveProviderTextTransform?: SearchParams["resolveProviderTextTransform"];
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, SEARCH_DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const fetchImpl = params.fetch ?? fetch;

	try {
		const result = await searchWithKagi(
			params.query,
			{
				limit: numResults,
				recency: params.recency,
				sessionId: params.sessionId,
				signal: params.signal,
				fetch: fetchImpl,
				resolveProviderTextTransform: params.resolveProviderTextTransform,
			},
			params.authStorage,
		);

		return {
			provider: "kagi",
			sources: toSearchSources(result.sources, numResults),
			relatedQuestions: result.relatedQuestions.length > 0 ? result.relatedQuestions : undefined,
			requestId: result.requestId,
			answer: result.answer,
		};
	} catch (err) {
		if (err instanceof KagiApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("kagi", err.statusCode, err.body);
				if (classified) throw classified;
			}
			throw new SearchProviderError("kagi", "Kagi search request failed.", err.statusCode);
		}
		throw err;
	}
}

/** Search provider for Kagi web search. */
