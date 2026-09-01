import { createApiKeyLogin } from "../api-key-login";

const AUTH_URL_INTL = "https://platform.minimax.io/subscribe/token-plan";
const AUTH_URL_CN = "https://platform.minimaxi.com/subscribe/token-plan";
const API_BASE_URL_INTL = "https://api.minimax.io/v1";
const API_BASE_URL_CN = "https://api.minimaxi.com/v1";
const VALIDATION_MODEL = "MiniMax-M3";

function createMiniMaxLogin(authUrl: string, baseUrl: string, provider: string) {
	return createApiKeyLogin({
		providerLabel: "MiniMax Token Plan",
		authUrl,
		instructions: "Subscribe to Token Plan and copy your API key",
		promptMessage: "Paste your MiniMax Token Plan API key",
		placeholder: "sk-...",
		validation: {
			kind: "chat-completions",
			provider,
			baseUrl,
			model: VALIDATION_MODEL,
		},
	});
}

export const loginMiniMaxCode = createMiniMaxLogin(AUTH_URL_INTL, API_BASE_URL_INTL, "MiniMax Token Plan");

export const loginMiniMaxCodeCn = createMiniMaxLogin(AUTH_URL_CN, API_BASE_URL_CN, "MiniMax Token Plan (China)");
