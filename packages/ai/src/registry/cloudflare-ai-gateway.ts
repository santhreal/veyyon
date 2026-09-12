import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://developers.cloudflare.com/ai-gateway/configuration/authentication/";

/**
 * Login to Cloudflare AI Gateway.
 *
 * Opens browser to Cloudflare AI Gateway authentication docs and prompts for a gateway token/API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginCloudflareAiGateway = createApiKeyLogin({
	providerLabel: "Cloudflare AI Gateway",
	authUrl: AUTH_URL,
	instructions: "Copy your Cloudflare AI Gateway token/API key. Configure account/gateway base URL in models config.",
	promptMessage: "Paste your Cloudflare AI Gateway token/API key",
	placeholder: "cf-aig-...",
	validation: null,
});

export const cloudflareAiGatewayProvider = {
	id: "cloudflare-ai-gateway",
	name: "Cloudflare AI Gateway",
	login: (cb: OAuthLoginCallbacks) => loginCloudflareAiGateway(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
