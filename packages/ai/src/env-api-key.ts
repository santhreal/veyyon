/**
 * Which environment variable holds a provider's API key.
 */
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { $env, $pickenv } from "@veyyon/utils/env";
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
