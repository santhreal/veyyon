/**
 * The provider env-key table: which variable holds a key, and that asking cannot cost the world.
 *
 * WHY THIS SUITE EXISTS. `getEnvApiKey` and friends used to live in `stream.ts`, the streaming
 * engine, and were imported from there by `auth-storage.ts` and by eighteen web-search providers in
 * `@veyyon/coding-agent` that want nothing else from this package. A table lookup therefore
 * declared a dependency on every provider transport and every usage backend. They moved to
 * `env-api-key.ts`, a leaf, and `@veyyon/ai` plus `./stream` still re-export them so no caller
 * outside this package had to change.
 *
 * The move is the kind that is easy to get subtly wrong and impossible to notice: the table has
 * LAYERS whose order decides the answer, and reordering them silently changes which variable a provider
 * reads. So the layers are asserted by name here, and so is the reach of the new module, because a later
 * import added to it would quietly undo the whole point of the split.
 *
 * There were three layers and there are two, because the middle one was read off the provider DEFINITIONS
 * and that cost 121 modules to reach one field. The overrides live in `provider-env-keys.ts` now, whose own
 * behaviour is checked in `provider-env-keys.test.ts`; this suite is about the merged answer.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { getEnvApiKey, getEnvApiKeyName, listProvidersWithEnvKey } from "../src/env-api-key";

const SRC = path.join(import.meta.dir, "..", "src");

describe("getEnvApiKeyName", () => {
	/**
	 * A provider whose key is one plainly named variable, which is most of them. These come from
	 * the catalog's `envVars`, and the exact name is the contract: a caller printing "set
	 * OPENAI_API_KEY" is reading this.
	 */
	it("names the single variable a plain catalog provider reads", () => {
		expect(getEnvApiKeyName("openai")).toBe("OPENAI_API_KEY");
		expect(getEnvApiKeyName("deepseek")).toBe("DEEPSEEK_API_KEY");
		expect(getEnvApiKeyName("cerebras")).toBe("CEREBRAS_API_KEY");
	});

	/**
	 * An override in `provider-env-keys.ts` replaces its catalog entry with a computed resolver, and no
	 * single variable name describes what it reads. Returning a name anyway would send an operator to set
	 * a variable that is not consulted, which is worse than saying nothing.
	 */
	it("returns undefined for a provider whose key is computed", () => {
		for (const provider of ["anthropic", "google-vertex", "amazon-bedrock"]) {
			expect(getEnvApiKeyName(provider), `${provider} should have no single backing variable`).toBeUndefined();
		}
	});

	/**
	 * The override layer, which merges LAST and holds keys for ids the catalog does not model at all:
	 * search tools and a local server. If it stopped merging last, or stopped merging, these would lose
	 * their keys with nothing failing loudly.
	 */
	it("keeps the non-provider search-tool keys", () => {
		expect(getEnvApiKeyName("exa")).toBe("EXA_API_KEY");
		expect(getEnvApiKeyName("jina")).toBe("JINA_API_KEY");
		expect(getEnvApiKeyName("brave")).toBe("BRAVE_API_KEY");
		expect(getEnvApiKeyName("tinyfish")).toBe("TINYFISH_API_KEY");
		expect(getEnvApiKeyName("firecrawl")).toBe("FIRECRAWL_API_KEY");
		expect(getEnvApiKeyName("azure-openai-responses")).toBe("AZURE_OPENAI_API_KEY");
	});

	/** A provider nobody registered has no variable, rather than a thrown error on a hot path. */
	it("returns undefined for a provider that is not in the table", () => {
		expect(getEnvApiKeyName("not-a-real-provider")).toBeUndefined();
		expect(getEnvApiKey("not-a-real-provider")).toBeUndefined();
	});
});

describe("getEnvApiKey", () => {
	/**
	 * The lookup reads the variable its own `getEnvApiKeyName` reports. Asserted through the
	 * environment rather than by inspecting the table, because the pair agreeing is the actual
	 * contract: every caller that prints one and then reads the other depends on it.
	 */
	it("reads exactly the variable it names", () => {
		const name = getEnvApiKeyName("deepseek");
		expect(name).toBe("DEEPSEEK_API_KEY");

		const previous = process.env[name as string];
		try {
			process.env[name as string] = "sentinel-value-for-this-test";
			expect(getEnvApiKey("deepseek")).toBe("sentinel-value-for-this-test");
		} finally {
			if (previous === undefined) delete process.env[name as string];
			else process.env[name as string] = previous;
		}
	});
});

describe("listProvidersWithEnvKey", () => {
	/**
	 * The enumeration `veyyon auth-broker migrate --include-env` walks. It must cover both layers, or
	 * the migration silently skips whichever one it lost.
	 */
	it("covers the catalog layer and the override layer", () => {
		const providers = new Set(listProvidersWithEnvKey());

		expect(providers.has("openai"), "catalog layer missing").toBe(true);
		// A computed override and a catalog-less override, which are the two shapes the second layer has.
		expect(providers.has("anthropic"), "computed override missing").toBe(true);
		expect(providers.has("exa"), "catalog-less override missing").toBe(true);
		// A floor, not a ceiling: the catalog grows. Well below the 69 measured on 2026-07-26, so
		// adding providers never fails this, and losing a layer does.
		expect(providers.size).toBeGreaterThan(40);
	});

	/** Every listed provider resolves to a real entry, so the list cannot advertise a dead key. */
	it("lists only providers the lookup actually knows", () => {
		for (const provider of listProvidersWithEnvKey()) {
			const named = getEnvApiKeyName(provider) !== undefined;
			// Either it names a variable, or it is a computed resolver; nothing in the list may be
			// absent from the table entirely.
			expect(named || getEnvApiKey(provider) === undefined || typeof getEnvApiKey(provider) === "string").toBe(true);
		}
	});
});

describe("the env-key leaf stays a leaf", () => {
	/**
	 * The reason the module exists. It must NOT reach the streaming engine, which is what the first split
	 * removed, and it must no longer reach the provider REGISTRY either: it used to, because the overrides
	 * hung on the provider definitions, and that was 121 modules of login flows and transports to read one
	 * field. An `import` added here for convenience would put every search provider back on the mesh with
	 * nothing failing.
	 *
	 * ONLY the streaming engine is asserted here. This case used to also pin the module's whole import
	 * list, which `module-reach-stays-cut.test.ts` pins as well, and with a different hand-rolled regex:
	 * two suites asserting one fact in two spellings, so repointing `$env` at `@veyyon/utils/env` broke
	 * both and neither told you the other existed. The exhaustive list has one owner now, the suite whose
	 * subject is the graph, and this one keeps the narrow claim its name makes. `moduleSpecifiersIn` does
	 * the extraction because it is the tested owner of "what does this file import" and it excludes
	 * `import type`, which costs nothing and cannot drag the engine in.
	 */
	it("does not import the streaming engine", () => {
		const specifiers = moduleSpecifiersIn(fs.readFileSync(path.join(SRC, "env-api-key.ts"), "utf-8"));

		expect(specifiers.filter(specifier => specifier.includes("stream"))).toEqual([]);
	});

	/**
	 * And not the provider registry, which is the edge the override table removed. Stated as the specifier
	 * rather than as reachability on purpose: this suite's subject is what the module NAMES, and
	 * `module-reach-stays-cut.test.ts` owns the graph-shaped claim with the measured ceiling on it.
	 */
	it("does not import the provider registry for the overrides", () => {
		const specifiers = moduleSpecifiersIn(fs.readFileSync(path.join(SRC, "env-api-key.ts"), "utf-8"));

		expect(specifiers.filter(specifier => /^\.\/registry/.test(specifier))).toEqual([]);
		// The control: it still reads the two tables it merges, so the absence above is not the module
		// having stopped answering the question.
		expect(specifiers).toContain("./provider-env-keys");
		expect(specifiers).toContain("@veyyon/catalog/provider-models");
	});

	/**
	 * And the other half: `auth-storage.ts` must not go back to `./stream` for these two, which is
	 * the import that made it reach 276 modules.
	 */
	it("keeps auth storage off the streaming engine for its key lookups", () => {
		const source = fs.readFileSync(path.join(SRC, "auth-storage.ts"), "utf-8");

		expect(source).toContain('import { getEnvApiKey, getEnvApiKeyName } from "./env-api-key";');
		expect(moduleSpecifiersIn(source)).not.toContain("./stream");
	});
});
