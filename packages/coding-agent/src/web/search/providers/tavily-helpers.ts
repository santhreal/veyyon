import type { ApiKey, AuthStorage, FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { resolveProviderTextTransform, transformProviderPayload } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const DEFAULT_NUM_RESULTS = 5;
export const MAX_NUM_RESULTS = 20;

export interface TavilySearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	fetch?: FetchImpl;
	resolveProviderTextTransform?: SearchParams["resolveProviderTextTransform"];
}

export interface TavilySearchResult {
	title?: string | null;
	url?: string | null;
	content?: string | null;
	published_date?: string | null;
}

export interface TavilySearchResponse {
	answer?: string | null;
	results?: TavilySearchResult[];
	request_id?: string | null;
}

export async function findApiKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	return (await authStorage.getApiKey("tavily", sessionId, { signal })) ?? null;
}

export function buildRequestBody(params: TavilySearchParams): Record<string, unknown> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const body: Record<string, unknown> = {
		query: params.query,
		search_depth: "basic",
		max_results: numResults,
		include_answer: "advanced",
		include_raw_content: false,
	};
	if (params.recency) {
		body.time_range = params.recency;
	}
	return body;
}

export async function callTavilySearch(apiKey: string, params: TavilySearchParams): Promise<TavilySearchResponse> {
	return withHardTimeout(params.signal, async hardSignal => {
		const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, "Tavily search");
		const body = transformProviderPayload(buildRequestBody(params), transform, "Tavily search");
		const response = await (params.fetch ?? fetch)(TAVILY_SEARCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: hardSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("tavily", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError("tavily", `Tavily API request failed (${response.status}).`, response.status);
		}

		return (await response.json()) as TavilySearchResponse;
	});
}

export function toSearchResponse(response: TavilySearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];

	for (const result of response.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content ?? undefined,
			publishedDate: result.published_date ?? undefined,
			ageSeconds: dateToAgeSeconds(result.published_date ?? undefined),
		});
	}

	return {
		provider: "tavily",
		answer: response.answer?.trim() || undefined,
		sources: sources.slice(0, numResults),
		requestId: response.request_id ?? undefined,
		authMode: "api_key",
	};
}

export function hasRenderableResponse(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	return response.sources.length > 0;
}

export async function searchTavily(params: SearchParams): Promise<SearchResponse> {
	const tavilyParams: TavilySearchParams = {
		query: params.query,
		num_results: params.numSearchResults ?? params.limit,
		recency: params.recency,
		signal: params.signal,
		fetch: params.fetch,
		resolveProviderTextTransform: params.resolveProviderTextTransform,
	};
	const keyOrResolver: ApiKey = params.authStorage.resolver("tavily", {
		sessionId: params.sessionId,
	});

	const numResults = clampNumResults(tavilyParams.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const authOptions = {
		signal: params.signal,
		missingKeyMessage:
			'Tavily credentials not found. Set TAVILY_API_KEY or configure an API key for provider "tavily".',
	};
	const callWithAuth = (searchParams: TavilySearchParams) =>
		withAuth(keyOrResolver, key => callTavilySearch(key, searchParams), authOptions);

	const response = toSearchResponse(await callWithAuth(tavilyParams), numResults);
	if (!tavilyParams.recency || hasRenderableResponse(response)) {
		return response;
	}

	return toSearchResponse(await callWithAuth({ ...tavilyParams, recency: undefined }), numResults);
}
