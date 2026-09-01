import type { ApiKey, AuthStorage, FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { resolveProviderTextTransform } from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { applyResultLimit } from "../utils";
import type { SearchParams } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

export const JINA_SEARCH_URL = "https://s.jina.ai";
export type SearchParamsWithFetch = SearchParams & { fetch?: FetchImpl };

export interface JinaSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	resolveProviderTextTransform?: SearchParams["resolveProviderTextTransform"];
	authStorage?: AuthStorage;
	sessionId?: string;
}

export interface JinaSearchResult {
	title?: string | null;
	url?: string | null;
	content?: string | null;
}

export type JinaSearchResponse = JinaSearchResult[];

/** Find JINA_API_KEY from environment or .env files. */
export function findApiKey(): string | null {
	return getEnvApiKey("jina") ?? null;
}

/** Call Jina Reader search API. */
export async function callJinaSearch(apiKey: string, params: JinaSearchParams): Promise<JinaSearchResponse> {
	const fetchImpl = params.fetch ?? fetch;
	return withHardTimeout(params.signal, async hardSignal => {
		const transform = resolveProviderTextTransform(params.resolveProviderTextTransform, "Jina search");
		const requestUrl = `${JINA_SEARCH_URL}/${encodeURIComponent(transform(params.query))}`;
		const response = await fetchImpl(requestUrl, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal: hardSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("jina", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError("jina", `Jina API request failed (${response.status}).`, response.status);
		}

		const payload = (await response.json()) as { data?: JinaSearchResponse } | null;
		return Array.isArray(payload?.data) ? payload.data : [];
	});
}

/** Execute Jina web search. */
export async function searchJina(params: JinaSearchParams): Promise<SearchResponse> {
	const keyOrResolver: ApiKey | undefined = params.authStorage
		? params.authStorage.resolver("jina", { sessionId: params.sessionId })
		: (findApiKey() ?? undefined);

	const response = await withAuth(keyOrResolver, key => callJinaSearch(key, params), {
		signal: params.signal,
		missingKeyMessage: 'Jina credentials not found. Set JINA_API_KEY or configure an API key for provider "jina".',
	});
	const sources: SearchSource[] = [];

	for (const result of response) {
		if (!result?.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.content ?? undefined,
		});
	}

	return {
		provider: "jina",
		sources: applyResultLimit(sources, params.num_results),
	};
}

/** Search provider for Jina Reader. */
