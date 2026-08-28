import type { AuthStorage, OAuthAccess } from "@veyyon/ai";
import { OPENROUTER_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { $env, decodeJwtPayload } from "@veyyon/utils";

export const PERPLEXITY_CHAT_BASE_URL = "https://api.perplexity.ai";
export const PERPLEXITY_RESPONSES_BASE_URL = "https://api.perplexity.ai/v1";
export const OPENROUTER_BASE_URL = OPENROUTER_API_ENDPOINT;
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface ApiConfig {
	type: "api_key";
	apiKey: string;
	provider: "perplexity" | "openrouter";
	chatBaseUrl: string;
	responsesBaseUrl: string;
	modelPrefix: string;
	useResponses: boolean;
}

export type PerplexityAuth =
	| ApiConfig
	| {
			type: "oauth";
			access: OAuthAccess;
	  }
	| {
			type: "cookies";
			cookies: string;
	  }
	| {
			type: "anonymous";
	  };

export interface PerplexityAuthOptions {
	signal?: AbortSignal;
	forceRefresh?: boolean;
}

export async function getApiConfigs(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<ApiConfig[]> {
	const useResponses = $env.VEYYON_PERPLEXITY_RESPONSES === "1";
	const configs: ApiConfig[] = [];

	if (authStorage.getCredentialOrigin("perplexity")?.kind !== "oauth") {
		const perplexityKey = await authStorage.getApiKey("perplexity", sessionId, options);
		if (perplexityKey) {
			configs.push({
				type: "api_key",
				apiKey: perplexityKey,
				provider: "perplexity",
				chatBaseUrl: PERPLEXITY_CHAT_BASE_URL,
				responsesBaseUrl: PERPLEXITY_RESPONSES_BASE_URL,
				modelPrefix: "",
				useResponses,
			});
		}
	}

	const openrouterKey = await authStorage.getApiKey("openrouter", sessionId, options);
	if (openrouterKey) {
		configs.push({
			type: "api_key",
			apiKey: openrouterKey,
			provider: "openrouter",
			chatBaseUrl: OPENROUTER_BASE_URL,
			responsesBaseUrl: OPENROUTER_BASE_URL,
			modelPrefix: "perplexity/",
			useResponses,
		});
	}

	return configs;
}

export function jwtExpiryMs(token: string): number | undefined {
	const decoded = decodeJwtPayload<{ exp?: unknown }>(token);
	if (!decoded || typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
	return decoded.exp * 1000;
}

export async function getAvailableAuthMethods(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	options?: PerplexityAuthOptions,
): Promise<PerplexityAuth[]> {
	const methods: PerplexityAuth[] = [];

	const cookies = $env.PERPLEXITY_COOKIES?.trim();
	if (cookies) {
		methods.push({ type: "cookies", cookies });
	}

	try {
		const access = await authStorage.getOAuthAccess("perplexity", sessionId, options);
		const token = access?.accessToken;
		if (access && token) {
			const jwtExpiry = jwtExpiryMs(token);
			if (jwtExpiry === undefined || jwtExpiry > Date.now() + OAUTH_EXPIRY_BUFFER_MS) {
				methods.push({ type: "oauth", access });
			}
		}
	} catch {}

	const apiConfigs = await getApiConfigs(authStorage, sessionId, options);
	for (let mi = 0; mi < apiConfigs.length; mi++) methods.push(apiConfigs[mi]!);

	if (methods.length === 0) {
		methods.push({ type: "anonymous" });
	}

	return methods;
}
