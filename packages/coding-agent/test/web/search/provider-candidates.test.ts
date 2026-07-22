import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	getSearchProviderLabel,
	resolveProviderCandidates,
	setExcludedSearchProviders,
} from "@veyyon/coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER, type SearchProviderId } from "@veyyon/coding-agent/web/search/types";

/**
 * resolveProviderCandidates builds the web-search fallback order WITHOUT loading any provider module,
 * and getSearchProviderLabel maps a provider id to its display label. Neither had a direct test. The
 * candidate ordering carries real product logic the search loop depends on:
 *   - "auto" yields every provider in SEARCH_PROVIDER_ORDER, each marked explicit:false (no user pick);
 *   - a concrete preferred provider is hoisted to the front as explicit:true and appears exactly once
 *     (it is skipped in the tail so it is never tried twice);
 *   - the module-global excluded set removes a provider everywhere, including a preferred one that is
 *     excluded (it is not hoisted AND not in the tail), so a disabled provider is never reached.
 * The excluded set is module state, so each test resets it. The tests assert against the exported
 * SEARCH_PROVIDER_ORDER rather than a hardcoded list, since the provider roster changes over time.
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

	it("hoists a concrete preferred provider to the front as explicit and keeps it unique", () => {
		const candidates = resolveProviderCandidates("exa");
		expect(candidates[0]).toEqual({ id: "exa", explicit: true });
		expect(candidates.filter(candidate => candidate.id === "exa")).toHaveLength(1);
		// Preferred is hoisted out of the tail, so the total count still equals the roster size.
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length);
		expect(candidates.slice(1).every(candidate => candidate.explicit === false)).toBe(true);
	});

	it("omits every excluded provider, including a preferred one that is excluded", () => {
		setExcludedSearchProviders(["exa", "gemini"]);
		const candidates = resolveProviderCandidates("exa");
		const ids = candidates.map(candidate => candidate.id);
		expect(ids).not.toContain("exa");
		expect(ids).not.toContain("gemini");
		// With the preferred excluded, the front of the chain is just the first non-excluded provider.
		expect(candidates[0].explicit).toBe(false);
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length - 2);
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
