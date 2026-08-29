import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchPublicWeb } from "./public-helpers";

export type { MergedSource } from "./public-helpers";
export { dedupKey, mergeSources, PUBLIC_ENGINE_IDS } from "./public-helpers";
export { searchPublicWeb };

export class PublicWebProvider extends SearchProvider {
	readonly id = "public";
	readonly label = "Public Web";

	isAvailable(_authStorage: AuthStorage): boolean {
		return false;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPublicWeb(params);
	}
}
