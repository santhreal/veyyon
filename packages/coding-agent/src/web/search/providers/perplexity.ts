import type { AuthStorage } from "@veyyon/ai";
import {
	PERPLEXITY_HEADERS,
	PERPLEXITY_NATIVE_APP_API_VERSION,
	PERPLEXITY_NATIVE_APP_USER_AGENT,
	PERPLEXITY_WEB_ORIGIN,
} from "@veyyon/catalog/wire/perplexity";
import { $env } from "@veyyon/utils";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

export {
	PERPLEXITY_HEADERS,
	PERPLEXITY_NATIVE_APP_API_VERSION,
	PERPLEXITY_NATIVE_APP_USER_AGENT,
	PERPLEXITY_WEB_ORIGIN,
};

import { CHROME_DESKTOP_USER_AGENT } from "./browser-fingerprint-constants";

export { CHROME_DESKTOP_USER_AGENT };

import { searchPerplexity } from "./perplexity-helpers";

export { searchPerplexity } from "./perplexity-helpers";

export class PerplexityProvider extends SearchProvider {
	readonly id = "perplexity";
	readonly label = "Perplexity";

	isAvailable(authStorage: AuthStorage): boolean {
		return !!$env.PERPLEXITY_COOKIES?.trim() || authStorage.hasAuth("perplexity");
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPerplexity({
			signal: params.signal,
			query: params.query,
			temperature: params.temperature,
			max_tokens: params.maxOutputTokens,
			num_search_results: params.numSearchResults,
			system_prompt: params.systemPrompt,
			search_recency_filter: params.recency,
			num_results: params.limit,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
		});
	}
}
