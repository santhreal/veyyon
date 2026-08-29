/** Kagi Web Search Provider Thin wrapper that adapts shared Kagi API utilities to SearchResponse shape. */
import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProvider } from "./base";
import type { SearchParamsWithFetch } from "./kagi-provider-helpers";

import { searchKagi } from "./kagi-provider-helpers";

export { searchKagi };

export class KagiProvider extends SearchProvider {
	readonly id = "kagi";
	readonly label = "Kagi";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("kagi");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		const fetchImpl = params.fetch;

		return searchKagi({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: fetchImpl,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
		});
	}
}
