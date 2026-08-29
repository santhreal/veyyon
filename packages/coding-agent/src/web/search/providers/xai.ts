import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchXAI, shouldPreferXAIOAuth } from "./xai-helpers";

export { searchXAI } from "./xai-helpers";

export class XAIProvider extends SearchProvider {
	readonly id = "xai";
	readonly label = "xAI";

	isAvailable(authStorage: AuthStorage): boolean {
		return shouldPreferXAIOAuth(authStorage) || authStorage.hasAuth("xai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchXAI(params);
	}
}
