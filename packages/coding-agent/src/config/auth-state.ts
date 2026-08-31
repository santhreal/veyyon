/**
 * Whether a provider's stored credential counts as authenticated.
 *
 * This is a leaf on purpose. It has no imports and must not gain any. The two
 * definitions below used to live in `./model-registry`, which meant that
 * `./model-resolver` (the only other module that needs them) had to import the
 * registry for a one-line predicate, while the registry imported the resolver
 * for `parseModelString`. That mutual import made the two files a cycle, so
 * every module reaching either one instantiated both, and both are large.
 *
 * Import from here, not from `./model-registry`.
 */

/**
 * The credential a provider records when it needs no key at all.
 *
 * A local provider still has to store something, or an empty key would be
 * indistinguishable from "never configured" and the provider would be treated
 * as unauthenticated. This sentinel says "configured, and deliberately keyless"
 * so `isAuthenticated` can reject it without rejecting the provider.
 */
export const kNoAuth = "N/A";

/**
 * True when `apiKey` is a real credential rather than absent or the keyless
 * sentinel. Narrows to `string`, so callers can use the key directly after the
 * check instead of asserting it again.
 */
export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}
