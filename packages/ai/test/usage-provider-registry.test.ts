/**
 * Who owns the table of how each provider reports its quota.
 *
 * WHY THIS SUITE EXISTS. `auth-storage.ts` imported all eleven usage backends directly, so a module
 * about STORING credentials statically owned the usage table, and through `usage/claude ->
 * providers/anthropic -> stream` it dragged in the entire streaming engine. Storing a token and
 * reporting a quota are different jobs. The table now lives in `usage/defaults.ts`, reached through
 * `usage/registry.ts`, and the credential store consults it through an interface.
 *
 * THE FAILURE MODE THIS GUARDS. Moving a table behind a registry creates a wiring requirement, and a
 * wiring requirement that is unstated is how a feature silently stops working: an empty registry
 * would answer `undefined` for every provider, which reads exactly like "this provider does not
 * report usage", so every quota would vanish from the UI with nothing anywhere saying why. The
 * registry therefore fails closed, and the cases below pin both that it does and that the two
 * modules which construct an `AuthStorage` actually perform the wiring.
 */

import { describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { logger } from "@veyyon/utils";
import { moduleSpecifiersIn, withoutComments } from "@veyyon/utils/module-reach";
import { DEFAULT_RANKING_STRATEGIES, DEFAULT_USAGE_PROVIDERS } from "../src/usage/defaults";
import {
	listRegisteredUsageProviders,
	resolveRegisteredRankingStrategy,
	resolveRegisteredUsageProvider,
	usageProvidersRegistered,
} from "../src/usage/registry";

const SRC = path.join(import.meta.dir, "..", "src");

function read(relative: string): string {
	return fs.readFileSync(path.join(SRC, relative), "utf-8");
}

/**
 * Static import specifiers of a module, value imports and TYPE imports alike, which is why this is not
 * `moduleSpecifiersIn`: that owner excludes erased type imports on purpose, and the assertion below is
 * about the whole declared surface rather than about runtime cost.
 *
 * Comments are stripped first, through the same owner the walk uses. Without that, a specifier NAMED in a
 * doc comment (`export * as logger from "./logger"`, written to explain why the import looks the way it
 * does) is counted as an import, and the assertion fails on the sentence documenting it. That happened.
 */
function importsOf(source: string): string[] {
	return [...withoutComments(source).matchAll(/from\s*"([^"]+)"/g)].map(match => match[1] as string);
}

describe("the registry once the defaults are loaded", () => {
	/**
	 * Importing `usage/defaults` is the wiring, and this file imports it at the top, so by the time
	 * any case runs the registry is filled. Asserted explicitly rather than assumed, because every
	 * case below depends on it and a silent failure here would make them all vacuous.
	 */
	it("is populated by importing the defaults module", () => {
		expect(usageProvidersRegistered()).toBe(true);
	});

	/** Every one of the eleven backends is reachable by its own provider id, not just present in a list. */
	it("resolves each of the eleven backends by provider id", () => {
		expect(DEFAULT_USAGE_PROVIDERS.length).toBe(11);
		for (const provider of DEFAULT_USAGE_PROVIDERS) {
			expect(resolveRegisteredUsageProvider(provider.id)).toBe(provider);
		}
	});

	/**
	 * The exact set, sorted. A count would pass while registering a different backend than the one it
	 * counted, and the whole risk of moving a table is that it arrives slightly different.
	 */
	it("registers exactly the eleven providers the credential store used to hold", () => {
		expect(
			listRegisteredUsageProviders()
				.map(provider => provider.id)
				.sort(),
		).toEqual([
			"anthropic",
			"cursor",
			"github-copilot",
			"google-antigravity",
			"google-gemini-cli",
			"kimi-code",
			"ollama",
			"ollama-cloud",
			"openai-codex",
			"opencode-go",
			"zai",
		]);
	});

	/** The four providers that rank their credentials by their own rules, and only those four. */
	it("registers exactly the four ranking strategies", () => {
		expect(DEFAULT_RANKING_STRATEGIES.map(([provider]) => provider).sort()).toEqual([
			"anthropic",
			"google-antigravity",
			"openai-codex",
			"zai",
		]);
		for (const [provider, strategy] of DEFAULT_RANKING_STRATEGIES) {
			expect(resolveRegisteredRankingStrategy(provider)).toBe(strategy);
		}
	});

	/**
	 * A provider with no usage backend answers `undefined`, which is the honest answer and is
	 * different from the registry being empty. The distinction is the entire design: `undefined` here
	 * means "this provider does not report usage", and an empty registry throws instead of saying it.
	 */
	it("answers undefined for a provider that reports no usage", () => {
		expect(resolveRegisteredUsageProvider("openai")).toBeUndefined();
		expect(resolveRegisteredRankingStrategy("openai")).toBeUndefined();
	});
});

describe("the registry reports it when nothing wired it", () => {
	/**
	 * The Law 10 case. An empty table answers `undefined` for every provider, which reads exactly like
	 * "this provider does not report usage", so every quota would disappear and credential ranking
	 * would quietly revert to the default rules with nothing to notice. The registry says so, loudly,
	 * and the message names the import that fixes it, because a wiring fault is only useful if it says
	 * what the wiring is.
	 *
	 * It WARNS rather than throwing, and that is the deliberate part. `AuthStorage` reads the ranking
	 * strategy on `getApiKey`, its primary job, which has nothing to do with quota reporting; throwing
	 * there would take a process that never wanted usage numbers and stop it selecting a credential at
	 * all. Loud and recorded is what Law 10 asks for; refusing is what it does not.
	 *
	 * Loaded through a cache-busting query so this case sees a registry nothing has filled, while the
	 * suite above keeps the populated one.
	 */
	it("warns once, names the missing import, and still answers honestly", async () => {
		const fresh = (await import(
			`../src/usage/registry.ts?unwired=${Math.random()}`
		)) as typeof import("../src/usage/registry");
		const warnings: string[] = [];
		const spy = spyOn(logger, "warn").mockImplementation(((message: string) => {
			warnings.push(message);
		}) as never);

		try {
			expect(fresh.usageProvidersRegistered()).toBe(false);
			expect(fresh.resolveRegisteredUsageProvider("anthropic")).toBeUndefined();
			expect(fresh.resolveRegisteredRankingStrategy("anthropic")).toBeUndefined();
			expect(fresh.listRegisteredUsageProviders()).toEqual([]);
		} finally {
			spy.mockRestore();
		}

		// Once across three consultations: an unfilled registry is read on every credential lookup, and
		// a warning per call buries itself.
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("@veyyon/ai/usage/defaults");
		expect(warnings[0]).toContain("registry is empty");
	});
});

describe("the credential store stays off the usage backends", () => {
	/**
	 * The reason the split exists, asserted by name. `auth-storage.ts` may still import the usage
	 * TYPES and the codex reset-credit helpers, which are a different concern, but not one backend.
	 * An import added back here for convenience would restore the whole mesh with nothing failing.
	 */
	it("imports no usage backend", () => {
		const backends = [
			"./usage/claude",
			"./usage/cursor",
			"./usage/gemini",
			"./usage/github-copilot",
			"./usage/google-antigravity",
			"./usage/kimi",
			"./usage/ollama",
			"./usage/openai-codex",
			"./usage/opencode-go",
			"./usage/zai",
		];
		const specifiers = importsOf(read("auth-storage.ts"));

		expect(specifiers.filter(specifier => backends.includes(specifier))).toEqual([]);
		expect(specifiers).toContain("./usage/registry");
	});

	/** And it must not reach the streaming engine, which is what importing `usage/claude` did. */
	it("does not import the streaming engine", () => {
		expect(importsOf(read("auth-storage.ts")).filter(specifier => specifier.includes("stream"))).toEqual([]);
	});

	/**
	 * The registry itself has to stay a leaf, or the move accomplishes nothing: one value import here
	 * would put the same graph back on the credential store's path, by a shorter route and with less
	 * to notice. Type imports are erased and cost nothing.
	 */
	it("keeps the registry importing nothing but types", () => {
		const source = read("usage/registry.ts");

		expect(importsOf(source).sort()).toEqual(["../types", "../usage", "@veyyon/utils/logger"]);
		// The logger is the one value import, and it is a leaf itself (18 modules; the `@veyyon/utils`
		// barrel it used to be taken from is 82). Nothing else may be. `moduleSpecifiersIn` decides what
		// counts, because it is the tested owner of that question and it excludes `import type` and
		// `await import()`; the local pattern here was anchored on `[^;]*`, which stops matching an import
		// the moment a formatter breaks its clause across lines and then reports the edge as gone.
		expect(moduleSpecifiersIn(source)).toEqual(["@veyyon/utils/logger"]);
	});
});

describe("the wiring is performed where an AuthStorage is built", () => {
	/**
	 * The barrel is where every consumer of `AuthStorage` from this package arrives, so it carries the
	 * side-effect import. It costs nothing there: the barrel already re-exported `auth-storage` and so
	 * already reached these backends.
	 */
	it("is wired in the package barrel", () => {
		expect(read("index.ts")).toContain('import "./usage/defaults";');
	});

	/**
	 * And in the one module that builds an `AuthStorage` from the subpath rather than the barrel. This
	 * case is the reason the registry throws: without a check like it, the wiring is a convention, and
	 * a convention is what silently stops holding.
	 */
	it("is wired in the broker discovery path that bypasses the barrel", () => {
		expect(read("auth-broker/discover.ts")).toContain('import "../usage/defaults";');
	});
});
