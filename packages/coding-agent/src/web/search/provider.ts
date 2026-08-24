// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// Provider modules are loaded lazily; display metadata lives in types.ts so UI
// listings can share it without importing provider implementations.

import type { AuthStorage } from "@veyyon/ai";
import type { SearchProvider } from "./providers/base";
import { SEARCH_PROVIDER_LABELS, SEARCH_PROVIDER_ORDER, SearchProviderError, type SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";
export { SEARCH_PROVIDER_ORDER } from "./types";

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
	perplexity: {
		id: "perplexity",
		label: SEARCH_PROVIDER_LABELS.perplexity,
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	gemini: {
		id: "gemini",
		label: SEARCH_PROVIDER_LABELS.gemini,
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	anthropic: {
		id: "anthropic",
		label: SEARCH_PROVIDER_LABELS.anthropic,
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	codex: {
		id: "codex",
		label: SEARCH_PROVIDER_LABELS.codex,
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	xai: {
		id: "xai",
		label: SEARCH_PROVIDER_LABELS.xai,
		load: async () => new (await import("./providers/xai")).XAIProvider(),
	},
	zai: {
		id: "zai",
		label: SEARCH_PROVIDER_LABELS.zai,
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	exa: {
		id: "exa",
		label: SEARCH_PROVIDER_LABELS.exa,
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	tinyfish: {
		id: "tinyfish",
		label: SEARCH_PROVIDER_LABELS.tinyfish,
		load: async () => new (await import("./providers/tinyfish")).TinyFishProvider(),
	},
	jina: {
		id: "jina",
		label: SEARCH_PROVIDER_LABELS.jina,
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	kagi: {
		id: "kagi",
		label: SEARCH_PROVIDER_LABELS.kagi,
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	tavily: {
		id: "tavily",
		label: SEARCH_PROVIDER_LABELS.tavily,
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	firecrawl: {
		id: "firecrawl",
		label: SEARCH_PROVIDER_LABELS.firecrawl,
		load: async () => new (await import("./providers/firecrawl")).FirecrawlProvider(),
	},
	brave: {
		id: "brave",
		label: SEARCH_PROVIDER_LABELS.brave,
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	kimi: {
		id: "kimi",
		label: SEARCH_PROVIDER_LABELS.kimi,
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	parallel: {
		id: "parallel",
		label: SEARCH_PROVIDER_LABELS.parallel,
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	synthetic: {
		id: "synthetic",
		label: SEARCH_PROVIDER_LABELS.synthetic,
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		id: "searxng",
		label: SEARCH_PROVIDER_LABELS.searxng,
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
	duckduckgo: {
		id: "duckduckgo",
		label: SEARCH_PROVIDER_LABELS.duckduckgo,
		load: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
	},
	google: {
		id: "google",
		label: SEARCH_PROVIDER_LABELS.google,
		load: async () => new (await import("./providers/google")).GoogleProvider(),
	},
	ecosia: {
		id: "ecosia",
		label: SEARCH_PROVIDER_LABELS.ecosia,
		load: async () => new (await import("./providers/ecosia")).EcosiaProvider(),
	},
	startpage: {
		id: "startpage",
		label: SEARCH_PROVIDER_LABELS.startpage,
		load: async () => new (await import("./providers/startpage")).StartpageProvider(),
	},
	mojeek: {
		id: "mojeek",
		label: SEARCH_PROVIDER_LABELS.mojeek,
		load: async () => new (await import("./providers/mojeek")).MojeekProvider(),
	},
	public: {
		id: "public",
		label: SEARCH_PROVIDER_LABELS.public,
		load: async () => new (await import("./providers/public")).PublicWebProvider(),
	},
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return PROVIDER_META[id]?.label ?? id;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(
	failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/**
 * Resolve and cache a provider instance. First call for a given id loads the
 * underlying module; subsequent calls return the cached singleton.
 */
export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const meta = PROVIDER_META[id];
	if (!meta) {
		throw new Error(`Unknown search provider: ${id}`);
	}
	const provider = await meta.load();
	instanceCache.set(id, provider);
	return provider;
}

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Providers excluded from web search resolution via settings. */
let excludedProvIds = new Set<SearchProviderId>();

/** Set providers that web search should never use, including fallbacks. */
export function setExcludedSearchProviders(providers: readonly SearchProviderId[]): void {
	excludedProvIds = new Set(providers);
}

/** `true` when settings exclude `id` from web search (auto chain and the Public Web fan-out). */
export function isSearchProviderExcluded(id: SearchProviderId): boolean {
	return excludedProvIds.has(id);
}

export interface SearchProviderCandidate {
	id: SearchProviderId;
	explicit: boolean;
}

/**
 * The providers a search may use, in the order it may try them.
 *
 * A CHOSEN provider is the only provider. `auto` is what ranges over the chain, and
 * that difference is the whole content of the setting: the chosen provider used to be
 * pushed to the front of the full chain, so picking Public Web meant "Public Web
 * first, then Brave, then Exa, then everything else", and a chosen engine that
 * answered with nothing handed the query to a different engine. `auto` and an explicit
 * choice then differed only in ordering, which made the setting almost inert and made
 * the fan-out impossible to confine: an operator who picks the credential-free
 * engines on purpose does not want a keyed provider reached behind their back.
 *
 * A chosen provider that is excluded resolves to NO candidate rather than silently to
 * the chain, because the two settings then contradict each other and the caller has to
 * say so. `providers.webSearchExclude` remains the way to keep a provider out of the
 * `auto` chain.
 */
export function resolveProviderCandidates(
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): SearchProviderCandidate[] {
	if (preferredProvider !== "auto") {
		return isSearchProviderExcluded(preferredProvider) ? [] : [{ id: preferredProvider, explicit: true }];
	}

	const candidates: SearchProviderCandidate[] = [];
	for (const id of SEARCH_PROVIDER_ORDER) {
		if (isSearchProviderExcluded(id)) continue;
		candidates.push({ id, explicit: false });
	}

	return candidates;
}

/** What a search may use, or why it may use nothing. */
export type SearchProviderSelection =
	| { readonly candidates: readonly SearchProviderCandidate[] }
	| { readonly refusal: string };

/**
 * The providers one call may use, given what the call asked for and what settings allow.
 *
 * One owner for the whole decision, because it used to be split: the setting was read
 * here and the per-call `provider` argument was resolved in the search loop, where an
 * argument naming an unavailable provider fell through to the entire `auto` chain. Both
 * halves had the same defect and only one of them was ever fixed at a time.
 *
 * A choice is honoured or refused, never widened. An operator or a caller that names an
 * engine is answering "which engine", and a search that answers with a different one has
 * substituted its own answer — the fan-out case makes that concrete, since somebody who
 * picks the credential-free engines does not want a keyed provider reached on their
 * behalf. `auto` is the value that means "any of them", and exclusions narrow it.
 *
 * A contradiction is a refusal with the settings named in it, not a silent fallback: a
 * chosen provider that is also excluded, or an `auto` chain with nothing left in it, are
 * both configurations that cannot be satisfied, and the caller has to be told which two
 * settings disagree rather than shown results from an engine it did not choose.
 */
export function selectSearchProviders(
	requested?: SearchProviderId | "auto",
	preferred: SearchProviderId | "auto" = preferredProvId,
): SearchProviderSelection {
	const chosen = requested ?? preferred;
	if (chosen !== "auto") {
		if (!isSearchProviderExcluded(chosen)) return { candidates: [{ id: chosen, explicit: true }] };
		const source = requested === undefined ? "providers.webSearch" : "the provider argument";
		return {
			refusal:
				`${getSearchProviderLabel(chosen)} is named by ${source} and excluded by ` +
				`providers.webSearchExclude. Remove the exclusion, or choose another provider.`,
		};
	}

	const candidates = resolveProviderCandidates("auto");
	if (candidates.length > 0) return { candidates };
	return {
		refusal:
			`providers.webSearchExclude excludes every one of the ${SEARCH_PROVIDER_ORDER.length} web search ` +
			`providers, so there is nothing left for auto-selection to try.`,
	};
}

/**
 * Resolve the complete available provider chain.
 *
 * This compatibility helper loads every candidate. Search execution should use
 * {@link resolveProviderCandidates} so fallback modules load only when reached.
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	preferredProvider: SearchProviderId | "auto" = preferredProvId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	for (const candidate of resolveProviderCandidates(preferredProvider)) {
		const provider = await getSearchProvider(candidate.id);
		const available = candidate.explicit
			? await provider.isExplicitlyAvailable(authStorage)
			: await provider.isAvailable(authStorage);
		if (available) providers.push(provider);
	}

	return providers;
}
