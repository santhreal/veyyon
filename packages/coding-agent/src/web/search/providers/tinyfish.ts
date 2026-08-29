/** TinyFish Web Search Provider Calls TinyFish's search API and maps results into the unified */
import type { AuthStorage } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchTinyFish } from "./tinyfish-helpers";

export { searchTinyFish };

export class TinyFishProvider extends SearchProvider {
	readonly id = "tinyfish";
	readonly label = "TinyFish";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("tinyfish") || !!getEnvApiKey("tinyfish");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchTinyFish(params);
	}
}
