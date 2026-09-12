import * as AIError from "../error";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const OLLAMA_CLOUD_KEYS_URL = "https://ollama.com/settings/keys";

const baseLoginOllamaCloud = createApiKeyLogin({
	providerLabel: "Ollama Cloud",
	authUrl: OLLAMA_CLOUD_KEYS_URL,
	instructions: "Create an Ollama Cloud API key, then paste it here.",
	promptMessage: "Paste your Ollama Cloud API key",
	placeholder: "ollama-cloud-api-key",
	validation: null,
	onPromptError: () => new AIError.ConfigurationError("Interactive prompt is required for Ollama Cloud login"),
	emptyKeyMessage: "Ollama Cloud API key is required",
});

export async function loginOllamaCloud(options: OAuthController): Promise<string> {
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	return baseLoginOllamaCloud(options);
}

export const ollamaCloudProvider = {
	id: "ollama-cloud",
	name: "Ollama Cloud",
	login: (cb: OAuthLoginCallbacks) => loginOllamaCloud(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
