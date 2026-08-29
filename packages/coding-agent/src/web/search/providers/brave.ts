/** Brave Web Search Provider Calls Brave's web search REST API and maps results into the unified */
import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { findApiKey, searchBrave } from "./brave-helpers";

export { searchBrave };

export class BraveProvider extends SearchProvider {
	readonly id = "brave";
	readonly label = "Brave";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("brave") || !!findApiKey();
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBrave({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			fetch: params.fetch,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
		});
	}
}
