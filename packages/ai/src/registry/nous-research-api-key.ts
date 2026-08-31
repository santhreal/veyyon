import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

/**
 * Nous Research, reached with a Portal API key instead of the device-code flow.
 *
 * A provider entry describes one login MECHANISM, and Nous offers two: the OAuth
 * device flow in `nous-research`, and a key pasted from the Portal. The second
 * entry exists because `ProviderDefinition` carries a single `login`, not because
 * this is a second product — `storeCredentialsAs` files the key under
 * `nous-research`, which is the id the model manager, the account card and the
 * model list all read. Anyone holding a key was otherwise told to complete a
 * browser round trip they had no need for.
 */
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
