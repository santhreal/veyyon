/** Whether a provider's stored credential counts as authenticated. This is a leaf on purpose. It has no imports and must not gain any. The two */

/** The credential a provider records when it needs no key at all. A local provider still has to store something, or an empty key would be */
export const kNoAuth = "N/A";

/** True when `apiKey` is a real credential rather than absent or the keyless sentinel. Narrows to `string`, so callers can use the key directly after the */
export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}
