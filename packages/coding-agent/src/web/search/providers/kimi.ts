/** Kimi Web Search Provider Uses Moonshot Kimi Code search API to retrieve web results. */
import type { AuthStorage } from "@veyyon/ai";
import { $env } from "@veyyon/utils";

import type { SearchResponse } from "../../../web/search/types";
import { SearchProvider } from "./base";
import type { SearchParamsWithFetch } from "./kimi-helpers";

import { asTrimmed, searchKimi } from "./kimi-helpers";

export class KimiProvider extends SearchProvider {
	readonly id = "kimi";
	readonly label = "Kimi";

	isAvailable(authStorage: AuthStorage): boolean {
		return (
			!!asTrimmed($env.MOONSHOT_SEARCH_API_KEY) ||
			!!asTrimmed($env.KIMI_SEARCH_API_KEY) ||
			authStorage.hasAuth("moonshot") ||
			authStorage.hasAuth("kimi-code")
		);
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		const fetchImpl = params.fetch;

		return searchKimi({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: fetchImpl,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
		});
	}
}
