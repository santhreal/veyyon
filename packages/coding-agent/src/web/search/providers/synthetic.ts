/** Synthetic Web Search Provider Uses Synthetic's zero-data-retention web search API for coding agents. */

import type { AuthStorage } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { SearchResponse } from "../../../web/search/types";
import { SearchProvider } from "./base";
import type { SearchParamsWithFetch } from "./synthetic-helpers";

import { searchSynthetic } from "./synthetic-helpers";

export class SyntheticProvider extends SearchProvider {
	readonly id = "synthetic";
	readonly label = "Synthetic";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("synthetic") || !!getEnvApiKey("synthetic");
	}

	search(params: SearchParamsWithFetch): Promise<SearchResponse> {
		return searchSynthetic(params);
	}
}
