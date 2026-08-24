/**
 * WHY THIS SUITE EXISTS.
 *
 * The defect: choosing a web search provider did not choose it. `providers.webSearch`
 * hoisted the chosen engine to the FRONT of the full chain, so picking Brave meant
 * "Brave, then Exa, then Jina, then everything else", and a chosen engine that returned
 * nothing handed the query to a different one. The per-call `provider` argument was
 * worse: an engine with no credential fell through to the entire `auto` chain. So the
 * setting was almost inert, and the fan-out could not be confined — an operator who
 * picks the credential-free engines on purpose had keyed providers reached on their
 * behalf, which is a credential spend and a privacy leak, not a convenience.
 *
 * The class, not the incident: this is not "Brave must not fall back to Exa". It is that
 * for EVERY member of `SEARCH_PROVIDER_ORDER`, through both routes a choice can arrive
 * (the setting and the per-call argument), a chosen provider is the only provider. The
 * order is enumerated from source at run time, so a provider added tomorrow is swept
 * with no edit here, and a new member that behaves differently turns this red.
 *
 * What it does not catch: whether an individual provider's `search()` honours its
 * arguments, and the aggregate Public Web fan-out's own engine selection
 * (`test/tools/web-search-public.test.ts` covers that). It also cannot see network
 * behaviour — every case here is decided before a request is made, which is what lets
 * the tool-seam cases below run the real `runSearchQuery` against a credential-free
 * store without reaching an engine.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import { runSearchQuery, type SearchQueryParams } from "@veyyon/coding-agent/web/search";
import {
	resolveProviderCandidates,
	selectSearchProviders,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "@veyyon/coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER, type SearchProviderId } from "@veyyon/coding-agent/web/search/types";

// Both are module-level mutable state, so every case restores them or the next file
// inherits a chosen provider and an exclusion set it never asked for.
afterEach(() => {
	setPreferredSearchProvider("auto");
	setExcludedSearchProviders([]);
});

/** Every provider, plus the two routes a choice can travel. */
const ROUTES = ["setting", "argument"] as const;

function select(route: (typeof ROUTES)[number], id: SearchProviderId) {
	if (route === "setting") {
		setPreferredSearchProvider(id);
		return selectSearchProviders(undefined);
	}
	return selectSearchProviders(id);
}

describe("a chosen provider is the only provider", () => {
	it("sweeps every provider the product ships, read from source", () => {
		// Fail by default on a new member: a provider added to the order with no entry in
		// SEARCH_PROVIDER_ORDER would silently drop out of every case below.
		expect(SEARCH_PROVIDER_ORDER.length).toBeGreaterThan(1);
		expect(new Set(SEARCH_PROVIDER_ORDER).size).toBe(SEARCH_PROVIDER_ORDER.length);
	});

	for (const route of ROUTES) {
		it.each([...SEARCH_PROVIDER_ORDER])(`%s chosen by the ${route} resolves to itself alone`, id => {
			const selection = select(route, id);

			expect(selection).toEqual({ candidates: [{ id, explicit: true }] });
		});

		it.each([...SEARCH_PROVIDER_ORDER])(`%s chosen by the ${route} reaches no sibling`, id => {
			const selection = select(route, id);

			// The assertion that carries the whole fix: no OTHER provider is reachable. A
			// count is not enough — hoisting produced a list that also began with the chosen
			// engine and still contained every other one.
			if ("refusal" in selection) throw new Error("expected candidates");
			const others = selection.candidates.filter(candidate => candidate.id !== id);
			expect(others).toEqual([]);
		});
	}

	it("marks a chosen provider explicit, so availability is judged by the stricter rule", () => {
		// `explicit` selects `isExplicitlyAvailable` over `isAvailable` in the search loop.
		// A chosen provider judged by the loose rule is admitted while unusable, which puts
		// the failure inside the request instead of at selection.
		const selection = selectSearchProviders("brave");

		if ("refusal" in selection) throw new Error("expected candidates");
		expect(selection.candidates.every(candidate => candidate.explicit)).toBe(true);
	});

	it("lets the per-call argument override a different chosen provider", () => {
		setPreferredSearchProvider("brave");

		expect(selectSearchProviders("exa")).toEqual({ candidates: [{ id: "exa", explicit: true }] });
	});
});

describe("auto is the value that ranges over the chain", () => {
	it("offers every provider, in order, none of them explicit", () => {
		expect(selectSearchProviders("auto")).toEqual({
			candidates: SEARCH_PROVIDER_ORDER.map(id => ({ id, explicit: false })),
		});
	});

	it("is what a per-call argument of auto reaches, whatever the setting says", () => {
		setPreferredSearchProvider("brave");

		// `--provider auto` is a caller saying "any of them" for this one call, which is the
		// only way to widen a chosen provider, and it is explicit rather than a fallback.
		expect(selectSearchProviders("auto")).toEqual({
			candidates: SEARCH_PROVIDER_ORDER.map(id => ({ id, explicit: false })),
		});
	});

	it.each([...SEARCH_PROVIDER_ORDER])("drops %s from the chain when it is excluded", id => {
		setExcludedSearchProviders([id]);

		const selection = selectSearchProviders("auto");

		if ("refusal" in selection) throw new Error("expected candidates");
		expect(selection.candidates.map(candidate => candidate.id)).toEqual(
			SEARCH_PROVIDER_ORDER.filter(other => other !== id),
		);
	});
});

describe("a configuration that cannot be satisfied is refused, not widened", () => {
	it.each([...SEARCH_PROVIDER_ORDER])("refuses %s chosen by the setting and excluded", id => {
		setPreferredSearchProvider(id);
		setExcludedSearchProviders([id]);

		const selection = selectSearchProviders(undefined);

		// The two settings contradict each other. Falling back to the chain here is how a
		// deliberately excluded engine is reached: the exclusion is honoured, the choice is
		// not, and the search answers from something nobody asked for.
		if (!("refusal" in selection)) throw new Error("expected a refusal");
		expect(selection.refusal).toContain("providers.webSearch");
		expect(selection.refusal).toContain("providers.webSearchExclude");
	});

	it.each([...SEARCH_PROVIDER_ORDER])("refuses %s named by the call and excluded", id => {
		setExcludedSearchProviders([id]);

		const selection = selectSearchProviders(id);

		if (!("refusal" in selection)) throw new Error("expected a refusal");
		expect(selection.refusal).toContain("the provider argument");
	});

	it("refuses an auto chain with every provider excluded, and says so", () => {
		setExcludedSearchProviders([...SEARCH_PROVIDER_ORDER]);

		const selection = selectSearchProviders("auto");

		// Bounded, not empty-and-silent: an empty candidate list reaches the search loop as
		// "no provider was available", which reads as a missing credential rather than as a
		// setting that excludes everything.
		if (!("refusal" in selection)) throw new Error("expected a refusal");
		expect(selection.refusal).toContain("providers.webSearchExclude");
		expect(resolveProviderCandidates("auto")).toEqual([]);
	});
});

/**
 * The decision is only half the fix: the other half is that the tool ASKS for it with
 * the call's own argument and surfaces a refusal instead of searching anyway. Both of
 * those live at `executeSearch`, so these cases drive `runSearchQuery`, which is the
 * function the `veyyon search` CLI calls and the same `executeSearch` the tool class and
 * the custom tool call. Kagi decides availability from `authStorage.hasAuth` alone, so a
 * store that holds nothing keeps every case off the network.
 */
describe("the search the tool actually runs", () => {
	const emptyStore = {
		hasAuth: () => false,
		async getApiKey() {
			throw new Error("a provider with no credential must not be asked for one");
		},
		resolver() {
			throw new Error("a provider with no credential must not be asked for a resolver");
		},
	} as unknown as AuthStorage;

	const search = (params: SearchQueryParams) => runSearchQuery(params, { authStorage: emptyStore });

	it("names the provider the call chose, not the one the setting chose", async () => {
		setPreferredSearchProvider("kagi");
		setExcludedSearchProviders(["tinyfish"]);

		// The per-call argument used to be resolved inside the search loop, one seam past
		// the setting, so an argument could be dropped while the setting was honoured.
		const result = await search({ query: "anything", provider: "tinyfish" });

		expect(result.details.error).toContain("TinyFish");
		expect(result.details.error).toContain("the provider argument");
		expect(result.details.error).not.toContain("Kagi");
	});

	it("returns the refusal as the tool's error rather than searching anyway", async () => {
		setPreferredSearchProvider("kagi");
		setExcludedSearchProviders(["kagi"]);

		const result = await search({ query: "anything" });

		expect(result.content[0]?.text).toBe(`Error: ${result.details.error}`);
		expect(result.details.error).toContain("providers.webSearchExclude");
		expect(result.details.response.provider).toBe("none");
		expect(result.details.response.sources).toEqual([]);
	});

	it("names the chosen provider when it is the thing that has no credential", async () => {
		setPreferredSearchProvider("kagi");

		const result = await search({ query: "anything" });

		// "No web search provider configured" is true of a machine with no keys at all and
		// says nothing an operator who chose one engine can act on. The two facts are
		// different, and only this one names the credential to add.
		expect(result.details.error).toBe(
			"Kagi is the chosen web search provider and is not configured. " +
				"Add its credential, or set providers.webSearch to auto.",
		);
		expect(result.details.response.provider).toBe("kagi");
	});
});
