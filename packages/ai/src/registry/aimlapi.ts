import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "AIML API",
	authUrl: "https://aimlapi.com/app/keys",
	instructions: "Create or copy an API key from the AI/ML API dashboard",
	promptMessage: "Paste your AIML API key",
	// AI/ML API issues opaque keys with no documented prefix.
	placeholder: "api-key",
	// No validation: AI/ML API's model list is public (it answers 200 to an unauthenticated
	// request), so it cannot tell a good key from a bad one, and the only key-gated route is the
	// separate Management API, which rejects ordinary inference keys.
	validation: null,
});

export const aimlApiProvider = {
	id: "aimlapi",
	name: "AIML API",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
