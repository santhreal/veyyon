import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "Mistral",
	authUrl: "https://console.mistral.ai/api-keys",
	instructions: "Create or copy an API key from the Mistral console",
	promptMessage: "Paste your Mistral API key",
	// Mistral keys are opaque alphanumeric strings; the console documents no prefix to hint at.
	placeholder: "api-key",
	validation: {
		kind: "models-endpoint",
		provider: "mistral",
		modelsUrl: "https://api.mistral.ai/v1/models",
	},
});

export const mistralProvider = {
	id: "mistral",
	name: "Mistral",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
