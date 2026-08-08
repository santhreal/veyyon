import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "xAI",
	// `team/default` is the URL xAI's own docs link for key creation; the console redirects it
	// to whichever team the account actually owns.
	authUrl: "https://console.x.ai/team/default/api-keys",
	instructions: "Create or copy an API key from the xAI console",
	promptMessage: "Paste your xAI API key",
	placeholder: "xai-...",
	validation: {
		kind: "models-endpoint",
		provider: "xai",
		modelsUrl: "https://api.x.ai/v1/models",
	},
});

export const xaiProvider = {
	id: "xai",
	name: "xAI",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
