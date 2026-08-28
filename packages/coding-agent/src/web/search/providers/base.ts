import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import type { ProviderTextTransformResolver } from "../../../provider-boundary";
import type { SearchProviderId, SearchResponse } from "../types";

export interface SearchParams {
	query: string;
	limit?: number;
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
	resolveProviderTextTransform?: ProviderTextTransformResolver;
	authStorage: AuthStorage;
	sessionId?: string;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	geminiModel?: string;
}

export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	abstract isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean;

	isExplicitlyAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return this.isAvailable(authStorage);
	}

	abstract search(params: SearchParams): Promise<SearchResponse>;
}
