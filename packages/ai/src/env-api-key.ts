/**
 * Which environment variable holds a provider's API key.
 *
 * WHY THIS IS ITS OWN MODULE. These four functions are a lookup over a table. They used to live in
 * `stream.ts`, which is the streaming engine: it reaches 244 modules, and `auth-storage.ts` imported
 * it for `getEnvApiKey` alone, which is most of why `auth-storage.ts` reached 276 and why the
 * `@veyyon/ai` barrel is a mesh no subpath import can escape. Eighteen web-search providers in
 * `@veyyon/coding-agent` want nothing from this package except `getEnvApiKey` and `withAuth`, and
 * every one of them was declaring a dependency on the stream engine, every provider transport and
 * every usage backend to ask which env var to read.
 *
 * The table itself has two layers and the order matters. `@veyyon/catalog` is the source for plain
 * provider env-var names, so it goes first. `./provider-env-keys` merges over it, because some providers
 * cannot be described by a variable name at all -- Foundry, Vertex ADC and Bedrock probe for credentials
 * and need a function -- and because search tools and local servers have keys but no catalog entry.
 *
 * That second layer used to be read off the provider DEFINITIONS plus a `LEGACY_ENV_KEYS` block declared
 * here, which meant this lookup imported `./registry` (121 modules, 95 of them marginal) to read one field.
 * A provider's credential rule is small and self-contained; the definition it hung on is not.
 *
 * `@veyyon/ai` still re-exports all four names, so nothing outside this package changed: the owner
 * moved, it was not duplicated.
 */
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
// The owner, not the `@veyyon/utils` barrel: `@veyyon/utils/env` is 21 modules against 82, and both names
// are defined there. It matters here more than in most places. Eighteen web-search providers in
// `@veyyon/coding-agent` import this module for one env-var lookup, and so does `web/parallel.ts`, which
// `tools/fetch.ts` and therefore `tools/read.ts` reach; the barrel was 61 of those modules and none of them
// were the catalog table this lookup actually needs.
import { $env, $pickenv } from "@veyyon/utils/env";
// The overrides table, NOT `./registry`. The registry is 121 modules and was 95 MARGINAL on this lookup,
// because the rule used to hang on each provider DEFINITION and a definition carries login flows,
// transports and model lists. `./provider-env-keys` is that rule and nothing else.
import { type KeyResolver, PROVIDER_ENV_KEY_OVERRIDES } from "./provider-env-keys";

/**
 * Env fallbacks derived from the catalog table — the single source for plain
 * provider env-var names. `./provider-env-keys` merges over these with the computed resolvers
 * (Foundry/ADC/Bedrock probes) and the ids the catalog does not model.
 */
const CATALOG_ENTRY_ENV_KEYS = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => {
	const envVars = provider.envVars;
	if (!envVars || envVars.length === 0) return [];
	const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars);
	return [[provider.id, resolver] as [string, KeyResolver]];
});

const serviceProviderMap: Record<string, KeyResolver> = {
	...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
	...PROVIDER_ENV_KEY_OVERRIDES,
};

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 * Checks Bun.env, then cwd/.env, then ~/.env.
 */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}

/**
 * Name of the environment variable that backs `getEnvApiKey` for a provider,
 * when that provider maps to a single named variable (e.g. `github-copilot` →
 * `COPILOT_GITHUB_TOKEN`). Returns undefined for providers whose env fallback
 * is computed (multi-var pickers, Vertex ADC / Bedrock probes, …) since no
 * single variable name describes the source.
 */
export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}

/**
 * Enumerate every provider that has an env-var fallback for `getEnvApiKey`.
 * Used by `veyyon auth-broker migrate --include-env` to discover env-sourced keys
 * that should be uploaded to the broker.
 */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}
