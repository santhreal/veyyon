/**
 * OpenCode Zen login flow.
 *
 * OpenCode Zen is a subscription service that provides access to various AI models
 * (GPT-5.x, Claude 4.x, Gemini 3, etc.) through a unified API at opencode.ai/zen.
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to https://opencode.ai/auth
 * 2. User logs in and copies their API key
 * 3. User pastes the API key back into the CLI
 */

import { createApiKeyLogin } from "../api-key-login";

const AUTH_URL = "https://opencode.ai/auth";

/**
 * Login to OpenCode Zen.
 *
 * Opens browser to auth page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginOpenCode = createApiKeyLogin({
	providerLabel: "OpenCode Zen",
	authUrl: AUTH_URL,
	instructions: "Log in and copy your API key",
	promptMessage: "Paste your OpenCode Zen API key",
	placeholder: "sk-...",
	validation: null,
});
