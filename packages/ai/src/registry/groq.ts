import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "Groq",
	authUrl: "https://console.groq.com/keys",
	instructions: "Create or copy an API key from the Groq console",
	promptMessage: "Paste your Groq API key",
	placeholder: "gsk_...",
	validation: {
		kind: "models-endpoint",
		provider: "groq",
		modelsUrl: "https://api.groq.com/openai/v1/models",
	},
});

export const groqProvider = {
	id: "groq",
	name: "Groq",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
