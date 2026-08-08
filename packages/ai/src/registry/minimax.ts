import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "MiniMax",
	// Pay-as-you-go keys, which is what this provider consumes. The Token Plan subscription key
	// lives on a different page and belongs to `minimax-code`.
	// https://platform.minimax.io/docs/guides/quickstart-preparation
	authUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
	instructions: "Create or copy an API key from the MiniMax platform user center",
	promptMessage: "Paste your MiniMax API key",
	// MiniMax issues long opaque tokens with no documented prefix.
	placeholder: "api-key",
	validation: {
		kind: "models-endpoint",
		provider: "minimax",
		modelsUrl: "https://api.minimax.io/v1/models",
	},
});

export const minimaxProvider = {
	id: "minimax",
	name: "MiniMax",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
