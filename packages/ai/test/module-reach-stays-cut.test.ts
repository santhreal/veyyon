import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
	moduleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

/**
 * Contracts: the two cuts that took the credential store off the streaming engine stay cut.
 *
 * WHAT WAS WRONG. `auth-storage.ts` is about STORING credentials in a database. It reached 277 modules,
 * which is most of this package, through two edges that had nothing to do with storage:
 *
 *   1. `getEnvApiKey` lived in `stream.ts`, so asking "which environment variable holds this
 *      provider's key" cost the whole streaming engine and every usage backend. Eighteen files in
 *      `coding-agent` wanted only that lookup and paid 300 modules for it.
 *   2. It imported `./usage/claude` for `claudeUsageProvider`, and `usage/claude` imports
 *      `providers/anthropic`, which imports `stream.ts`. So a module about writing a token to disk
 *      statically owned the table of how to read every provider's quota.
 *
 * Both are now leaves: `env-api-key.ts` holds the four env lookups and imports the catalog table,
 * `@veyyon/utils` and `./registry` and nothing else; `usage/registry.ts` holds the usage-provider table
 * and imports nothing but the logger and types, with `usage/defaults.ts` as the one module that pulls
 * every backend in.
 *
 * WHY A RATCHET AND NOT A BEHAVIOUR TEST. Nothing fails when either cut is undone. Every function keeps
 * working, every test keeps passing, and a single import restores the mesh. What degrades is the honesty
 * of the dependency graph, the cold start of everything downstream, and how easy it becomes to close an
 * import cycle by accident. The number is the only thing that moves, so the number is what is pinned,
 * plus the specific edges by name so a failure says what to undo instead of printing a count.
 *
 * NOT A MEMORY GATE. `docs/internal/testing.md` records
 * the 2026-07-26 measurement: Bun caches modules across test files, so a run costs the UNION of what
 * its files reach and not the sum. These ceilings are architecture, not RAM.
 *
 * THE WALK IS SHARED. `@veyyon/utils/module-reach` owns it and `packages/utils/test/module-reach.test.ts`
 * tests it against fixtures. That matters here because this file is all upper bounds: a walker that
 * resolved less would report smaller numbers and pass while measuring less than it claims.
 *
 * RAISED BY THREE 2026-07-26, and not by anything in this package: applying a user's `.env` split into two
 * phases, so the `@veyyon/utils` barrel grew from 79 modules to 82 (`dotenv-home.ts`, `dotenv-parse.ts`,
 * `dir-env-keys.ts`). Every number here that contains the barrel moved by the same three. See
 * `packages/utils/CHANGELOG.md`. */

const SRC = path.join(import.meta.dir, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

/**
 * The whole workspace resolved to source, derived from every package's `exports` field.
 *
 * `@veyyon/catalog` is reached for real, 120 modules of it through `env-api-key.ts`, so a resolution that
 * skipped it would report that leaf at 84 instead of 204 and every ceiling here would be measuring a graph
 * a third smaller than the one that ships. This gate used to list `@veyyon/utils` and `@veyyon/catalog` by
 * hand for exactly that reason, and listing is the problem: three other gates did the same and each listed
 * a different subset, one of them naming a package that does not exist. Every assertion here is an upper
 * bound or an absence, so a specifier the table does not know lowers the number and passes.
 * `@veyyon/utils/module-reach-workspace` derives the table instead, and
 * `packages/utils/test/module-reach-workspace.test.ts` holds the completeness check.
 */
const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);

/** One memo for the whole gate: every entry below walks the same shared graph. See `ModuleReachCache`. */
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

function reachedNames(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)]
		.map(file => path.relative(REPO_ROOT, file))
		.sort();
}

/** The runtime specifiers one module names, which is what a "does not import X" claim is about. */
function runtimeImportsOf(relative: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
}

/**
 * Measured 2026-07-26 at 212, down from 277. The remaining graph is the credential store's real job:
 * `./registry` for provider identity, `./error` for classification, the env lookup leaf, and sqlite.
 *
 * RAISED BY ONE, from 223, for `@veyyon/catalog/wire/codex`. `auth-credential-rows.ts` reads the OpenAI JWT
 * claim namespaces from that leaf instead of spelling both URIs as bare literals, and the leaf's own only
 * import is `@veyyon/utils/jwt`, which this graph already had. One module, and the reason is recorded in
 * `credential-store-is-not-the-oauth-machinery.test.ts` beside the exact import list it also changed.
 *
 * RAISED BY ONE AGAIN, from 224, for `@veyyon/utils/app-identity`. `dirs.ts` is already in this graph and now
 * reads the lowercase `APP_DIRECTORY_SLUG` from that leaf rather than declaring it, which is what stops the
 * capitalized `APP_DISPLAY_NAME` from being reachable under the same name. The leaf has no imports at all, so
 * the cost is exactly the one module and it cannot grow: see `packages/utils/test/app-identity.test.ts`, which
 * asserts the leaf stays import-free.
 *
 * RAISED BY ONE A THIRD TIME, from 225, and again by nothing in this package: `e3d4fea2` moved one
 * config-parsing helper out of `packages/utils/src/json.ts` into a new `config-parse.ts`, because
 * `json.ts` had grown an `import { YAML } from "bun"` and sits on the collab web client's graph, which
 * made `bun build` refuse the whole browser bundle. The new file is re-exported from the `@veyyon/utils`
 * barrel, so every graph that reaches the barrel gained exactly that one module. This is barrel growth,
 * not a new edge out of the credential store: the two cuts this file exists to hold are asserted by name
 * below and both still pass. `env-api-key.ts` (68) and `usage/registry.ts` (20) do not reach the barrel
 * and did not move.
 *
 * RAISED BY ONE A FOURTH TIME, from 226, and again by barrel growth rather than by an edge out of the
 * credential store: `packages/utils/src/fault-sink.ts` is new, and it is re-exported from the
 * `@veyyon/utils` barrel like `config-parse.ts` before it. It exists because `fs-optional.ts` reported
 * a directory it could not read through `logger.warn`, whose default transport set is file-only, so a
 * TUI operator never saw it and the module's promise that the failure is "not allowed to be silent" was
 * kept only in a log nobody opens. Its only import is `./logger`, which this graph already had, so the
 * cost is exactly the one module. The two cuts this file exists to hold are asserted by name below and
 * both still pass, and `env-api-key.ts` (68) and `usage/registry.ts` (20) do not reach the barrel and
 * did not move.
 */
const AUTH_STORAGE_CEILING = 227;

/**
 * Measured 2026-07-26 at 158, down from 204/212. This module is four functions over a table and its doc
 * records being extracted from `stream.ts` for exactly that reason, but the extraction left it at 212,
 * because the table is built from `@veyyon/catalog/provider-models` and sixteen files in the closure it
 * reaches took one or two pure helpers each from the bare `@veyyon/utils` barrel: `errorMessage`,
 * `trimTrailingSlashes`, `$env`, `DAY_MS`, `decodeJwtPayload`, `isRetryableError`. All sixteen name their
 * owners now, and eleven more in `packages/catalog` did the same, which took `provider-models` from 118 to
 * 62. It matters more here than the number suggests: eighteen web-search providers in
 * `@veyyon/coding-agent` import this module for one env-var name.
 *
 * AND THEN 65, from the last thing on the graph that was not a table: `./registry`, 121 modules and 95 of
 * them marginal here. The overrides used to hang on the provider DEFINITIONS -- three credential probes
 * (Bedrock's chain, Vertex ADC, Anthropic under Foundry) and a handful of string keys -- so reading one
 * field meant importing every login flow, transport and model list in the package. `src/provider-env-keys.ts`
 * owns those rules now, at 23 modules, and `registry/types.ts` no longer declares the field, so there is one
 * place to write a rule and one module that reads it. Downstream: `web/parallel.ts` 164 -> 72,
 * `tools/fetch.ts` 368 -> 282, `tools/read.ts` 542 -> 468.
 */
const ENV_API_KEY_CEILING = 72;

/** Measured 2026-07-26 at 75: the logger and nothing else. A backend import here is the regression. */
const USAGE_REGISTRY_CEILING = 83;

describe("the credential store stays off the streaming engine", () => {
	it(`auth-storage reaches at most ${AUTH_STORAGE_CEILING} modules`, () => {
		expect(
			reach("auth-storage.ts"),
			`modules reachable from auth-storage.ts:\n${reachedNames("auth-storage.ts").join("\n")}`,
		).toBeLessThanOrEqual(AUTH_STORAGE_CEILING);
	});

	/**
	 * THE EDGE, named. The ceiling would catch a straight reintroduction, but it would print two hundred
	 * paths and leave the reader to find the new line. This says what to undo.
	 */
	it("does not import the streaming engine, directly or through a usage backend", () => {
		const imports = runtimeImportsOf("auth-storage.ts");

		expect(imports).not.toContain("./stream");
		expect(imports.filter(specifier => specifier.startsWith("./usage/claude"))).toEqual([]);
		expect(imports.filter(specifier => specifier.startsWith("./providers/"))).toEqual([]);
	});

	/**
	 * And `stream.ts` is not reachable at all, which is the claim the two assertions above only imply.
	 * A new intermediate module that imports the engine would satisfy both of them.
	 */
	it("cannot reach stream.ts by any path", () => {
		const reached = reachedNames("auth-storage.ts");

		expect(reached.filter(file => file.endsWith("packages/ai/src/stream.ts"))).toEqual([]);
	});

	/**
	 * It reaches the usage table through the REGISTRY, which is the direction the fix established: the
	 * credential store consults an interface, and the usage layer fills it. Asserted so the cut cannot
	 * be satisfied by deleting the feature.
	 */
	it("still reaches the usage provider table, through the registry", () => {
		const imports = runtimeImportsOf("auth-storage.ts");

		expect(imports).toContain("./usage/registry");
	});
});

describe("the env-var lookup stays a leaf", () => {
	it(`env-api-key reaches at most ${ENV_API_KEY_CEILING} modules`, () => {
		expect(reach("env-api-key.ts")).toBeLessThanOrEqual(ENV_API_KEY_CEILING);
	});

	/**
	 * Its whole import list, exactly. A ceiling with headroom permits one new import; an exact list does
	 * not, and this module's entire purpose is to be the cheap way to ask which variable holds a key.
	 *
	 * `@veyyon/utils/env` and not the barrel: `$env` and `$pickenv` are defined there, and the barrel is 82
	 * modules against 21. Widening this one specifier back to `@veyyon/utils` is the regression this exact
	 * list exists to refuse, which is why the assertion names the subpath rather than accepting either.
	 */
	it("imports the catalog table, the env owner and the override table, and nothing else", () => {
		expect(runtimeImportsOf("env-api-key.ts")).toEqual([
			"@veyyon/catalog/provider-models",
			"@veyyon/utils/env",
			"./provider-env-keys",
		]);
	});

	/**
	 * The cost is the catalog table plus the override table plus itself, so the leaf adds essentially
	 * nothing of its own. Stated as a relationship rather than a constant because both halves grow with real
	 * provider work, and it is the GAP that this cut is about.
	 */
	it("costs the catalog and the override table, plus one", () => {
		const overrides = reach("provider-env-keys.ts");
		const catalog = moduleReachCount(
			path.join(REPO_ROOT, "packages/catalog/src/provider-models/index.ts"),
			RESOLUTION,
		);

		expect(reach("env-api-key.ts")).toBeLessThanOrEqual(overrides + catalog + 1);
	});

	/**
	 * And it must not reach the provider REGISTRY, which is the edge the override table removed and the one
	 * that would come back the moment someone wanted a fourth probe and reached for `PROVIDER_REGISTRY`
	 * again. Reachability rather than the import list above, because it could also arrive through the
	 * override table.
	 */
	it("cannot reach the provider registry by any path", () => {
		const reached = reachedNames("env-api-key.ts");

		expect(reached.filter(file => file.endsWith("packages/ai/src/registry/index.ts"))).toEqual([]);
		expect(reached.filter(file => file.endsWith("packages/ai/src/registry/anthropic.ts"))).toEqual([]);
		// The control: it still reaches both tables it merges, so the absence is not the lookup having
		// stopped answering.
		expect(reached.filter(file => file.endsWith("packages/ai/src/provider-env-keys.ts")).length).toBe(1);
		expect(reached.filter(file => file.includes("packages/catalog/src/provider-models")).length).toBeGreaterThan(0);
	});

	it("cannot reach stream.ts", () => {
		expect(reachedNames("env-api-key.ts").filter(file => file.endsWith("packages/ai/src/stream.ts"))).toEqual([]);
	});

	/**
	 * The lookups still live here, so the ONE-PLACE owner MOVED rather than being duplicated. Without
	 * this, deleting the leaf and putting them back in `stream.ts` would satisfy every ceiling above by
	 * making the file trivially small.
	 */
	it("still owns the env lookups", async () => {
		const leaf = await import("../src/env-api-key");

		expect(typeof leaf.getEnvApiKey).toBe("function");
		expect(typeof leaf.getEnvApiKeyName).toBe("function");
		expect(typeof leaf.listProvidersWithEnvKey).toBe("function");
	});

	/**
	 * The resolver TABLE is private, and that is the right surface: `listProvidersWithEnvKey` answers
	 * "which providers have one" and the two getters answer "what is it", so nothing outside needs the
	 * map. Pinned because exporting it would invite a second reader that indexes it directly and drifts
	 * from the three functions' handling of the multi-variable and computed resolvers.
	 */
	it("keeps the resolver table private", async () => {
		const leaf = (await import("../src/env-api-key")) as Record<string, unknown>;

		expect(Object.keys(leaf).sort()).toEqual(["getEnvApiKey", "getEnvApiKeyName", "listProvidersWithEnvKey"]);
	});

	/**
	 * And it really does resolve keys, so the ceilings above are measuring a working module rather than a
	 * stub that happens to be cheap. Only the enumeration is checked here: `env-api-key.test.ts` owns the
	 * BEHAVIOUR, one case per resolver kind (plain name, multi-variable picker, computed probe) with a
	 * real environment round-trip, and duplicating that here would give it two owners.
	 */
	it("enumerates the providers that have an env key", async () => {
		const { listProvidersWithEnvKey } = await import("../src/env-api-key");
		const providers = listProvidersWithEnvKey();

		expect(providers.length).toBeGreaterThan(10);
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
	});
});

describe("the usage table stays free of its backends", () => {
	it(`usage/registry reaches at most ${USAGE_REGISTRY_CEILING} modules`, () => {
		expect(reach("usage/registry.ts")).toBeLessThanOrEqual(USAGE_REGISTRY_CEILING);
	});

	/**
	 * ONE import of a backend here puts the whole graph back on the credential store's path with nothing
	 * failing, which is exactly how the previous arrangement came about. The module's own header says so;
	 * this is the check that makes the sentence load-bearing.
	 */
	it("imports no usage backend and no provider", () => {
		const imports = runtimeImportsOf("usage/registry.ts");

		expect(imports.filter(specifier => specifier.startsWith("./") && specifier !== "./defaults")).toEqual([]);
		expect(imports.filter(specifier => specifier.includes("providers/"))).toEqual([]);
		expect(imports).not.toContain("../stream");
	});

	/**
	 * And `usage/defaults.ts` is where the backends legitimately live, which is what keeps the test above
	 * from being satisfied by the table having no backends to register at all.
	 *
	 * The size claim is RELATIVE, against the table's own measured reach rather than against a multiple of
	 * the table's ceiling. It used to read `> USAGE_REGISTRY_CEILING * 3` and that made it a second ceiling:
	 * cutting a backend's graph honestly made this fail, because the floor tracked the measurement instead
	 * of the fact. The fact is that the module owning the backends costs materially more than the table that
	 * does not, and that stays true however cheap the backends themselves become.
	 */
	it("has one module that does own every backend", () => {
		const defaults = runtimeImportsOf("usage/defaults.ts");

		expect(defaults.filter(specifier => specifier.startsWith("./")).length).toBeGreaterThan(5);
		expect(reach("usage/defaults.ts")).toBeGreaterThan(reach("usage/registry.ts") * 2);
	});
});

describe("the walk really happened", () => {
	/**
	 * NON-VACUITY, and every assertion above needs it. They are upper bounds and `not.toContain`s, so a
	 * resolution that resolved nothing would satisfy all of them with counts near one and report a
	 * beautifully cut package. These pin the floor: the graph is large, the workspace packages resolved,
	 * and a module that SHOULD reach the engine still does.
	 */
	it("resolves the workspace packages it was given", () => {
		const reached = reachedNames("auth-storage.ts");

		expect(reached.length).toBeGreaterThan(150);
		expect(reached.some(file => file.startsWith("packages/utils/src/"))).toBe(true);
		expect(reached.some(file => file.startsWith("packages/catalog/src/"))).toBe(true);
	});

	/**
	 * The control case: a module that is SUPPOSED to reach the engine still does. Without it the "cannot
	 * reach stream.ts" assertions above would be satisfied by a resolution that resolved nothing.
	 *
	 * The control used to be `usage/claude.ts`, on the reasoning that reading Claude's quota means talking
	 * to Anthropic. That reasoning was wrong. The usage client calls one OAuth endpoint with plain `fetch`
	 * and never touches the streaming engine; it reached `stream.ts` only because it imported a version
	 * string from the Anthropic provider, and when that string moved to a leaf the control went false while
	 * nothing was broken. A control has to be a module whose edge is INHERENT, so it is now the Anthropic
	 * provider itself, which cannot stream a completion without the engine.
	 */
	it("still finds stream.ts from a module that legitimately uses it", () => {
		const reached = reachedNames("providers/anthropic.ts");

		expect(reached.some(file => file.endsWith("packages/ai/src/stream.ts"))).toBe(true);
		// The size half of this control used to be `> AUTH_STORAGE_CEILING`, a frozen 227
		// that described a DIFFERENT module's budget. It went false on 2026-07-27 for the
		// best possible reason: every barrel import in `packages/ai/src` was repointed at
		// the module that declares the name, and this provider fell from 253 to 191 without
		// losing a single edge it needs. A control that fails when the tree gets better is
		// not measuring what it meant to, so it compares against the module it is a control
		// FOR: the provider streams and the store does not, so the provider reaches strictly
		// more, and both numbers are read from the same walk rather than from a constant
		// that has to be renegotiated every time something is cut.
		expect(reach("providers/anthropic.ts")).toBeGreaterThan(reach("auth-storage.ts"));
	});

	/**
	 * And the module that used to be the control is now proved to be free of the engine, which is the same
	 * discovery stated as a fact rather than left as a deleted line. Reading a quota is one authenticated
	 * GET; if the streaming stack ever reappears on this path, something has started routing quota reads
	 * through the provider layer and that is worth a failing test.
	 */
	it("the usage client reads a quota without loading the engine", () => {
		const reached = reachedNames("usage/claude.ts");

		expect(reached.some(file => file.endsWith("packages/ai/src/stream.ts"))).toBe(false);
		expect(reached.some(file => file.endsWith("packages/ai/src/providers/anthropic.ts"))).toBe(false);
		expect(reach("usage/claude.ts")).toBeLessThan(AUTH_STORAGE_CEILING);
	});
});
