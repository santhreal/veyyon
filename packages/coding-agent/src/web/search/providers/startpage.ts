import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchStartpage } from "./startpage-helpers";

export { searchStartpage };

export class StartpageProvider extends SearchProvider {
	readonly id = "startpage";
	readonly label = "Startpage";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchStartpage(params);
	}
}
