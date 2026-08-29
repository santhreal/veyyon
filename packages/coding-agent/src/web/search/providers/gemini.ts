import type { AuthStorage } from "@veyyon/ai";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

import { DEVELOPER_API_PROVIDER, hasGeminiOAuth, searchGemini } from "./gemini-helpers";

export { buildGeminiRequestTools, geminiPerformedSearch, searchGemini } from "./gemini-helpers";

export class GeminiProvider extends SearchProvider {
	readonly id = "gemini";
	readonly label = "Gemini";

	isAvailable(authStorage: AuthStorage): boolean {
		return hasGeminiOAuth(authStorage) || authStorage.hasAuth(DEVELOPER_API_PROVIDER);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchGemini({
			query: params.query,
			system_prompt: params.systemPrompt,
			num_results: params.numSearchResults ?? params.limit,
			max_output_tokens: params.maxOutputTokens,
			temperature: params.temperature,
			google_search: params.googleSearch,
			code_execution: params.codeExecution,
			url_context: params.urlContext,
			signal: params.signal,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
			geminiModel: params.geminiModel,
			resolveProviderTextTransform: params.resolveProviderTextTransform,
		});
	}
}
