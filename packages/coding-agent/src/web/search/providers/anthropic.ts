import type { AuthStorage } from "@veyyon/ai";
import { $env } from "@veyyon/utils";
import type { SearchResponse } from "../../../web/search/types";
import { searchAnthropic } from "./anthropic-helpers";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

export { searchAnthropic };

export class AnthropicProvider extends SearchProvider {
	readonly id = "anthropic";
	readonly label = "Anthropic";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return Boolean($env.ANTHROPIC_SEARCH_API_KEY) || authStorage.hasAuth("anthropic");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchAnthropic(params);
	}
}
