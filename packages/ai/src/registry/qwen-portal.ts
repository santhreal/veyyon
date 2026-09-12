import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://chat.qwen.ai";
const API_BASE_URL = "https://portal.qwen.ai/v1";
const VALIDATION_MODEL = "coder-model";

export const loginQwenPortal = createApiKeyLogin({
	providerLabel: "Qwen Portal",
	authUrl: AUTH_URL,
	instructions: "Copy your Qwen OAuth token or API key",
	promptMessage: "Paste your Qwen OAuth token or API key",
	placeholder: "sk-...",
	emptyKeyMessage: "Qwen token/API key is required",
	progressMessage: "Validating credentials...",
	validation: {
		kind: "chat-completions",
		provider: "qwen-portal",
		baseUrl: API_BASE_URL,
		model: VALIDATION_MODEL,
	},
});

export const qwenPortalProvider = {
	id: "qwen-portal",
	name: "Qwen Portal",
	login: (cb: OAuthLoginCallbacks) => loginQwenPortal(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
