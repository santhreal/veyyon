/**
 * Where the usage-provider table lives.
 */

import * as logger from "@veyyon/utils/logger";
import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";

const usageProviders = new Map<Provider, UsageProvider>();
const rankingStrategies = new Map<Provider, CredentialRankingStrategy>();
let populated = false;

/**
 * Fill the registry. Called once, at module scope, by `usage/defaults.ts`.
 *
 * Idempotent by overwrite rather than by refusal: a second call with the same table is harmless, and
 * a host that deliberately replaces a backend should be able to.
 */
export function registerUsageProviders(options: {
	providers: readonly UsageProvider[];
	rankingStrategies: readonly (readonly [Provider, CredentialRankingStrategy])[];
}): void {
	for (const provider of options.providers) usageProviders.set(provider.id, provider);
	for (const [provider, strategy] of options.rankingStrategies) rankingStrategies.set(provider, strategy);
	populated = true;
}

/** Whether anything has filled the registry yet. Exposed so a caller can branch instead of catching. */
export function usageProvidersRegistered(): boolean {
	return populated;
}

/**
 * Say so, once, when the registry is consulted before anything filled it.
 *
 * An empty table answers `undefined` for every provider, which reads exactly like "this provider
 * does not report usage" — so every quota would vanish from the UI and credential ranking would fall
 * back to the default rules, with nothing anywhere saying why. That is the silent-fallback shape,
 * and the whole point of moving the table out of the credential store was to make the wiring
 * explicit rather than accidental.
 *
 * It warns rather than throws, and the distinction is deliberate. `AuthStorage` reads the ranking
 * strategy on `getApiKey`, which is its primary job and has nothing to do with usage reporting;
 * refusing there would take a process that never wanted quota numbers and stop it selecting a
 * credential. So the fault is reported loudly, once, with the import that fixes it, and the caller
 * gets the honest `undefined`. Once, because an unfilled registry is consulted on every credential
 * lookup and a warning per call would bury itself.
 */
let warnedUnpopulated = false;
function warnIfUnpopulated(): void {
	if (populated || warnedUnpopulated) return;
	warnedUnpopulated = true;
	logger.warn(
		"usage-provider registry is empty: nothing has imported `@veyyon/ai/usage/defaults`, so no " +
			"provider can report quota and credential ranking has no strategies. Import it once on the " +
			"path that constructs AuthStorage, or pass `usageProviderResolver`/`rankingStrategyResolver` " +
			"explicitly if this process deliberately reports no usage.",
	);
}

/** The usage backend for a provider, or `undefined` when that provider reports no usage. */
export function resolveRegisteredUsageProvider(provider: Provider): UsageProvider | undefined {
	warnIfUnpopulated();
	return usageProviders.get(provider);
}

/** The credential-ranking strategy for a provider, or `undefined` when it ranks by the default rules. */
export function resolveRegisteredRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	warnIfUnpopulated();
	return rankingStrategies.get(provider);
}

/** Every provider that reports usage. Used by tests and by inventory surfaces, never on a hot path. */
export function listRegisteredUsageProviders(): UsageProvider[] {
	warnIfUnpopulated();
	return Array.from(usageProviders.values());
}
