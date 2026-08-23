import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginCohere = createApiKeyLogin({
	providerLabel: "Cohere",
	authUrl: "https://dashboard.cohere.com/api-keys",
	instructions: "Copy your API key from the Cohere dashboard",
	promptMessage: "Paste your Cohere API key",
	placeholder: "co-...",
	validation: {
		kind: "chat-completions",
		provider: "cohere",
		baseUrl: "https://api.cohere.ai/compatibility/v1",
		model: "command-a-03-2025",
	},
});

export const cohereProvider = {
	id: "cohere",
	name: "Cohere",
	login: (cb: Parameters<typeof loginCohere>[0]) => loginCohere(cb),
} as const satisfies ProviderDefinition;
