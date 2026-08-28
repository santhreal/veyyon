import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginNousResearchApiKey = createApiKeyLogin({
	providerLabel: "Nous Research",
	authUrl: "https://portal.nousresearch.com/api-keys",
	instructions: "Create or copy an API key from the Nous Research Portal",
	promptMessage: "Paste your Nous Research API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "nous-research",
		modelsUrl: "https://inference-api.nousresearch.com/v1/models",
	},
});

export const nousResearchApiKeyProvider = {
	id: "nous-research-api-key",
	name: "Nous Research (API key)",
	login: loginNousResearchApiKey,
	storeCredentialsAs: "nous-research",
} as const satisfies ProviderDefinition;
