import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "OpenAI",
	authUrl: "https://platform.openai.com/api-keys",
	instructions: "Create or copy a secret key from the OpenAI platform dashboard",
	promptMessage: "Paste your OpenAI API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "openai",
		modelsUrl: "https://api.openai.com/v1/models",
	},
});

export const openaiProvider = {
	id: "openai",
	name: "OpenAI",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
