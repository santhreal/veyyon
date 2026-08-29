/** Z.AI Web Search Provider Calls Z.AI's remote MCP server (`webSearchPrime`) and adapts results into */

import type { AuthStorage } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { ZaiProviderSearchParams } from "./zai-helpers";
import { searchZai } from "./zai-helpers";

export { searchZai } from "./zai-helpers";

export class ZaiProvider extends SearchProvider {
	readonly id = "zai";
	readonly label = "Z.AI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return authStorage.hasAuth("zai") || !!getEnvApiKey("zai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const { fetch: fetchOverride } = params as ZaiProviderSearchParams;
		return searchZai({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: fetchOverride,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
		});
	}
}
