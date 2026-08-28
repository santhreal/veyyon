import * as AIError from "../error";
import {
	validateAnthropicCompatibleApiKey,
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "./api-key-validation";
import type { OAuthController } from "./oauth/types";

type ChatCompletionsValidation = {
	kind: "chat-completions";
	provider: string;
	baseUrl: string;
	model: string;
};

type AnthropicMessagesValidation = {
	kind: "anthropic-messages";
	provider: string;
	baseUrl: string;
	model: string;
};

type ModelsEndpointValidation = {
	kind: "models-endpoint";
	provider: string;
	modelsUrl: string;
	headers?: Record<string, string> | (() => Record<string, string> | undefined);
};

export type ApiKeyLoginConfig = {
	providerLabel: string;
	authUrl: string;
	instructions: string;
	promptMessage: string;
	placeholder: string;
	validation: ChatCompletionsValidation | AnthropicMessagesValidation | ModelsEndpointValidation | null;
};

export function createApiKeyLogin(config: ApiKeyLoginConfig): (options: OAuthController) => Promise<string> {
	return async function login(options: OAuthController): Promise<string> {
		if (!options.onPrompt) {
			throw new AIError.OnPromptRequiredError(config.providerLabel);
		}

		options.onAuth?.({
			url: config.authUrl,
			instructions: config.instructions,
		});

		const apiKey = await options.onPrompt({
			message: config.promptMessage,
			placeholder: config.placeholder,
			secret: true,
		});

		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const trimmed = apiKey.trim();
		if (!trimmed) {
			throw new AIError.ApiKeyRequiredError();
		}

		if (config.validation) {
			options.onProgress?.("Validating API key...");
			if (config.validation.kind === "chat-completions") {
				await validateOpenAICompatibleApiKey({
					provider: config.validation.provider,
					apiKey: trimmed,
					baseUrl: config.validation.baseUrl,
					model: config.validation.model,
					signal: options.signal,
					fetch: options.fetch,
				});
			} else if (config.validation.kind === "anthropic-messages") {
				await validateAnthropicCompatibleApiKey({
					provider: config.validation.provider,
					apiKey: trimmed,
					baseUrl: config.validation.baseUrl,
					model: config.validation.model,
					signal: options.signal,
					fetch: options.fetch,
				});
			} else {
				await validateApiKeyAgainstModelsEndpoint({
					provider: config.validation.provider,
					apiKey: trimmed,
					modelsUrl: config.validation.modelsUrl,
					headers: config.validation.headers,
					signal: options.signal,
					fetch: options.fetch,
				});
			}
		}

		return trimmed;
	};
}
