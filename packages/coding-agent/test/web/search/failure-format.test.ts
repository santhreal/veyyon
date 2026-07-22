import { afterEach, describe, expect, it } from "bun:test";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	isSearchProviderExcluded,
	setExcludedSearchProviders,
} from "@veyyon/coding-agent/web/search/provider";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	SearchProviderError,
} from "@veyyon/coding-agent/web/search/types";

/**
 * When a web-search provider fails, the operator sees a single line per provider explaining
 * why. The type guards decide which strings are accepted as a provider id or a preference,
 * and isSearchProviderExcluded gates whether a provider is even attempted. None of these had
 * direct tests, yet a regression here shows the wrong reason (or the wrong provider) to the
 * operator or silently skips a provider. Pinned:
 *   - isSearchProviderId accepts only the members of SEARCH_PROVIDER_ORDER (not "auto");
 *   - isSearchProviderPreference additionally accepts "auto";
 *   - formatSearchProviderFailure special-cases an Anthropic 404 (model/endpoint not found),
 *     rewrites a 401/403 as an authorization-failure line carrying the status and the
 *     provider label (except zai, which surfaces its own message), passes through any other
 *     SearchProviderError or generic Error message, and falls back to
 *     "Unknown error from <label>" for a non-Error throw;
 *   - formatSearchProviderFailures prefixes each line with the provider id and joins with
 *     "; ";
 *   - isSearchProviderExcluded reflects the mutable exclusion set set by
 *     setExcludedSearchProviders.
 */

const anyProvider = { id: "public" as const, label: "Public Web" };

afterEach(() => {
	// The exclusion set is module-level mutable state; leave it empty for other suites.
	setExcludedSearchProviders([]);
});

describe("isSearchProviderId / isSearchProviderPreference", () => {
	it("accepts real provider ids but rejects 'auto' and unknown strings as an id", () => {
		expect(isSearchProviderId("public")).toBe(true);
		expect(isSearchProviderId("exa")).toBe(true);
		expect(isSearchProviderId("auto")).toBe(false);
		expect(isSearchProviderId("nope")).toBe(false);
		expect(isSearchProviderId("")).toBe(false);
	});

	it("accepts 'auto' and real ids as a preference but still rejects unknown strings", () => {
		expect(isSearchProviderPreference("auto")).toBe(true);
		expect(isSearchProviderPreference("public")).toBe(true);
		expect(isSearchProviderPreference("nope")).toBe(false);
		expect(isSearchProviderPreference("")).toBe(false);
	});
});

describe("formatSearchProviderFailure", () => {
	it("special-cases an Anthropic 404 as a model/endpoint-not-found line", () => {
		expect(formatSearchProviderFailure(new SearchProviderError("anthropic", "raw body", 404), anyProvider)).toBe(
			"Anthropic web search returned 404 (model or endpoint not found).",
		);
	});

	it("rewrites a 401/403 as an authorization failure carrying the status and provider label", () => {
		expect(formatSearchProviderFailure(new SearchProviderError("exa", "raw", 401), anyProvider)).toBe(
			"Exa authorization failed (401). Check API key or base URL.",
		);
		expect(formatSearchProviderFailure(new SearchProviderError("tavily", "raw", 403), anyProvider)).toBe(
			"Tavily authorization failed (403). Check API key or base URL.",
		);
	});

	it("surfaces zai's own message on a 401/403 instead of the generic authorization line", () => {
		expect(formatSearchProviderFailure(new SearchProviderError("zai", "zai says forbidden", 403), anyProvider)).toBe(
			"zai says forbidden",
		);
	});

	it("passes through any other SearchProviderError message and any generic Error message", () => {
		expect(formatSearchProviderFailure(new SearchProviderError("exa", "boom", 500), anyProvider)).toBe("boom");
		expect(formatSearchProviderFailure(new Error("plain failure"), anyProvider)).toBe("plain failure");
	});

	it("falls back to 'Unknown error from <label>' for a non-Error throw", () => {
		expect(formatSearchProviderFailure("weird string throw", anyProvider)).toBe("Unknown error from Public Web");
	});
});

describe("formatSearchProviderFailures", () => {
	it("prefixes each line with the provider id and joins with '; '", () => {
		expect(
			formatSearchProviderFailures([
				{ provider: { id: "exa", label: "Exa" }, error: new Error("e1") },
				{ provider: { id: "public", label: "Public Web" }, error: "x" },
			]),
		).toBe("exa: e1; public: Unknown error from Public Web");
	});
});

describe("isSearchProviderExcluded", () => {
	it("reflects the exclusion set set by setExcludedSearchProviders", () => {
		expect(isSearchProviderExcluded("exa")).toBe(false);
		setExcludedSearchProviders(["exa"]);
		expect(isSearchProviderExcluded("exa")).toBe(true);
		expect(isSearchProviderExcluded("public")).toBe(false);
		setExcludedSearchProviders([]);
		expect(isSearchProviderExcluded("exa")).toBe(false);
	});
});
