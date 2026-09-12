import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://platform.parallel.ai/settings?tab=api-keys";

/**
 * Login to Parallel.
 *
 * Opens browser to the API keys page, prompts the user to paste their API key,
 * and returns the API key directly.
 */
export const loginParallel = createApiKeyLogin({
	providerLabel: "Parallel",
	authUrl: AUTH_URL,
	instructions: "Copy your Parallel API key from the Parallel settings page.",
	promptMessage: "Paste your Parallel API key",
	placeholder: "sk_...",
	validation: null,
});

export const parallelProvider = {
	id: "parallel",
	name: "Parallel",
	login: (cb: OAuthLoginCallbacks) => loginParallel(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
