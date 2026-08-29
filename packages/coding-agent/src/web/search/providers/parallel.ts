import type { AuthStorage } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchParallel } from "./parallel-helpers";

export { searchParallel };

export class ParallelProvider extends SearchProvider {
	readonly id = "parallel";
	readonly label = "Parallel";

	isAvailable(authStorage: AuthStorage) {
		return !!getEnvApiKey("parallel") || authStorage.hasAuth("parallel");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchParallel(
			{
				query: params.query,
				num_results: params.numSearchResults ?? params.limit,
				signal: params.signal,
				fetch: params.fetch,
				resolveProviderTextTransform: params.resolveProviderTextTransform,
			},
			params.authStorage,
			params.sessionId,
		);
	}
}
