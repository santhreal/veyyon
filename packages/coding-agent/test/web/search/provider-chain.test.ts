import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import {
	resolveProviderCandidates,
	resolveProviderChain,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "@veyyon/coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER } from "@veyyon/coding-agent/web/search/types";

// This chain is driven purely by env-backed keys, so the store answers "nothing stored" for every
// provider that consults it.
const authStorage = { hasAuth: () => false } as unknown as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;

function enableKeyBackedProviders(): void {
	process.env.BRAVE_API_KEY = "test-brave-key";
	process.env.JINA_API_KEY = "test-jina-key";
}

function restoreEnv(): void {
	if (originalBraveApiKey === undefined) {
		delete process.env.BRAVE_API_KEY;
	} else {
		process.env.BRAVE_API_KEY = originalBraveApiKey;
	}

	if (originalJinaApiKey === undefined) {
		delete process.env.JINA_API_KEY;
	} else {
		process.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	setPreferredSearchProvider("auto");
	setExcludedSearchProviders([]);
	restoreEnv();
});

describe("resolveProviderCandidates", () => {
	it("returns the preferred provider without loading any fallback", () => {
		// This case used to assert the chosen provider was ORDERED IN FRONT of every other
		// one, which is the defect: a chosen engine with nothing to say handed the query on.
		// The whole list is the choice now, and `auto` is what ranges over the roster.
		expect(resolveProviderCandidates("exa")).toEqual([{ id: "exa", explicit: true }]);
	});

	it("omits excluded providers from the auto chain without resolving them", () => {
		setExcludedSearchProviders(["duckduckgo", "google"]);

		const ids = resolveProviderCandidates("auto").map(candidate => candidate.id);

		expect(ids).not.toContain("duckduckgo");
		expect(ids).not.toContain("google");
	});
});

describe("resolveProviderChain", () => {
	it("omits excluded providers from the fallback chain", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "auto");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("resolves nothing when the preferred provider is excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		// Brave is chosen and excluded, so the configuration cannot be satisfied. It used to
		// resolve to Jina — an engine nobody named, reached because the choice was treated as
		// a preference over a chain rather than as an answer to "which engine".
		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers).toEqual([]);
	});

	it("applies live settings edits to the exclusion chain", async () => {
		enableKeyBackedProviders();
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange(
			"providers.webSearchExclude",
			SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"),
		);

		const providers = await resolveProviderChain(authStorage, "auto");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});
});
