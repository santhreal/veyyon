import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// Every `await import` here is the registry's lazy boundary: the OAuth flow module stays out of the
// eager startup graph until a login or refresh runs.
async function refreshKimiCodeCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const { refreshKimiToken } = await import("./oauth/kimi");
	return refreshKimiToken(credentials.refresh, credentials.apiEndpoint);
}

/**
 * Kimi Code. The login asks which deployment the account belongs to, mainland China on kimi.com or
 * global on kimi.ai, and signs in there; the credential records its region, so refresh and every
 * request go to the same deployment.
 */
export const kimiCodeProvider = {
	id: "kimi-code",
	name: "Kimi Code",
	login: async (cb: OAuthLoginCallbacks) => {
		const { askKimiCodeRegion, loginKimi } = await import("./oauth/kimi");
		return loginKimi(cb, await askKimiCodeRegion(cb));
	},
	credential: "oauth",
	refreshToken: refreshKimiCodeCredentials,
} as const satisfies ProviderDefinition;
