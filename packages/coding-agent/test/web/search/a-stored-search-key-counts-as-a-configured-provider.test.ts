/**
 * WHY: a search provider is offered to the user when `isAvailable` says a credential exists. Brave
 * and Jina answered that question from environment variables alone and ignored the credential
 * store, so a key configured through the provider page was invisible: the provider reported itself
 * unavailable, the chain skipped it, and nothing said why.
 *
 * The class is "one provider resolves credentials differently from its siblings". Eleven of the
 * thirteen key-backed providers already consulted the store; the two that did not were the ones
 * nobody had swept. So this suite does not test Brave and Jina — it sweeps every provider the
 * registry lists and requires each to honour a stored key, with the credential-free engines pinned
 * by exact equality rather than by count.
 *
 * Adding a provider therefore turns this suite red until it either honours a stored key or is
 * recorded below as credential-free.
 *
 * What it does not catch: whether the key the provider then sends upstream is the stored one, and
 * providers whose credential lives under a different id than their own (Gemini, Kimi and the
 * OAuth-backed engines are recorded as exceptions here for exactly that reason).
 */

import { describe, expect, it } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import { getSearchProvider } from "@veyyon/coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER, type SearchProviderId } from "@veyyon/coding-agent/web/search/types";

/**
 * Providers that do not become available from a credential stored under their own id: `public` is
 * the credential-free engine group, `searxng` is self-hosted and takes no key, and Gemini and Kimi
 * hold their credential under a different provider id than their own. Pinned exactly, so a new
 * provider is not silently absorbed.
 */
const NOT_AVAILABLE_FROM_A_KEY_UNDER_ITS_OWN_ID: readonly SearchProviderId[] = ["gemini", "kimi", "public", "searxng"];

/**
 * Providers that need no credential at all: the free engines, and Codex, which reaches search
 * through the session's own grant. Pinned exactly, so a provider that starts offering itself with
 * nothing configured turns this red. `public` is absent because it fronts the free engines rather
 * than being selectable itself, so it reports unavailable in both directions.
 */
const AVAILABLE_WITHOUT_ANY_CREDENTIAL: readonly SearchProviderId[] = [
	"codex",
	"duckduckgo",
	"google",
	"mojeek",
	"startpage",
];

/** A store that holds a credential for exactly one provider id and nothing else. */
function storeHolding(providerId: string): AuthStorage {
	return {
		hasAuth: (id: string) => id === providerId,
		hasOAuth: () => false,
		getCredentialOrigin: () => undefined,
		getOAuthAccountId: () => undefined,
		async getOAuthAccess() {
			return undefined;
		},
		async getApiKey() {
			return undefined;
		},
		listAuthCredentials: () => [],
	} as unknown as AuthStorage;
}

/** A store that holds nothing at all. */
const EMPTY_STORE: AuthStorage = storeHolding("\u0000none");

describe("a key stored under a provider's own id", () => {
	it("makes that provider available, for every provider the registry lists", async () => {
		const ignoredStoredKey: SearchProviderId[] = [];

		for (const id of SEARCH_PROVIDER_ORDER) {
			const provider = await getSearchProvider(id);
			if (!provider.isAvailable(storeHolding(id))) {
				ignoredStoredKey.push(id);
			}
		}

		expect(ignoredStoredKey.sort()).toEqual([...NOT_AVAILABLE_FROM_A_KEY_UNDER_ITS_OWN_ID].sort());
	});

	it("is what makes them available, so an empty store leaves every key-backed provider out", async () => {
		const availableWithNothingStored: SearchProviderId[] = [];

		for (const id of SEARCH_PROVIDER_ORDER) {
			const provider = await getSearchProvider(id);
			if (provider.isAvailable(EMPTY_STORE)) {
				availableWithNothingStored.push(id);
			}
		}

		expect(availableWithNothingStored.sort()).toEqual([...AVAILABLE_WITHOUT_ANY_CREDENTIAL].sort());
	});

	it("reaches Brave and Jina, the two the sweep was written for", async () => {
		const brave = await getSearchProvider("brave");
		const jina = await getSearchProvider("jina");

		expect(brave.isAvailable(storeHolding("brave"))).toBe(true);
		expect(jina.isAvailable(storeHolding("jina"))).toBe(true);
		expect(brave.isAvailable(storeHolding("jina"))).toBe(false);
		expect(jina.isAvailable(storeHolding("brave"))).toBe(false);
	});
});
