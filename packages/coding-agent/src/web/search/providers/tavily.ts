import type { AuthStorage } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchTavily } from "./tavily-helpers";

export type { TavilySearchParams } from "./tavily-helpers";
export { buildRequestBody } from "./tavily-helpers";
export { searchTavily };

export class TavilyProvider extends SearchProvider {
	readonly id = "tavily";
	readonly label = "Tavily";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("tavily") || !!getEnvApiKey("tavily");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTavily(params);
	}
}
