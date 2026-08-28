import * as logger from "@veyyon/utils/logger";
import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";

const usageProviders = new Map<Provider, UsageProvider>();
const rankingStrategies = new Map<Provider, CredentialRankingStrategy>();
let populated = false;

/** Fill the registry with providers and ranking strategies. */
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

/** Warn once when the registry is consulted before being populated. */
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
