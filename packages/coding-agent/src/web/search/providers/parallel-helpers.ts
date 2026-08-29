import type { ApiKey, AuthStorage, FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import {
	PARALLEL_BETA_HEADER,
	PARALLEL_SEARCH_URL,
	ParallelApiError,
	type ParallelSearchResult,
	parseParallelErrorResponse,
	parseParallelSearchPayload,
} from "../../parallel";
import { clampNumResults, SEARCH_DEFAULT_NUM_RESULTS } from "../utils";
import type { SearchParams } from "./base";
import { classifyProviderHttpError, toSearchSources, withHardTimeout } from "./utils";

export const MAX_NUM_RESULTS = 40;

async function searchWithAuthStorage(
	objective: string,
	queries: string[],
	params: {
		signal?: AbortSignal;
		fetch?: FetchImpl;
		resolveProviderTextTransform?: SearchParams["resolveProviderTextTransform"];
	},
	authStorage: AuthStorage,
	sessionId?: string,
): Promise<ParallelSearchResult> {
	const apiKey = await authStorage.getApiKey("parallel", sessionId, { signal: params.signal });
	if (!apiKey) {
		throw new ParallelApiError(
			"Parallel credentials not found. Set PARALLEL_API_KEY or login with 'veyyon /login parallel'.",
		);
	}

	// Drive the (already-present) credential through the central force-refresh / sibling-rotate retry policy. The `ParallelApiError` thrown below carries a
	const keyOrResolver: ApiKey = authStorage.resolver("parallel", { sessionId });
	return withAuth(
		keyOrResolver,
		async key => {
			return withHardTimeout(params.signal, async hardSignal => {
				const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, "Parallel search");
				const body = transformProviderPayload(
					{
						objective,
						search_queries: queries,
						mode: "fast",
						excerpts: {
							max_chars_per_result: 10_000,
						},
					},
					transform,
					"Parallel search",
				);
				const response = await (params.fetch ?? fetch)(PARALLEL_SEARCH_URL, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						"x-api-key": key,
						"parallel-beta": PARALLEL_BETA_HEADER,
					},
					body: JSON.stringify(body),
					signal: hardSignal,
				});

				if (!response.ok) {
					throw parseParallelErrorResponse(response.status, await response.text());
				}

				const payload: unknown = await response.json();
				return parseParallelSearchPayload(payload, { parseMetadata: false });
			});
		},
		{ signal: params.signal },
	);
}

export async function searchParallel(
	params: {
		query: string;
		num_results?: number;
		signal?: AbortSignal;
		fetch?: FetchImpl;
		resolveProviderTextTransform?: SearchParams["resolveProviderTextTransform"];
	},
	authStorage: AuthStorage,
	sessionId?: string,
): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, SEARCH_DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

	try {
		const result = await searchWithAuthStorage(
			params.query,
			[params.query],
			{
				signal: params.signal,
				fetch: params.fetch,
				resolveProviderTextTransform: params.resolveProviderTextTransform,
			},
			authStorage,
			sessionId,
		);

		return {
			provider: "parallel",
			sources: toSearchSources(result.sources, numResults),
			requestId: result.requestId,
		};
	} catch (err) {
		if (err instanceof ParallelApiError) {
			if (typeof err.statusCode === "number") {
				const classified = classifyProviderHttpError("parallel", err.statusCode, "");
				if (classified) throw classified;
			}
			throw new SearchProviderError("parallel", "Parallel search request failed.", err.statusCode);
		}
		throw err;
	}
}
