import type { Api, ApiKeyResolver, AuthStorage, Model } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";

export type ApiKeyResolverModel = Pick<Model<Api>, "provider" | "baseUrl" | "id">;

export interface ApiKeyResolverOptions {
	sessionId?: string;
	baseUrl?: string;
	modelId?: string;
}

export interface ApiKeyResolverRegistry {
	getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined>;
	authStorage: Pick<AuthStorage, "rotateSessionCredential">;
	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
}

export function createApiKeyResolver(
	registry: Pick<ApiKeyResolverRegistry, "getApiKeyForProvider" | "authStorage">,
	provider: string,
	options: ApiKeyResolverOptions = {},
): ApiKeyResolver {
	const { sessionId, baseUrl, modelId } = options;
	return async ({ lastChance, error, signal, previousKey }) => {
		if (error === undefined) {
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId });
		}
		if (lastChance) {
			const switched = await registry.authStorage.rotateSessionCredential(provider, sessionId, {
				error,
				modelId,
				signal,
				apiKey: previousKey,
			});
			if (!switched) {
				if (AIError.isUsageLimit(error)) return undefined;
			}
			return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId });
		}
		return registry.getApiKeyForProvider(provider, sessionId, { baseUrl, modelId, forceRefresh: true, signal });
	};
}
