import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginNousResearch = createApiKeyLogin({
	providerLabel: "Nous Research",
	authUrl: "https://portal.nousresearch.com",
	instructions: "Create or copy your API key from the Nous Portal",
	promptMessage: "Paste your Nous Research API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "nous-research",
		baseUrl: "https://inference-api.nousresearch.com/v1",
		model: "nousresearch/hermes-4-70b",
	},
});

export const nousResearchProvider = {
	id: "nous-research",
	name: "Nous Research",
	login: (cb: Parameters<typeof loginNousResearch>[0]) => loginNousResearch(cb),
} as const satisfies ProviderDefinition;
