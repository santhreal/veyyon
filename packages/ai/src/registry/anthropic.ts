import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const anthropicProvider = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	// The env-key rule (Foundry mode switches Anthropic auth to enterprise gateway credentials) lives in
	// `../provider-env-keys.ts`, which is the one place a provider's credential probe is written and the one
	// module `getEnvApiKey` reads.
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginAnthropic } = await import("./oauth/anthropic");
		return loginAnthropic(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshAnthropicToken } = await import("./oauth/anthropic");
		return refreshAnthropicToken(credentials.refresh);
	},
	callbackPort: 54545,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
