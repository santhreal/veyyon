import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchGoogle } from "./google-helpers";

export class GoogleProvider extends SearchProvider {
	readonly id = "google";
	readonly label = "Google";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGoogle(params);
	}
}
