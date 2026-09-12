import * as AIError from "../error";
import { promptApiKey } from "./api-key-login";
import { validateOpenAICompatibleApiKey } from "./api-key-validation";
import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://org.ngc.nvidia.com/setup/personal-keys";
const API_BASE_URL = "https://integrate.api.nvidia.com/v1";
const VALIDATION_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";
const PROVIDER_ID = "nvidia";

export async function loginNvidia(options: OAuthController): Promise<string> {
	const trimmed = await promptApiKey(options, {
		providerLabel: "NVIDIA",
		authUrl: AUTH_URL,
		instructions: "Copy your API key from NVIDIA NGC Personal Keys",
		promptMessage: "Paste your NVIDIA API key",
		placeholder: "nvapi-...",
	});

	options.onProgress?.("Validating API key (optional)...");
	try {
		await validateOpenAICompatibleApiKey({
			provider: PROVIDER_ID,
			apiKey: trimmed,
			baseUrl: API_BASE_URL,
			model: VALIDATION_MODEL,
			signal: options.signal,
			fetch: options.fetch,
		});
	} catch (error) {
		// A real auth rejection (401/403) is fatal; any other validation-endpoint
		// failure is non-fatal — skip validation and trust the supplied key.
		if (AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) {
			throw error;
		}
		options.onProgress?.("Skipping NVIDIA validation endpoint; continuing with provided API key.");
	}

	return trimmed;
}

export const nvidiaProvider = {
	id: "nvidia",
	name: "NVIDIA",
	login: (cb: OAuthLoginCallbacks) => loginNvidia(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
