/** Firecrawl Web Search Provider Calls Firecrawl's search API and maps web results into the unified */
import type { AuthStorage } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchFirecrawl } from "./firecrawl-helpers";

export { searchFirecrawl };

export class FirecrawlProvider extends SearchProvider {
	readonly id = "firecrawl";
	readonly label = "Firecrawl";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("firecrawl") || !!getEnvApiKey("firecrawl");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchFirecrawl(params);
	}
}
