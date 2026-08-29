import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchMojeek } from "./mojeek-helpers";

export { searchMojeek };

export class MojeekProvider extends SearchProvider {
	readonly id = "mojeek";
	readonly label = "Mojeek";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchMojeek(params);
	}
}
