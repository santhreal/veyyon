import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const login = createApiKeyLogin({
	providerLabel: "Google Gemini",
	authUrl: "https://aistudio.google.com/apikey",
	instructions: "Create or copy a Gemini API key in Google AI Studio",
	promptMessage: "Paste your Google Gemini API key",
	// AI Studio has started issuing keys with a new prefix alongside the long-standing `AIza`
	// one, so there is no single prefix that is safe to show as a hint.
	placeholder: "api-key",
	validation: {
		kind: "models-endpoint",
		provider: "google",
		// The native `v1beta/models` route authenticates with an `x-goog-api-key` header, which this
		// validator does not send. The OpenAI-compatibility route takes `Authorization: Bearer` and is
		// the documented way to list models with a Gemini key.
		// https://ai.google.dev/gemini-api/docs/openai
		modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
	},
});

export const googleProvider = {
	id: "google",
	name: "Google Gemini",
	login: (cb: OAuthLoginCallbacks) => login(cb),
} as const satisfies ProviderDefinition;
