import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import type { ProviderTextTransformResolver } from "../../../provider-boundary";
import type { SearchProviderId, SearchResponse } from "../types";

/** Shared web search parameters passed to providers. `authStorage` is the **only** credential source providers may consult. */
export interface SearchParams {
	query: string;
	limit?: number;
	/** Temporal filter narrowing results to the specified time window. Providers MUST interpret this as a pure time filter. Providers MUST NOT */
	recency?: "day" | "week" | "month" | "year";
	systemPrompt: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	maxOutputTokens?: number;
	numSearchResults?: number;
	temperature?: number;
	googleSearch?: Record<string, unknown>;
	codeExecution?: Record<string, unknown>;
	urlContext?: Record<string, unknown>;
	/** Resolve the live final-seam transform again for every physical request. Providers must retain raw fields until after credential/auth awaits. */
	resolveProviderTextTransform?: ProviderTextTransformResolver;
	/** The single source of truth for credentials. Providers MUST consult this handle exclusively (`getApiKey` for bearer-style auth, `getOAuthAccess` */
	authStorage: AuthStorage;
	/** Optional session id used as the round-robin / sticky key when selecting among multiple credentials for the same provider. Pass through from the */
	sessionId?: string;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	geminiModel?: string;
}

/** Base class for web search providers. */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/** Indicates whether this provider has the credentials/config it needs to service a request right now. Implementations consult the passed */
	abstract isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean;

	/** Returns `true` when this provider should run when the user explicitly selects it, even if {@link isAvailable} would reject it for the auto */
	isExplicitlyAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return this.isAvailable(authStorage);
	}

	/**
	 * Execute a search. Credentials MUST be resolved through `params.authStorage`.
	 */
	abstract search(params: SearchParams): Promise<SearchResponse>;
}
