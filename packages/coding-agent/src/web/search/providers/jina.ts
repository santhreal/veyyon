/** Jina Reader Web Search Provider Uses the Jina Reader `s.jina.ai` endpoint to fetch search results with */

import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProvider } from "./base";
import type { SearchParamsWithFetch } from "./jina-helpers";

import { findApiKey, searchJina } from "./jina-helpers";

export class JinaProvider extends SearchProvider {
	readonly id = "jina";
	readonly label = "Jina";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("jina") || !!findApiKey();
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		const fetchImpl = params.fetch;

		return searchJina({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			fetch: fetchImpl,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
