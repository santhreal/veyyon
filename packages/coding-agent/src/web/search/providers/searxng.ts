import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { findEndpoint, searchSearXNG } from "./searxng-helpers";

export { searchSearXNG };

export class SearXNGProvider extends SearchProvider {
	readonly id = "searxng";
	readonly label = "SearXNG";

	isAvailable(_authStorage: AuthStorage): boolean {
		try {
			return !!findEndpoint();
		} catch {
			return false;
		}
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchSearXNG({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			fetch: params.fetch,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
		});
	}
}
