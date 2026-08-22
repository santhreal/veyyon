import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getSearchProviderLabel,
	resolveProviderCandidates,
	setExcludedSearchProviders,
} from "@veyyon/coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER, type SearchProviderId } from "@veyyon/coding-agent/web/search/types";

/**
 * resolveProviderCandidates builds the web-search candidate list WITHOUT loading any provider
 * module, and getSearchProviderLabel maps a provider id to its display label.
 *
 * WHAT FLIPPED, AND WHY. This suite used to assert that a concrete preferred provider was
 * HOISTED to the front of the full chain and that the list still held every other provider
 * ("the total count still equals the roster size"). That was the defect, stated as a
 * requirement: a chosen engine that answered with nothing handed the query to a different
 * engine, and an operator who picked the credential-free engines had keyed ones reached on
 * their behalf. A choice is now the whole list. `auto` is the value that ranges over the
 * chain, which is the only behaviour of the old list that survives, and it is asserted here.
 * The per-provider, per-route sweep of the new contract lives in
 * `a-chosen-web-search-provider-is-the-only-provider.test.ts`.
 *
 * The excluded set is module state, so each test resets it. The tests assert against the
 * exported SEARCH_PROVIDER_ORDER rather than a hardcoded list, since the roster changes.
 */
describe("resolveProviderCandidates", () => {
	// The excluded set lives in module scope; keep tests independent of each other and the host config.
	beforeEach(() => setExcludedSearchProviders([]));
	afterEach(() => setExcludedSearchProviders([]));

	it("returns every provider in order, all non-explicit, for auto", () => {
		const candidates = resolveProviderCandidates("auto");
		expect(candidates.map(candidate => candidate.id)).toEqual([...SEARCH_PROVIDER_ORDER]);
		expect(candidates.every(candidate => candidate.explicit === false)).toBe(true);
	});

	it("returns a concrete preferred provider and nothing else", () => {
		expect(resolveProviderCandidates("exa")).toEqual([{ id: "exa", explicit: true }]);
	});

	it("returns nothing for a preferred provider that is excluded", () => {
		setExcludedSearchProviders(["exa", "gemini"]);

		// Not "the chain minus the exclusions": the two settings contradict each other, and
		// the caller is told so rather than served results from an engine it did not choose.
		expect(resolveProviderCandidates("exa")).toEqual([]);
	});

	it("omits every excluded provider from the auto chain", () => {
		setExcludedSearchProviders(["exa", "gemini"]);

		const candidates = resolveProviderCandidates("auto");

		expect(candidates.map(candidate => candidate.id)).toEqual(
			SEARCH_PROVIDER_ORDER.filter(id => id !== "exa" && id !== "gemini"),
		);
	});
});

/**
 * getSearchProviderLabel returns a provider's human display label, falling back to the raw id for an
 * id with no registered metadata. The fallback (`?? id`) is the contract that matters: an unknown id
 * must render as itself, never as `undefined`, so a listing never shows a blank provider name.
 */
describe("getSearchProviderLabel", () => {
	it("returns the registered display label for a known provider", () => {
		expect(getSearchProviderLabel("exa")).toBe("Exa");
	});

	it("falls back to the raw id for an unregistered provider id", () => {
		expect(getSearchProviderLabel("notaprovider" as SearchProviderId)).toBe("notaprovider");
	});
});
