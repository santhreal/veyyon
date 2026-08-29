import type { AuthStorage } from "@veyyon/ai";
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, getCodexAccountId } from "@veyyon/catalog/wire/codex";
import type { SearchResponse } from "../../../web/search/types";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

export { CODEX_BASE_URL, CODEX_CLIENT_VERSION, getCodexAccountId };

import { hasCodexSearch, searchCodex } from "./codex-helpers";

export { searchCodex } from "./codex-helpers";

export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
