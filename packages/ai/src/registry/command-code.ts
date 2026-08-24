import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginCommandCode = createApiKeyLogin({
	providerLabel: "Command Code",
	authUrl: "https://commandcode.ai/studio/provider",
	instructions: "Create or copy your API key from Command Code Studio's Provider page",
	promptMessage: "Paste your Command Code API key",
	placeholder: "sk-...",
	validation: {
		kind: "chat-completions",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		model: "moonshotai/Kimi-K2.7-Code",
	},
});

export const commandCodeProvider = {
	id: "command-code",
	name: "Command Code",
	login: loginCommandCode,
} as const satisfies ProviderDefinition;
