import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// Every `await import` here is the registry's lazy boundary: the OAuth flow module stays out of the
// eager startup graph until a login or refresh runs.
async function refreshKimiCodeCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const { refreshKimiToken } = await import("./oauth/kimi");
	return refreshKimiToken(credentials.refresh, credentials.apiEndpoint);
}

/** Kimi Code accounts of mainland China, which sign in at kimi.com. */
export const kimiCodeProvider = {
	id: "kimi-code",
	name: "Kimi Code (kimi.com/code)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginKimi } = await import("./oauth/kimi");
		return loginKimi(cb, "mainland-cn");
	},
	credential: "oauth",
	refreshToken: refreshKimiCodeCredentials,
} as const satisfies ProviderDefinition;

/**
 * Kimi Code accounts outside mainland China, which sign in at kimi.ai. The credential is the same
 * product's and is filed under `kimi-code`; it records its region, so refresh and every request go to
 * kimi.ai.
 */
export const kimiCodeGlobalProvider = {
	id: "kimi-code-global",
	name: "Kimi Code (kimi.ai/code)",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginKimi } = await import("./oauth/kimi");
		return loginKimi(cb, "global");
	},
	credential: "oauth",
	refreshToken: refreshKimiCodeCredentials,
	storeCredentialsAs: "kimi-code",
} as const satisfies ProviderDefinition;
