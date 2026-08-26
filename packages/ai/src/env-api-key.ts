/**
 * Which environment variable holds a provider's API key. Split from `stream.ts` (244 modules) so
 * `auth-storage.ts` and 18 web-search providers don't import the streaming engine for a lookup. Two-layer
 * table: `@veyyon/catalog` for plain names, `./provider-env-keys` for probes and unmodeled ids. The second
 * layer used to read off provider definitions (121 modules, 95 marginal); now it's a standalone table.
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
