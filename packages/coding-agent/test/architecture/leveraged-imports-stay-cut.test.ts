import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleReachCount, moduleSpecifiersIn, withoutComments } from "@veyyon/utils/module-reach";
import { PACKAGES, RESOLUTION, reach, reachedNames, SRC } from "../helpers/module-reach-gate";

/**
 * Contracts: the modules the most test files import stay cheap ACROSS packages.
 *
 * WHY THIS IS A SEPARATE GATE FROM THE TWO BESIDE IT. `no-import-cycles.test.ts` and
 * `test-suite-module-reach.test.ts` walk with NO resolution table, so a bare `@veyyon/ai` resolves to
 * nothing and their numbers are this package's own graph. That is the right measurement for a cycle
 * (one has to run through `src/` to be actionable here) and the wrong one for cost: `config/settings.ts`
 * is 36 modules inside this package and was 381 with the workspace resolved, because 228 of them were
 * `@veyyon/ai`. Both gates were green the whole time. This file is the one that can see it.
 *
 * WHAT IT MEASURED, and why these entries and not others. For every module under `src/` imported by at
 * least 15 test files, cost was taken as (test files that import it) x (modules it reaches), on
 * 2026-07-26:
 *
 *     200,640   528 files x 380   config/settings.ts
 *     152,484   291 files x 524   modes/theme/theme.ts
 *     118,038   206 files x 573   session/session-manager.ts
 *     114,777   117 files x 981   session/agent-session.ts
 *      66,674    53 files x 1258  sdk.ts
 *
 * `config/settings.ts` leads by a wide margin and it led for a reason that had nothing to do with
 * settings. Three edges carried the whole of `@veyyon/ai` into it:
 *
 *   1. `settings.ts` imported `configureProviderMaxInFlightRequests` from `@veyyon/ai/stream` -- one
 *      setter, 285 modules. The caps now live in `@veyyon/ai/provider-inflight-limits`, which imports
 *      nothing; `stream.ts` re-exports the setter so no existing caller changed.
 *   2. `settings-domains/model.ts` imported `THINKING_EFFORTS` from the `@veyyon/ai` barrel, and
 *      `thinking.ts` did the same. The list is owned by `@veyyon/catalog/effort`, which imports
 *      nothing. `settings-schema.ts` went from 371 modules to 106 and `thinking.ts` from 346 to 6.
 *   3. `session/agent-storage.ts` imported the sqlite credential store through the `@veyyon/ai` barrel
 *      (345) rather than from `@veyyon/ai/auth-storage` (212), the module that defines it.
 *
 * Together: `config/settings.ts` 381 -> 250. At 528 importing test files that is on the order of 69,000
 * fewer module instantiations across the suite, and every runtime consumer of `Settings` pays less too.
 *
 * AND THEN 125, because edge 3 was only half fixed by re-pointing it. `@veyyon/ai/auth-storage` was 214
 * modules for a reason: it held the credential types, the `AuthStorage` class, AND the sqlite store, so
 * naming a table writer still meant importing the OAuth flows and the provider registry. `packages/ai`
 * split it, and `session/agent-storage.ts` now names `@veyyon/ai/auth-storage-sqlite` (83) and
 * `@veyyon/ai/auth-credential-rows` (75), taking the credential types type-only. 213 -> 84, which took
 * `config/settings.ts` to 125 and, for free, `session/session-manager.ts` 482 -> 369 and
 * `session/session-context.ts` 472 -> 359. The lesson for the next one of these: re-pointing an import at
 * the module that owns the value is the first move, and when that module is itself three modules in one,
 * the number left over is the next task rather than the floor.
 *
 * THE SECOND ENTRY IN THE RANKING WAS NOT A BARREL IMPORT AT ALL, which is why it is worth recording
 * separately. `modes/theme/theme.ts` (291 test files) reached 524, and after the settings cut it still
 * read 307. Nothing in it named a barrel: `getMarkdownTheme` simply LIVED there, and that function binds
 * an ASCII diagram renderer to the palette, so `./mermaid-cache` and its 36 modules sat on the graph of
 * every module that wanted a colour. The fix is the same rule with a different first step: the function
 * moved to `./markdown-theme`, which owns it, and the memoised highlighter both sides needed moved to
 * `./highlight` (17 modules). 307 -> 272, and a component that renders markdown pays the mermaid cost it
 * was always going to pay. Same lesson as the credential store: when the owner is a module that holds
 * several jobs, the import cannot be re-pointed until the jobs are separated.
 *
 * THE THIRD ENTRY WAS THE SAME SHAPE AND THE LARGEST SINGLE DROP. `session/session-manager.ts` (206
 * test files) read 370 after the cuts above, and `session/session-context.ts` 360, and both numbers were
 * one module: `session/messages.ts` at 356. Two of its edges carried 261 of that, and again neither was
 * a barrel import.
 *
 *   - `PROMPTS` from `prompts/registry.ts` (238 modules) for ONE envelope template. The registry is the
 *     deliberate single owner of all 143 prompts and `prompt-registry-coverage` forbids importing one
 *     from anywhere else, so the registry is not the thing to change: `wrapSteeringForModel` moved to
 *     `session/steering-envelope.ts`, which is the module that renders a prompt.
 *   - `formatOutputNotice` from `tools/output-meta.ts` (177), which owns the fluent builder, the tool
 *     wrapper and the spill configuration as well as the notice text. The wording and the metadata
 *     shape moved to `tools/output-notice.ts` (81), and the two strippers went with them, because
 *     `stripOutputNotice` removes a notice by rebuilding it and matching the tail: one module, one
 *     wording.
 *
 * `session/messages.ts` 356 -> 100, `session-context` 360 -> 107, `session-manager` 370 -> 155.
 *
 * THE SAME MISTAKE TWICE MORE, in the session layer, found by re-running the ranking afterwards:
 * `session/session-context.ts` took `coerceServiceTierByFamily` from the barrel though
 * `@veyyon/ai/types` defines it and is 5 modules, and `session/auth-storage.ts` -- a pure re-export
 * shim that 149 test files import for a credential type -- forwarded every name from the barrel rather
 * than from `@veyyon/ai/auth-storage`, which defines all of them. 602 -> 472 and 345 -> 213, carrying
 * `session/session-manager.ts` from 612 to 482. Five edges now, one shape: a value owned by a cheap
 * module, imported through the barrel that re-exports it. The names are identical either way, which is
 * exactly why nothing ever failed.
 *
 * THEN THE RULE WAS WRITTEN DOWN AND IT FOUND TWENTY-ONE MORE, which is the argument for the table
 * below rather than for a twenty-first ceiling. Nine of them were the cheapest kind: `assistantText`,
 * `assistantTextBlocks` and `instrumentationRank` are each defined in a module that reaches exactly ONE,
 * against the barrel's 346, and `modes/utils/copy-targets.ts`, `hindsight/transcript.ts` and
 * `cli/session-stats.ts` each fell from about 347 to 76 on one line. The other twelve did NOT move their
 * own file's number at all, because those files also import `completeSimple` or `streamSimple` and
 * genuinely want the streaming engine. They were fixed anyway, and the reason is worth stating plainly:
 * the rule is that a value is imported from the module that defines it, and a file whose graph happens
 * to be large for a good reason is not a licence to name the wrong owner. Keeping the rule uniform is
 * what makes it enforceable; an exception list of "files that are already expensive" would be a list
 * nobody could maintain, and the day `completeSimple` moves out of one of them the wrong import is
 * still there.
 *
 * WHY A RATCHET AND NOT A BEHAVIOUR TEST. Nothing fails when any of these is undone. Every function
 * keeps working and one convenient barrel import restores the whole graph. What degrades is the honesty
 * of the dependency graph and the cold start of everything downstream, so the number is the only thing
 * that moves and the number is what is pinned -- with the specific edges named, so a failure says which
 * import to change instead of printing a count.
 *
 * NOT A MEMORY GATE. `test-suite-module-reach.test.ts` records the 2026-07-26 measurement: Bun caches
 * modules across test files, so a run costs the UNION of what its files reach rather than the sum.
 * These ceilings are architecture, not RAM.
 */

const AI_SRC = path.join(PACKAGES, "ai/src");

/** The runtime specifiers one module names, which is what a "does not import X" claim is about. */
function runtimeImportsOf(absolute: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(absolute, "utf-8"));
}

/** Every `.ts` under `src/`, which is the set a "nowhere in this package" claim has to cover. */
function sourceFiles(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sourceFiles(full, found);
		else if (full.endsWith(".ts") || full.endsWith(".tsx")) found.push(full);
	}
	return found;
}

/**
 * The VALUE names one file takes from the bare `@veyyon/ai` barrel.
 *
 * `import type { X }` and an inline `type X` specifier are erased, so they cost nothing and are not what
 * this is about. Braced form only, which is the shape every one of these imports has: a namespace import
 * (`import * as ai`) takes everything by definition and is a different conversation.
 */
function barrelValueNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@veyyon\/ai";/g)) {
		for (const raw of match[1].split(",")) {
			const specifier = raw.trim();
			if (specifier === "" || specifier.startsWith("type ")) continue;
			names.push(specifier.split(/\s+as\s+/)[0].trim());
		}
	}
	return names;
}

/**
 * Measured 2026-07-26 at 125, down from 381: first 250 by naming the caps leaf instead of the streaming
 * engine, then 125 when `packages/ai` split the sqlite credential store out of the OAuth module. Room for
 * a few utilities, not for another package.
 */
/**
 * RE-MEASURED 2026-07-26 at 442 with the workspace fully resolved: the 125 was `@veyyon/agent-core` resolving
 * to nothing.
 *
 * RE-MEASURED at 442 the moment the resolution table stopped missing this workspace's own packages, and then
 * CUT to 136. The 125 this once recorded was `@veyyon/agent-core` resolving to nothing: `./compaction-strategy`
 * named `@veyyon/agent-core/compaction` for `resolveThresholdTokens`, and that subpath barrel re-exports the
 * compaction ENGINE, which imports the `@veyyon/ai` barrel to summarize a conversation. The trigger arithmetic
 * moved to `@veyyon/agent-core/compaction/threshold`, the module whose header already claimed to own the
 * trigger.
 */
const SETTINGS_CEILING = 145;
/** Measured at 105, down from 371 when the effort ladder came through the `@veyyon/ai` barrel. */
/**
 * RE-MEASURED 2026-07-26 at 433 with the workspace fully resolved: almost all of the difference is one
 * `@veyyon/agent-core` edge.
 *
 * RE-MEASURED at 433, then CUT to 58. `settings-domains/context.ts` took the one string
 * `AUTO_COMPACTION_THRESHOLD` from the bare `@veyyon/agent-core` barrel, 406 modules for a sentinel, and it now
 * takes it from `@veyyon/agent-core/compaction/threshold`.
 */
const SETTINGS_SCHEMA_CEILING = 65;
/** Measured at 6, down from 346. This one is nearly a leaf and should stay one. */
/**
 * RE-MEASURED 2026-07-26 at 407 with the workspace fully resolved: the 6 was this file's whole graph being
 * three specifiers, one of which was the 406-module `@veyyon/agent-core` barrel resolving to nothing. It is NOT
 * nearly a leaf and never was.
 *
 * RE-MEASURED at 407, then CUT back to 7. This file really is nearly a leaf, but it was not one when this
 * ceiling said 12: it named the bare `@veyyon/agent-core` barrel for `ThinkingLevel`. It now names
 * `@veyyon/agent-core/thinking`, which is a six-entry table and a clamp -- once that module stopped taking
 * `Effort` from the `@veyyon/ai` barrel and took it from `@veyyon/catalog/effort`, its owner, which imports
 * nothing.
 */
const THINKING_CEILING = 12;
/**
 * Measured 2026-07-26 at 84, down from 346. It names `@veyyon/ai/auth-storage-sqlite`, whose whole graph
 * is the row helpers and `bun:sqlite`.
 */
/**
 * RE-MEASURED 2026-07-26 at 92 with the workspace fully resolved: this one barely moved, which says its cut was
 * real.
 *
 * RE-MEASURED at 92 with the workspace fully resolved. Barely moved, which is what a real cut looks like.
 */
const AGENT_STORAGE_CEILING = 98;
/**
 * The `session/auth-storage.ts` shim is 215, and that is not the same number.
 *
 * These two were ONE constant while both files named `@veyyon/ai/auth-storage`. They diverged for a real
 * reason: `agent-storage` wants the STORE, which now lives in its own module, while the shim forwards
 * `AuthStorage` itself, and `AuthStorage` is the OAuth machinery. So 215 is not slack to be cut by
 * repointing an import; it is what that class costs. Cutting it means splitting `AuthStorage`, or the
 * shim's consumers taking the credential TYPES type-only and never naming the class.
 */
/**
 * RE-MEASURED 2026-07-26 at 223 with the workspace fully resolved: barely moved: the OAuth machinery it
 * forwards was already inside `@veyyon/ai`, which every copy of the table did resolve.
 *
 * RE-MEASURED at 223: barely moved either, because the OAuth machinery it forwards is inside `@veyyon/ai`,
 * which every version of the table did resolve.
 */
const AUTH_STORAGE_SHIM_CEILING = 230;
/**
 * Measured 2026-07-26 at 155, down from 612 in four steps: 573 before the settings cut, 482 before the
 * credential-store split, 369 before `session/messages.ts` stopped reaching the prompt registry and the
 * tool layer. 206 test files import this module.
 */
/**
 * RE-MEASURED 2026-07-26 at 455 with the workspace fully resolved: the agent-core barrel again.
 *
 * RE-MEASURED at 455 and NOT cut. It no longer reaches `@veyyon/agent-core` at all; what it has is 238 modules
 * of the `@veyyon/ai` barrel, 78 of the `@veyyon/utils` barrel and 41 of the catalog. A module that streams a
 * conversation is entitled to the streaming engine, so this is the next task rather than a mistake, and it is
 * filed as one.
 *
 * AND THEN CUT to 179 after all, by the edge below it: `session/session-context.ts` took
 * `legacyArchiveSourceText` from `@veyyon/agent-core/compaction`, the subpath barrel that re-exports the
 * compaction engine. The function's owner, `compaction/legacy-snapcompact-archive.ts`, is a self-contained
 * reader for a retired archive format and imports NOTHING. One specifier, 276 modules.
 */
const SESSION_MANAGER_CEILING = 190;
/** Measured at 107, down from 602. Almost all of it was `./messages`, and almost all of that was two edges. */
/**
 * RE-MEASURED 2026-07-26 at 407 with the workspace fully resolved: reached through `./messages`.
 *
 * RE-MEASURED at 407 and NOT cut: the same `@veyyon/ai` barrel, reached through `./messages`.
 *
 * AND THEN CUT to 131 by that one specifier. The `@veyyon/ai` barrel is off it entirely: what is left is 77
 * modules of the `@veyyon/utils` barrel, 18 of `@veyyon/ai` reached as leaves, and 16 of `@veyyon/agent-core`.
 */
const SESSION_CONTEXT_CEILING = 140;
/**
 * Measured at 100, down from 356, and it is the module the two numbers above were made of.
 *
 * Two edges carried 261 of the old 356, and neither was a barrel import. `PROMPTS` came from
 * `prompts/registry.ts`, the deliberate single owner of all 143 prompt files (238 modules), for ONE
 * envelope template; and `formatOutputNotice` came from `tools/output-meta.ts` (177), which owns the
 * fluent builder, the tool wrapper and the spill configuration as well as the notice text. Both were
 * fixed by moving the function to a module that matches what it does: `./steering-envelope` renders the
 * prompt, `tools/output-notice` owns the wording.
 */
/**
 * RE-MEASURED 2026-07-26 at 123 with the workspace fully resolved: the cut held: 20 modules, not 300.
 *
 * RE-MEASURED at 123. The cut recorded above held: 20 modules of correction, not 300.
 */
const MESSAGES_CEILING = 130;
/** Measured at 81: two formatters from `@veyyon/utils` and the diagnostic renderer. */
/**
 * RE-MEASURED 2026-07-26 at 89 with the workspace fully resolved: still nearly a leaf, and this time the number
 * can be trusted.
 *
 * RE-MEASURED at 89, and this time the number can be trusted.
 */
const OUTPUT_NOTICE_CEILING = 95;
/**
 * Measured 2026-07-26 at 272, down from 524 in the ranking above. 291 test files import this module,
 * which is second only to `config/settings.ts`, so what it drags is paid nearly as widely.
 *
 * Two thirds of what remains is `./builtin-themes`, and that is correct: a hundred embedded theme JSON
 * modules are what a theme engine IS. What was not correct was the mermaid renderer, and the shape of
 * that mistake is worth naming because it is not a barrel import. `getMarkdownTheme` lived here, and it
 * binds an ASCII diagram renderer to the palette, so `./mermaid-cache` and its 36 modules were on the
 * graph of every module that wanted a colour. The function moved to `./markdown-theme`, which owns it.
 */
/**
 * RE-MEASURED 2026-07-26 at 588 with the workspace fully resolved: `@veyyon/agent-core` arrives through the
 * settings graph.
 *
 * RE-MEASURED at 588, then back to 282 once `config/settings.ts` stopped carrying the compaction engine.
 * Nothing in the theme engine changed; it was paying for a threshold four hops away.
 */
const THEME_CEILING = 292;
/** Measured at 17: the logger, the type guards, the theme binding. It must not grow into the engine. */
/**
 * RE-MEASURED 2026-07-26 at 25 with the workspace fully resolved: still small, which is the whole claim.
 *
 * RE-MEASURED at 25, still small, which is the whole claim.
 */
const HIGHLIGHT_CEILING = 30;

/**
 * Values whose owner is far cheaper than the barrel that re-exports them, with that owner.
 *
 * WHY A TABLE AND NOT FOURTEEN MORE CEILINGS. Every cut recorded in this file was the same edit:
 * a value defined in a cheap module, imported through `@veyyon/ai` because the barrel re-exports it and
 * an editor offers that first. Fourteen per-module ceilings would each catch one recurrence in one file
 * and say nothing about the fifteenth. This says the rule instead: nowhere under `src/` does a file take
 * one of these names from the bare barrel, whatever module it is. Each entry carries the number that
 * makes it worth stating, and a new entry costs one line rather than a new suite.
 *
 * `import type` is not covered and must not be: a type import is erased, costs nothing at runtime, and
 * narrowing an import to a type is one of the sanctioned ways to cut a graph.
 */
const CHEAP_OWNERS: ReadonlyArray<readonly [name: string, owner: string, ownerReach: number]> = [
	// 1 module each. The barrel is 346, so these were the most lopsided of the set.
	["assistantText", "@veyyon/ai/utils/message-text", 1],
	["assistantTextBlocks", "@veyyon/ai/utils/message-text", 1],
	["instrumentationRank", "@veyyon/ai/instrumentation", 1],
	["resolveUsedFraction", "@veyyon/ai/usage", 1],
	// The effort ladder is owned by the catalog, and `@veyyon/catalog/effort` imports nothing at all.
	["Effort", "@veyyon/catalog/effort", 1],
	["THINKING_EFFORTS", "@veyyon/catalog/effort", 1],
	// 5 modules: the wire shapes and their coercions.
	["coerceServiceTierByFamily", "@veyyon/ai/types", 5],
	// The provider registry is inherently ~164 (75 provider definition modules are the point of it), but
	// that is still less than half the barrel, which adds the streaming engine and every transport.
	["PASTE_CODE_LOGIN_PROVIDERS", "@veyyon/ai/registry/derived", 164],
	["PROVIDER_REGISTRY", "@veyyon/ai/registry", 163],
	// 75 and 83: the row helpers and the sqlite store, once they stopped living inside the OAuth module.
	["isSqliteBusyError", "@veyyon/ai/auth-credential-rows", 75],
	["SqliteAuthCredentialStore", "@veyyon/ai/auth-storage-sqlite", 83],
	// 214: `AuthStorage` itself really is the OAuth machinery, so this is its cost and not slack. Still
	// less than the barrel, which adds the streaming engine and every transport on top.
	["AuthStorage", "@veyyon/ai/auth-storage", 214],
	["REMOTE_REFRESH_SENTINEL", "@veyyon/ai/auth-storage", 214],
];

describe("cheap values are imported from their owners, everywhere in the package", () => {
	const sources = sourceFiles(SRC).map(file => [path.relative(SRC, file), fs.readFileSync(file, "utf-8")] as const);

	/**
	 * NON-VACUITY FIRST, because this is the one case here that scans instead of measuring. If the file
	 * discovery or the import parse broke, every `it.each` below would pass on an empty set and the whole
	 * table would become decoration. So: the package really has hundreds of source files, and the parser
	 * really does find barrel value imports (there are legitimate ones -- `completeSimple`, `streamSimple`
	 * and the rest genuinely want the streaming engine).
	 */
	it("reads the package and can see a barrel value import when there is one", () => {
		expect(sources.length).toBeGreaterThan(400);

		const withBarrelValues = sources.filter(([, source]) => barrelValueNames(source).length > 0);
		expect(withBarrelValues.length).toBeGreaterThan(5);

		const found = new Set(withBarrelValues.flatMap(([, source]) => barrelValueNames(source)));
		expect([...found]).toContain("completeSimple");
	});

	/**
	 * SECOND NON-VACUITY CHECK, for the table itself. Every row says "do not take this name from the
	 * barrel", which is trivially satisfied for a name the barrel does not export: a rename, or a removed
	 * `export *`, turns that row into decoration without failing anything. So each listed name must really
	 * be reachable through the barrel, which is what makes the wrong import possible and the row worth
	 * having. `serializeCredential` is deliberately absent from the table for exactly this reason: it is
	 * owned by `@veyyon/ai/auth-credential-rows` and the barrel never re-exported it.
	 */
	it("lists only names the barrel really re-exports, so every row guards a possible import", async () => {
		const barrel = (await import("@veyyon/ai")) as Record<string, unknown>;

		const missing = CHEAP_OWNERS.map(([name]) => name).filter(name => !(name in barrel));
		expect(missing, "a name the barrel does not export cannot be imported from it, so the row is dead").toEqual([]);
	});

	it.each(CHEAP_OWNERS)("%s comes from %s (%i modules), never the barrel", (name, owner, ownerReach) => {
		const offenders = sources
			.filter(([, source]) => barrelValueNames(source).includes(name))
			.map(([relative]) => relative);

		expect(
			offenders,
			`${name} is defined in ${owner}, which reaches ${ownerReach} module(s) against the @veyyon/ai barrel's 346. Import it from there instead.`,
		).toEqual([]);
	});
});

describe("config/settings, the most imported module in the package", () => {
	/**
	 * The number 528 test files pay. It is an upper bound, so the floor case further down is what makes
	 * it mean anything: a walker that resolved nothing would satisfy this and say nothing.
	 */
	it(`reaches at most ${SETTINGS_CEILING} modules with the workspace resolved`, () => {
		expect(reach("config/settings.ts")).toBeLessThanOrEqual(SETTINGS_CEILING);
	});

	/**
	 * THE EDGE THAT COST THE MOST, named so a failure says what to undo. `configureProviderMaxInFlightRequests`
	 * is re-exported from `@veyyon/ai/stream`, so the convenient import still compiles and still works,
	 * and taking it puts the streaming engine, every provider transport and the model registry back on
	 * the path of everything that reads a setting. Import it from
	 * `@veyyon/ai/provider-inflight-limits`, which is where the caps live.
	 */
	it("does not reach the streaming engine by any path", () => {
		const stream = path.relative(PACKAGES, path.join(AI_SRC, "stream.ts"));

		expect(reachedNames("config/settings.ts")).not.toContain(stream);
	});

	/**
	 * The barrel too, which is the other way the same 285 modules arrive. Checked as reachability rather
	 * than as a source search: the string `@veyyon/ai` appears in this file's own comments explaining
	 * why it is absent, and a text check would fail for the opposite of its purpose.
	 */
	it("does not reach the @veyyon/ai barrel by any path", () => {
		const barrel = path.relative(PACKAGES, path.join(AI_SRC, "index.ts"));

		expect(reachedNames("config/settings.ts")).not.toContain(barrel);
	});

	/**
	 * NON-VACUITY, and the control for both assertions above. Settings really does reach `@veyyon/ai`,
	 * through the sqlite credential store its own storage layer needs, so the walk demonstrably crosses
	 * the package boundary and "does not reach stream.ts" is a statement about a path that exists to be
	 * found rather than about a walk that stopped early.
	 *
	 * It reaches `auth-storage-sqlite.ts` and NOT `auth-storage.ts`, which is the split's whole point: the
	 * store is here because settings persists credentials, and the OAuth machinery is gone because
	 * persisting a credential never needed it. The floor is 60, well under the 125 measured, because its
	 * job is to catch a resolution table that stopped resolving and not to forbid the next cut.
	 */
	it("still reaches the credential store, which is what makes the two absences meaningful", () => {
		const names = reachedNames("config/settings.ts");

		expect(names).toContain(path.relative(PACKAGES, path.join(AI_SRC, "auth-storage-sqlite.ts")));
		expect(names).not.toContain(path.relative(PACKAGES, path.join(AI_SRC, "auth-storage.ts")));
		expect(names.length).toBeGreaterThan(60);
	});
});

describe("the settings schema and the thinking ladder", () => {
	/** The schema is composed from the domain slices, so it is the whole schema's cost in one number. */
	it(`settings-schema reaches at most ${SETTINGS_SCHEMA_CEILING} modules`, () => {
		expect(reach("config/settings-schema.ts")).toBeLessThanOrEqual(SETTINGS_SCHEMA_CEILING);
	});

	it(`thinking reaches at most ${THINKING_CEILING} modules`, () => {
		expect(reach("thinking.ts")).toBeLessThanOrEqual(THINKING_CEILING);
	});

	/**
	 * The specific import that was 265 modules of the schema's old 371. `THINKING_EFFORTS` is defined in
	 * `@veyyon/catalog/effort`, which imports nothing at all; the `@veyyon/ai` barrel re-exports it, and
	 * naming the re-export instead of the owner is what dragged the package in. Both files that read the
	 * ladder are checked, because fixing one and leaving the other keeps the whole graph.
	 */
	it("reads the effort ladder from the module that owns it, not through a barrel", () => {
		for (const file of ["config/settings-domains/model.ts", "thinking.ts"]) {
			const imports = runtimeImportsOf(path.join(SRC, file));

			expect(imports, `${file} should take THINKING_EFFORTS from @veyyon/catalog/effort`).toContain(
				"@veyyon/catalog/effort",
			);
			expect(imports, `${file} should not import the @veyyon/ai barrel at runtime`).not.toContain("@veyyon/ai");
		}
	});

	/** And neither reaches the barrel transitively, which a direct-import check alone cannot see. */
	it("keeps the @veyyon/ai barrel off both of their graphs", () => {
		const barrel = path.relative(PACKAGES, path.join(AI_SRC, "index.ts"));

		expect(reachedNames("config/settings-schema.ts")).not.toContain(barrel);
		expect(reachedNames("thinking.ts")).not.toContain(barrel);
	});

	/**
	 * FLOOR, so the three ceilings above cannot pass by resolving nothing. `thinking.ts` genuinely
	 * imports `@veyyon/agent-core`, `@veyyon/catalog/effort` and `@veyyon/catalog/model-thinking`, so a
	 * working walk lands well above one.
	 */
	it("actually walks the graph it is measuring", () => {
		expect(reach("thinking.ts")).toBeGreaterThan(3);
		expect(reachedNames("thinking.ts")).toContain(
			path.relative(PACKAGES, path.join(PACKAGES, "catalog/src/effort.ts")),
		);
	});
});

describe("the caps leaf that made the settings cut possible", () => {
	/**
	 * It imports NOTHING, and that is the whole design. The state it owns is written by the harness's
	 * settings layer and read by the streaming engine, so it has to be nameable by the writer without
	 * naming the reader. One import here re-couples the two.
	 */
	it("imports nothing at all", () => {
		const leaf = path.join(AI_SRC, "provider-inflight-limits.ts");

		expect(runtimeImportsOf(leaf)).toEqual([]);
		expect(moduleReachCount(leaf, RESOLUTION)).toBe(1);
	});

	/**
	 * And the engine still reads the same owner rather than keeping a second copy of the record. Two
	 * copies of "the configured caps" would drift: the harness would write one and the engine would
	 * read the other, so a configured cap would silently stop applying. The engine's own suite proves
	 * the behaviour; this proves there is one owner for it to prove.
	 */
	it("is what the streaming engine resolves its limits through", () => {
		const imports = runtimeImportsOf(path.join(AI_SRC, "stream.ts"));

		expect(imports).toContain("./provider-inflight-limits");
	});
});

describe("session/agent-storage, the remaining edge into @veyyon/ai", () => {
	/**
	 * 84, and the history is the argument for keeping this pinned. It was 346 through the barrel, 213 once
	 * it named `@veyyon/ai/auth-storage`, and 84 once that module stopped being three modules in one. Each
	 * step was invisible to every other gate, because none of them changed what any function returned.
	 */
	it(`reaches at most ${AGENT_STORAGE_CEILING} modules`, () => {
		expect(reach("session/agent-storage.ts")).toBeLessThanOrEqual(AGENT_STORAGE_CEILING);
	});

	/**
	 * The three imports this file needs, each from the module that OWNS the name. The store from
	 * `auth-storage-sqlite` (83), the busy predicate from `auth-credential-rows` (75), and the credential
	 * types from `auth-storage` as TYPES, which is why that specifier is absent from the runtime list:
	 * `import type` is erased. A value import of any of the three from `@veyyon/ai` or from
	 * `@veyyon/ai/auth-storage` compiles, runs, and costs this file 214 modules again.
	 */
	it("imports the credential store from its own module, not the barrel", () => {
		const imports = runtimeImportsOf(path.join(SRC, "session/agent-storage.ts"));

		expect(imports).toContain("@veyyon/ai/auth-storage-sqlite");
		expect(imports).toContain("@veyyon/ai/auth-credential-rows");
		expect(imports).not.toContain("@veyyon/ai");
		expect(imports).not.toContain("@veyyon/ai/auth-storage");
	});
});

describe("the session layer, the next two entries in the same ranking", () => {
	/**
	 * `session/session-manager.ts` is imported by 206 test files and reached 573 modules. One import
	 * carried 130 of them: `session/session-context.ts` took `coerceServiceTierByFamily` from the
	 * `@veyyon/ai` barrel (346 modules) though it is defined in `@veyyon/ai/types`, which is 5.
	 */
	it(`session-manager reaches at most ${SESSION_MANAGER_CEILING} modules`, () => {
		expect(reach("session/session-manager.ts")).toBeLessThanOrEqual(SESSION_MANAGER_CEILING);
	});

	it(`session-context reaches at most ${SESSION_CONTEXT_CEILING} modules`, () => {
		expect(reach("session/session-context.ts")).toBeLessThanOrEqual(SESSION_CONTEXT_CEILING);
	});

	/**
	 * The edge by name. `@veyyon/ai/types` holds the wire shapes and their coercions and imports almost
	 * nothing, so a module that wants one coercion should say so; the barrel additionally brings the
	 * streaming engine, the provider registry and every transport.
	 */
	it("takes the service-tier coercion from @veyyon/ai/types, not the barrel", () => {
		const imports = runtimeImportsOf(path.join(SRC, "session/session-context.ts"));

		expect(imports).toContain("@veyyon/ai/types");
		expect(imports).not.toContain("@veyyon/ai");
	});

	/**
	 * `session/auth-storage.ts` is a pure re-export shim that 149 test files import for a credential
	 * type. It named the barrel (347) instead of `@veyyon/ai/auth-storage` (214), which defines every
	 * name it forwards. The names are identical either way, which is exactly why nothing failed.
	 *
	 * It stayed at 215 through the store split, unlike `agent-storage`, because it forwards `AuthStorage`
	 * and that class IS the OAuth machinery. See {@link AUTH_STORAGE_SHIM_CEILING}.
	 */
	it(`the auth-storage shim reaches at most ${AUTH_STORAGE_SHIM_CEILING} modules`, () => {
		expect(reach("session/auth-storage.ts")).toBeLessThanOrEqual(AUTH_STORAGE_SHIM_CEILING);
	});

	it("forwards the credential names from their own module, not the barrel", () => {
		const imports = runtimeImportsOf(path.join(SRC, "session/auth-storage.ts"));

		expect(imports).toContain("@veyyon/ai/auth-storage");
		expect(imports).not.toContain("@veyyon/ai");
	});

	/**
	 * FLOOR for this group, and a control. The session manager legitimately reaches deep into the
	 * package, so a walk that produced a small number here would mean the resolution table stopped
	 * working rather than that a cut had landed.
	 *
	 * 150 against 369 measured, deliberately loose. A floor set near its measurement reports FAILURE for
	 * the improvement the ceiling above exists to encourage: this one read 300 while the manager measured
	 * 369, so the store split (369 from 482) came within one more cut of turning it red. Its job is to
	 * detect a broken resolution table, and a broken table returns single digits.
	 */
	it("actually walks the session graph", () => {
		expect(reach("session/session-manager.ts")).toBeGreaterThan(150);
		expect(reachedNames("session/session-manager.ts")).toContain(
			path.relative(PACKAGES, path.join(SRC, "session/messages.ts")),
		);
	});
});

describe("the theme engine, second in the same ranking", () => {
	/**
	 * 291 test files import this, so 35 modules of diagram machinery on its graph is about 10,000
	 * instantiations across the suite for a closure most of them never call.
	 */
	it(`modes/theme/theme reaches at most ${THEME_CEILING} modules`, () => {
		expect(reach("modes/theme/theme.ts")).toBeLessThanOrEqual(THEME_CEILING);
	});

	/**
	 * THE EDGE, by name, in both of the forms it can come back in. `./mermaid-cache` is the direct
	 * import that used to be here; `@veyyon/utils/mermaid-ascii` is the renderer behind it, and a file
	 * that reached for that directly would restore most of the cost while leaving the local import
	 * absent. Neither is reachable by any path now.
	 */
	it("does not reach the mermaid renderer by any path", () => {
		const reached = reachedNames("modes/theme/theme.ts");

		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/mermaid-cache.ts")));
		expect(reached).not.toContain(path.join("utils", "src", "mermaid-ascii.ts"));
	});

	/**
	 * And it must not reach the module the markdown adapter moved to, which is the other way the same
	 * modules arrive. Nothing imports back into the engine from the adapter either, now: the edge that
	 * used to make this a one-way dependency rather than an absence was `getSymbolTheme`, and that
	 * function moved to `./symbol-theme`. See the group below.
	 */
	it("does not reach the markdown adapter, and the adapter no longer reaches back", () => {
		expect(reachedNames("modes/theme/theme.ts")).not.toContain(
			path.relative(PACKAGES, path.join(SRC, "modes/theme/markdown-theme.ts")),
		);
		expect(reachedNames("modes/theme/markdown-theme.ts")).not.toContain(
			path.relative(PACKAGES, path.join(SRC, "modes/theme/theme.ts")),
		);
	});

	/**
	 * THE SYMBOL LEAF, and it is the second time this exact mistake was made one function away from the
	 * module built to prevent it.
	 *
	 * `./theme-binding` exists so a module can read the ACTIVE theme without loading the engine, and its
	 * doc says to keep it a leaf and warns that a value import of `./theme` puts the engine back in front
	 * of every reader. `./markdown-theme` then took `getSymbolTheme` from `./theme` for one field of the
	 * markdown theme it builds, and the engine was 144 MARGINAL modules on that graph: a box-drawing
	 * character set carried theme JSON loading, the hundred embedded theme modules, syntax highlighting
	 * and mermaid rendering into every rendered markdown cell, and through `tui/code-cell.ts` into
	 * `tools/read.ts`, which 54 test files import.
	 *
	 * `modes/theme/symbol-theme.ts` is that function beside the binding. MEASURED: `markdown-theme`
	 * 319 -> 175, `tui/code-cell.ts` 327 -> 220, `tools/read.ts` 648 -> 542, `modes/components/diff.ts`
	 * 288 -> 181.
	 */
	it("keeps the symbol reader a leaf, so reading the active symbols costs the binding and nothing else", () => {
		expect(reach("modes/theme/symbol-theme.ts")).toBe(2);
		expect(runtimeImportsOf(path.join(SRC, "modes/theme/symbol-theme.ts"))).toEqual(["./theme-binding"]);
	});

	/**
	 * The two renderers that paid for it, asserted as reachability in both directions. They must reach
	 * the symbol leaf (or they are not rendering the active theme's symbols at all) and must not reach
	 * the engine by ANY path, which is the assertion that fails if a later import re-opens the edge four
	 * hops away, the way this one was opened.
	 */
	it.each(["modes/theme/markdown-theme.ts", "tui/code-cell.ts"])(
		"%s reads symbols from the leaf and never reaches the engine",
		relative => {
			const reached = reachedNames(relative);

			expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/symbol-theme.ts")));
			expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/theme-binding.ts")));
			expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/theme.ts")));
			// The engine's own heaviest subtree, named directly: the hundred embedded theme JSON modules.
			expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/builtin-themes.ts")));
		},
	);

	/**
	 * NON-VACUITY for the leaf. The engine still forwards `getSymbolTheme`, so the eight modules that
	 * take it from `./theme` are unchanged, and it still reaches the leaf itself. A "moved" function that
	 * the engine had stopped re-exporting would compile here and break those eight at their import.
	 */
	it("still forwards the symbol reader from the engine, so no existing caller changed", () => {
		expect(reachedNames("modes/theme/theme.ts")).toContain(
			path.relative(PACKAGES, path.join(SRC, "modes/theme/symbol-theme.ts")),
		);
		expect(fs.readFileSync(path.join(SRC, "modes/theme/theme.ts"), "utf-8")).toContain(
			'export { getSymbolTheme } from "./symbol-theme"',
		);
	});

	/**
	 * And the same for the four names the engine merely FORWARDS, which is how the edge kept coming back:
	 * `highlightCode` lives in `./highlight` (24 modules), `theme` in `./theme-binding` (1),
	 * `getLanguageFromPath` in `utils/lang-from-path` (1), `getSymbolTheme` in `./symbol-theme` (2). Nine
	 * modules took one of them from `./theme` and paid 282 for it. Any file that renders code must name
	 * the owner.
	 */
	it.each([
		"tui/code-cell.ts",
		"tui/file-list.ts",
		"modes/components/diff.ts",
		"modes/components/ask-dialog.ts",
		"modes/components/copy-selector.ts",
		"modes/components/eval-execution.ts",
		"modes/components/execution-shared.ts",
		"tools/bash.ts",
		"tools/write.ts",
		"lsp/render.ts",
	])("%s names the owner of the highlighter rather than the engine that forwards it", relative => {
		const imports = runtimeImportsOf(path.join(SRC, relative));

		expect(imports.filter(specifier => /(?:^|\/)theme\/theme$/.test(specifier))).toEqual([]);
	});

	/**
	 * THE LAST PATHS, which is the half of this that a per-file repoint does not finish. Naming the owner
	 * of every theme helper a file uses cuts nothing while the engine arrives through a DIFFERENT import,
	 * and it did for three of the heaviest files in the package:
	 *
	 *   - `tools/bash.ts` and `tools/write.ts` took three names from the local `../tui` barrel, which
	 *     `export *`s `./file-list`, and THAT module took `getLanguageFromPath` from the engine. So a
	 *     status line cost 282 modules of presentation layer, four hops away.
	 *   - `modes/components/eval-execution.ts` took `getSymbolTheme` and `theme` from
	 *     `./execution-shared`, which took them from the engine.
	 *
	 * MEASURED: `tui/file-list.ts` 289 -> 180, the local `tui/index.ts` barrel 352 -> 246,
	 * `tools/bash.ts` 504 -> 353, `tools/write.ts` 536 -> 386, `modes/components/eval-execution.ts`
	 * 299 -> 193, and the whole suite 857,632 -> 832,035 module instantiations.
	 *
	 * Asserted by REACHABILITY rather than by the import list, because that is the difference between the
	 * two halves: the cases above prove no file NAMES the engine, and these prove none REACHES it.
	 */
	it.each([
		// Each row carries its own CONTROL: something the file must still reach, so that deleting its theme
		// usage entirely would fail rather than satisfy the two absences. `tui/file-list.ts` is the one that
		// needs a different control from the rest: it takes `Theme` as an erased type and wanted only the
		// language table, so it has no runtime theme dependency at all and asserting the binding here failed
		// for the right reason. That is the shape of a vacuous absence, caught by writing the control down.
		["tui/file-list.ts", "utils/lang-from-path.ts"],
		["tui/index.ts", "modes/theme/theme-binding.ts"],
		["tools/bash.ts", "modes/theme/theme-binding.ts"],
		["tools/write.ts", "modes/theme/theme-binding.ts"],
		["modes/components/eval-execution.ts", "modes/theme/symbol-theme.ts"],
		["modes/components/execution-shared.ts", "modes/theme/symbol-theme.ts"],
	])("%s reaches the theme engine by no path at all", (relative, control) => {
		const reached = reachedNames(relative);

		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/theme.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/builtin-themes.ts")));
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, control)));
	});

	/**
	 * NON-VACUITY, and the control for both absences above. The markdown adapter DOES reach the mermaid
	 * renderer, because that is what it is for: the cost did not disappear, it moved to the module whose
	 * consumers were always going to pay it. A walk that resolved nothing would satisfy the two
	 * "does not reach" cases and this one would fail.
	 */
	it("keeps the mermaid renderer on the markdown adapter, which is what wants it", () => {
		const reached = reachedNames("modes/theme/markdown-theme.ts");

		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/mermaid-cache.ts")));
		expect(reached).toContain(path.join("utils", "src", "mermaid-ascii.ts"));
	});

	/**
	 * The memoised highlighter had to become reachable from both sides for the split, so it is its own
	 * module now, and it is a leaf on purpose: the logger, the type guards, the theme binding. It takes
	 * `logger` and `errorMessage` from the modules that own them rather than from the `@veyyon/utils`
	 * barrel, which is 74 for those two names.
	 */
	it(`modes/theme/highlight reaches at most ${HIGHLIGHT_CEILING} modules`, () => {
		expect(reach("modes/theme/highlight.ts")).toBeLessThanOrEqual(HIGHLIGHT_CEILING);
	});

	/**
	 * NO CYCLE BACK INTO THE ENGINE. It reads the ACTIVE theme through `./theme-binding`, which exists
	 * precisely so a module can use the current palette without importing the loader that sets it. An
	 * import of `./theme` here would close theme -> highlight -> theme, and the last cycle through this
	 * file cost 51 MB per realm (see the note on the settings subscription in `theme.ts`).
	 */
	it("reads the active theme through the binding, not through the engine", () => {
		const imports = runtimeImportsOf(path.join(SRC, "modes/theme/highlight.ts"));

		expect(imports).toContain("./theme-binding");
		expect(imports).not.toContain("./theme");
		expect(reachedNames("modes/theme/highlight.ts")).not.toContain(
			path.relative(PACKAGES, path.join(SRC, "modes/theme/theme.ts")),
		);
	});

	/**
	 * FLOOR for this group. `./builtin-themes` alone is a hundred JSON modules, so a working walk cannot
	 * report a small number here; well below the 272 measured, for the reason recorded on the session
	 * floor above.
	 */
	it("actually walks the theme graph", () => {
		expect(reach("modes/theme/theme.ts")).toBeGreaterThan(120);
		expect(reachedNames("modes/theme/theme.ts")).toContain(
			path.relative(PACKAGES, path.join(SRC, "modes/theme/builtin-themes.ts")),
		);
	});
});

describe("session/messages, which the session layer is mostly made of", () => {
	/**
	 * 100 measured. `session/session-context.ts` is 107 and `session/session-manager.ts` 155, and the
	 * difference between those and the 602 and 612 they started at is almost entirely this module.
	 */
	it(`session/messages reaches at most ${MESSAGES_CEILING} modules`, () => {
		expect(reach("session/messages.ts")).toBeLessThanOrEqual(MESSAGES_CEILING);
	});

	/**
	 * THE PROMPT REGISTRY, by name. It is the deliberate single owner of all 143 prompt files, so it
	 * reaches 238 modules and `prompt-registry-coverage` forbids importing a prompt from anywhere else.
	 * Both of those are correct, which is why the fix was to move the one function that renders a prompt
	 * (`wrapSteeringForModel`, now in `./steering-envelope`) rather than to reach around the registry.
	 * A file that renders a prompt should name the registry; a file about message SHAPES should not.
	 */
	it("does not reach the prompt registry", () => {
		expect(reachedNames("session/messages.ts")).not.toContain(
			path.relative(PACKAGES, path.join(SRC, "prompts/registry.ts")),
		);
	});

	/**
	 * THE TOOL LAYER, by name and in both spellings it arrives in. `tools/output-meta.ts` owns the fluent
	 * builder, the tool wrapper and the spill configuration on top of the notice text, so it reaches
	 * `config/settings`, the streaming output sink and the artifact store. Appending a notice to a message
	 * needs the wording only, which is what `tools/output-notice.ts` owns.
	 */
	it("does not reach the tool layer, only the notice wording", () => {
		const reached = reachedNames("session/messages.ts");

		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "tools/output-meta.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "tools/output-artifact.ts")));
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "tools/output-notice.ts")));
	});

	/**
	 * The specifiers, so a failure names the import to change rather than a count. Both are the kind of
	 * edit that compiles and runs either way: `output-meta` re-exports every notice name, and the
	 * registry is one autocomplete away.
	 */
	it("names the notice module and not the tool module", () => {
		const imports = runtimeImportsOf(path.join(SRC, "session/messages.ts"));

		expect(imports).toContain("../tools/output-notice");
		expect(imports).not.toContain("../tools/output-meta");
		expect(imports).not.toContain("../prompts/registry");
	});

	/** The notice wording is a leaf: two formatters and the diagnostic renderer. */
	it(`tools/output-notice reaches at most ${OUTPUT_NOTICE_CEILING} modules`, () => {
		expect(reach("tools/output-notice.ts")).toBeLessThanOrEqual(OUTPUT_NOTICE_CEILING);
	});

	/**
	 * It must not reach back into the tool layer it came out of, in particular not `config/settings`. The
	 * notice text is a pure function of the metadata; a settings read inside it would make the wording
	 * depend on configuration, and `stripOutputNotice` removes a notice by REBUILDING it and matching the
	 * tail, so wording that varied with settings would silently stop stripping.
	 */
	it("keeps the notice wording independent of settings and the tool wrapper", () => {
		const reached = reachedNames("tools/output-notice.ts");

		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "config/settings.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "tools/output-meta.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "modes/theme/theme.ts")));
	});

	/**
	 * NON-VACUITY for this group, and the second half of the prompt-registry split. `./steering-envelope`
	 * DOES reach a prompt row, because rendering that template is what it is for: the cost of a prompt
	 * belongs on the module that renders it. What changed is HOW MUCH that costs. It reached
	 * `prompts/registry.ts` and through it all 163 prompt texts (216 modules for the file, of which 167 was
	 * the registry); it now reaches `prompts/steering/rows.ts`, which is its two prompts and the row
	 * contract, and the file is 86.
	 *
	 * Both directions again: the row must be reached, or this module is not rendering the prompt it claims
	 * to; the aggregate must not, or the two prompts it needs still cost the corpus.
	 */
	it("renders its prompt from the steering rows and not from the whole registry", () => {
		const reached = reachedNames("session/steering-envelope.ts");

		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "prompts/steering/rows.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "prompts/registry.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "prompts/tools/rows.ts")));
		expect(reach("session/steering-envelope.ts")).toBeGreaterThan(50);
	});

	/**
	 * FLOOR for the group, loose on purpose. `@veyyon/ai/error` alone is 91 modules and is genuinely
	 * needed (`AIError.is` classifies interrupted turns), so a working walk cannot report a small number.
	 */
	it("actually walks the message graph", () => {
		expect(reach("session/messages.ts")).toBeGreaterThan(50);
		expect(reachedNames("session/messages.ts")).toContain(path.join("ai", "src", "error", "index.ts"));
	});
});

/**
 * Reading a local file, and the five hops that made it expensive.
 *
 * `tools/read.ts` reached 972 modules and 54 test files import it. None of it was a barrel mistake in
 * the sense the table above catches; it was four PROCESS-GLOBAL SLOTS and two pure functions living
 * inside the heavy modules that fill them, chained:
 *
 *   read -> internal-urls -> router -> mcp-protocol -> MCPManager (the client, 870)
 *   read -> internal-urls -> router -> skill-protocol -> extensibility/skills (the loader, 365)
 *   read -> fetch -> tui barrel -> hyperlink -> memory-protocol -> memories (the consolidator, 558)
 *   read -> fetch -> tui barrel -> status-line -> tools/render-utils (the tool renderer, 167)
 *
 * Each hop was one import that looked local. `mcp-protocol` used `MCPManager` as a TYPE everywhere but
 * once, and that once was `MCPManager.instance()`: reading a static slot, which costs the class.
 * `skill-protocol` reads `getActiveSkills()`, a module-scope snapshot inside the loader.
 * `memory-protocol` wanted `getMemoryRoot`, a two-line path join inside the module that asks a model to
 * summarise a session. `status-line` wanted `formatStatusIcon`, a switch over eight cases.
 *
 * THE RULE THAT COMES OUT OF IT, and the reason these are grouped: a process-global slot belongs in a
 * module that imports nothing, not on the class that fills it, and a pure function belongs beside its own
 * inputs rather than inside the subsystem that happens to use it. Four leaves came out of this
 * (`mcp/manager-instance`, `extensibility/active-skills`, `memories/paths`, `tools/tool-ui-status`), each
 * re-exported from where it used to live so no caller changed, and each asserted below to import nothing
 * at runtime. Every reader of an empty slot already reported it: "No MCP manager available", "no skill
 * named X", so nothing became quieter.
 *
 * 972 -> 736, and the remaining edges are NAMED in the ceiling docs rather than left as a number.
 *
 * AND THEN THE `gh` SPLIT, which was the third-named edge above and the last one that was a module doing
 * two jobs. `tools/gh.ts` held the cache-aware issue/PR/diff FETCHERS and the `GithubTool` class, and the
 * class renders its own description from `prompts/registry.ts`, so `internal-urls/issue-pr-protocol.ts`
 * paid the whole prompt corpus to resolve `issue://123`. The fetchers moved to `tools/gh-fetch.ts` and the
 * primitives both halves share to `tools/gh-format.ts` (4 modules), with every name re-exported from
 * `tools/gh.ts`. `issue-pr-protocol` 355 -> 84 and `internal-urls/index.ts` 418 -> 205.
 *
 * `tools/read.ts` barely moved for it (735 -> 734), and that is worth stating rather than hiding: the
 * router is only 41 marginal modules on read's graph, so cutting 213 from it removed almost nothing read
 * was not already paying for through `./fetch` and `../tui/code-cell`. A cut can be large and still not
 * be the cut THIS file needs; the ranking says which, and the ranking said the other two.
 */
/**
 * Measured 2026-07-26 at 734, down from 972. NOT YET the 300 the backlog row asks for, and the two edges
 * between here and there are known and now measured with the marginal cost stated: `./fetch` (359 own,
 * 116 marginal, whose own cost is `web/parallel` at 209 and `markit` at 96) and `../tui/code-cell` (317
 * own, 145 marginal, which is `modes/theme/markdown-theme` and legitimate for a cell that renders
 * markdown). `../internal-urls` is down to 41 marginal and is no longer where the next cut is.
 * Ratcheted to what was measured so the next cut has a number to beat; never raise it.
 */
/**
 * RE-MEASURED 2026-07-26 at 928 with the workspace fully resolved: the 300 target in the backlog row was set
 * against an under-measured graph and the row now says so.
 *
 * RE-MEASURED at 928, then 918 after the compaction cut, and the 736 recorded above was never true: four of
 * this workspace's packages did not resolve. The 300 target in the backlog row was set against that
 * under-measurement and the row now says so. What is actually here: 431 modules of this package, 238 of the
 * `@veyyon/ai` barrel, 113 of `@veyyon/utils`, 41 of the catalog.
 *
 * AND THEN 761, from the same one-specifier cut four hops away. What is left is 431 modules of this package,
 * 113 of the `@veyyon/utils` barrel, 100 of `@veyyon/ai` through `./fetch`, 37 of the catalog and 37 of the TUI
 * barrel.
 * AND THEN 647, from splitting the prompt registry into one row module per prompt directory. `read.ts`
 * imports `../prompts/tools/rows` for `toolsPrompts["tools/read"]`, its own description, which is 51 modules;
 * it used to import `../prompts/registry`, which was 167 because that module held the `.md` import for all
 * 163 prompts. That edge was the single largest one this file had, and 95 files in this package had it.
 *
 * AND THEN 542, from the theme engine leaving the graph: `tui/code-cell.ts` took `highlightCode` from
 * `modes/theme/theme` (282 modules, which merely FORWARDS it from `modes/theme/highlight`, 24), and
 * `modes/theme/markdown-theme.ts` took `getSymbolTheme` from the engine as well. Both name their owner now.
 *
 * AND THEN 468, from the env-key lookup in `@veyyon/ai` stopping at a table instead of the provider registry.
 * `./fetch` -> `web/parallel.ts` -> `@veyyon/ai/env-api-key` is a real chain (a fetcher needs to know which
 * variable holds a provider's key), and that leaf reached 158 modules because the credential probes lived on
 * the provider DEFINITIONS. `packages/ai/src/provider-env-keys.ts` owns them now: `env-api-key` 158 -> 65,
 * `web/parallel.ts` 164 -> 72, `tools/fetch.ts` 368 -> 282.
 *
 * AND THEN 449, with the `@veyyon/utils` BARREL off this graph entirely. Twelve modules in the closure
 * imported it whole for one or two names each, and the barrel is 81 modules of small leaves, so the edge only
 * left when the LAST of the twelve named its owners: repointing eleven of them changes nothing measurable and
 * the twelfth removes 19 modules. The closure genuinely uses 94 utils modules through owners, which is what
 * the remaining utils cost is; there is no barrel left to cut here.
 *
 * AND THEN 441, with the SETTINGS STORE off this graph entirely. It arrived by three separate paths --
 * `tools/output-meta.ts` for `getDefault`, `tools/render-utils.ts` for two image-size settings, and
 * `tui/code-cell.ts` -> `modes/theme/markdown-theme.ts` for a test-teardown registration -- and each of the
 * three wanted a value or a `Set.add`, never the 2,768-line store that loads `config.yml` and opens
 * `agent.db`. `config/settings-instance.ts` owns the slot and the proxy at 1 module, `config/settings-schema.ts`
 * already owned `getDefault`, and the three now name the owner they meant. Cutting only the first two moved
 * this number by NOTHING, because the third path was still open; that is the marginal-cost lesson this row
 * has now taught twice.
 *
 * RAISED BY ONE, to 442, for `@veyyon/utils/session-file`. This file asked `sessionFile.endsWith(".jsonl")`
 * and then `slice(0, -6)`, which is the transcript extension written twice, once as a string and once as its
 * length, in the module that has to agree with the session manager about both. The owner is a zero-import
 * leaf, so the cost is exactly one module and cannot grow.
 *
 * RAISED BY ONE AGAIN, to 443, for `session/operator-notices.ts`, and for the same reason the number is
 * allowed to move at all: it is a ZERO-IMPORT LEAF, so the cost is exactly one module and cannot grow.
 * `AgentSession` holds the operator-notice channel, so every graph that reaches the session reaches it. The
 * thing it replaced was worse than an edge: warnings that had to reach a person went to a log file with no
 * console transport, and `skillWarnings` was a getter nobody read. See DONE-SECRET-4 in the backlog.
 *
 * RAISED BY FOUR, to 447, and the interesting half of that is a cut of TWENTY-FOUR. This gate went red at
 * 468 when the outbound confidentiality seam arrived: `tools/fetch.ts` imports `resolveProviderTextTransform`
 * from `provider-boundary.ts`, which is correct (a fetcher sends text to a provider), and that module
 * imported ONE function, `mapJsonStrings`, from `secrets/obfuscator.ts`. The obfuscator reaches 65 modules,
 * 18 of them `@veyyon/ai/utils/schema` -- a JSON Schema validator, on the graph because the obfuscator
 * redacts tool schemas through `toolWireSchema`. So reading a local file loaded a schema validator and the
 * secret registry, and all 24 marginal modules were that one edge.
 *
 * `mapJsonStrings` was never about secrets. It is a bounded JSON walk with three callers wanting three
 * different rewrites (the obfuscator's placeholders, `argot-wire.ts`'s token dictionary, the boundary's
 * session transform), and it now lives in `src/json-transform.ts`, which imports `@veyyon/utils/string-length`
 * and nothing else. `provider-boundary.ts` went from 66 modules to 3. The two string measurements it needed,
 * `utf8ByteLength` and `isWellFormedUtf16`, moved to `string-length.ts` beside `codePointLength`, which also
 * ended a second copy of `isWellFormedUtf16` that `secrets/placeholder.ts` was carrying.
 *
 * So the four are: the three modules the seam legitimately costs now (`provider-boundary.ts`,
 * `json-transform.ts`, `string-length.ts`, the last two zero- and one-import leaves), plus one for
 * `@veyyon/utils/terminal-safe`, which `utils/src/file-lock.ts` reaches to escape the attacker-supplied path
 * it names in an error. That module imports nothing either. See the same entry on INTERNAL_URLS_CEILING.
 *
 * RAISED BY ONE, to 448, for the canonical `INSTRUMENTATION_LEVELS` tuple. The settings schema used
 * to repeat the four values inline; it now imports the closed vocabulary from
 * `@veyyon/ai/instrumentation`, the zero-runtime-import leaf that owns the level policy. The marginal
 * cost is exactly that owner module. Keeping two runtime lists would make an added level valid in
 * recorded telemetry but invalid in config, which is a worse architecture than one measured leaf.
 */
const READ_CEILING = 448;
/**
 * Measured at 205, down from 911 and from 418 before the `gh` split. It is a pure `export *` barrel, so
 * this is `./router` plus one, and the router is every handler at once.
 *
 * 205 IS CLOSE TO THIS PACKAGE'S FLOOR and the reason is worth writing down before someone reads the
 * number as slack. Four of the eight handlers sit between 76 and 120, and each of those numbers is mostly
 * ONE edge: the `@veyyon/utils` barrel, 74 modules, which 643 files in this package import whole. Cutting
 * a handler below 74 means naming utils owners in it, not moving code, and cutting the barrel itself is a
 * different task with its own gate (`packages/utils/test/barrel-stays-cheap.test.ts`).
 */
/**
 * RE-MEASURED 2026-07-26 at 507 with the workspace fully resolved: the router is every handler at once and one
 * of them reaches agent-core.
 *
 * RE-MEASURED at 497. 238 of it is the `@veyyon/ai` barrel arriving through a handler, which for a URL ROUTER
 * is the next thing to cut and is filed.
 *
 * AND THEN 232, for free, because the router reaches `session/session-context.ts` through `history-protocol.ts`
 * and `session-loader.ts`. A URL router carrying the streaming engine was the thing this row called next, and
 * it turned out to be four hops from the same import.
 *
 * AND THEN 205, from the same twelve-file barrel sweep: `vault-protocol.ts` took `$which` from the barrel
 * (81 modules for one), and the history handler's chain into the session loader took several more.
 *
 * AND THEN 190: `vault-protocol.ts` asked whether the vault is enabled and paid 32 marginal modules of
 * settings store for the question. It reads the slot leaf now, and NO internal-URL handler reaches the store.
 *
 * AND THEN 191, one back, for the same zero-import `@veyyon/utils/session-file` leaf: `registry-helpers.ts`
 * scans an artifacts directory for transcripts and had the extension inline twice.
 *
 * AND THEN 192, one FORWARD, for `session/operator-notices.ts`. `AgentSession` holds the operator-notice
 * channel, so anything reaching the session reaches it. The number is up by exactly one because that module
 * imports NOTHING: it is a zero-edge leaf, deliberately, and the cost of the channel is the one module it
 * is. Raised rather than routed around because the alternative was the state it replaced, where a warning
 * that had to reach a person went to a log file with no console transport. See
 * DONE-SECRET-4 in the backlog.
 *
 * AND THEN 194, two FORWARD, for the fault-reporting channel and the session-entry shape check. Both are the
 * same kind of growth as `operator-notices.ts` above and both arrived from a session's own storage path:
 * `session/session-storage.ts` reports a fault through `@veyyon/utils/fault-sink` and asks
 * `@veyyon/utils/fs-optional` about a path, and `session/session-loader.ts` validates an entry through
 * `session/session-entry-shape.ts`. The count is up by exactly two because `fault-sink.ts` and
 * `session-entry-shape.ts` are the only NEW modules on the graph; `fs-optional.ts` was already on it. Raised
 * rather than routed around for the reason the notice channel was: a load failure that has to reach a person
 * cannot be reported by a module that has no way to report.
 *
 * AND THEN 195, one FORWARD, for `@veyyon/utils/terminal-safe`. `utils/src/file-lock.ts` puts the path it
 * failed to lock into the error it throws and into the fields it logs, and a path is an ATTACKER-SUPPLIED
 * STRING: a filename holding `\x1b[2J` clears the operator's screen when that error is printed, and one
 * holding a CSI sequence can repaint the line above it. It escapes them through `escapeTerminalText` now,
 * at eleven sites. `terminal-safe.ts` imports NOTHING, so the cost of that is the one module it is, and
 * `internal-urls` pays it because `utils/src/dirs.ts` reaches the lock. Raised rather than routed around
 * for the same reason as the two entries above: the alternative is not a cheaper graph, it is an error
 * message that can drive the terminal it is printed to.
 *
 * AND THEN 196, one FORWARD, for the same canonical `INSTRUMENTATION_LEVELS` leaf described on
 * `READ_CEILING`. The router reaches the settings schema through its session-loading handlers, so it
 * pays the same single owner module rather than carrying a second instrumentation-level vocabulary.
 */
const INTERNAL_URLS_CEILING = 196;
/**
 * Measured at 252, down from 517. Eighteen web-search providers sit behind this module, and it had a static
 * edge to `session/auth-broker-config.ts` (347 modules: the broker client, the remote store, the snapshot
 * cache and the SQLite credential store under them) for one function that only runs when a search executes.
 *
 * The remaining 252 is what DEFINING a search needs: the arktype schema, the provider table, the renderer
 * and the tool row it takes its description from. Cutting below that means moving code, not moving imports.
 */
const WEB_SEARCH_CEILING = 260;
/**
 * Measured at 84, down from 355. `../tools/gh-fetch` (81) and nothing else of consequence: the handler
 * resolves a URL, calls a fetcher and formats a freshness note.
 */
/**
 * RE-MEASURED 2026-07-26 at 35 with the workspace fully resolved: unchanged by the correction and lower than
 * the ceiling it was left at: the split cut it to 35 and the ceiling stayed at 95.
 *
 * RE-MEASURED at 35, unchanged by the correction: this handler reaches none of the packages the table used to
 * miss. Tightened from 95, which was slack left behind by the split.
 */
const ISSUE_PR_PROTOCOL_CEILING = 42;
/**
 * Measured at 81 and 4. `gh-fetch` is the SQLite cache row plus `gh` itself, both of which a fetcher
 * genuinely needs; 74 of the 81 is the `@veyyon/utils` barrel arriving through `../utils/git` and
 * `./github-cache`. `gh-format` is pure string work over small records and must stay that way, because
 * every GitHub surface imports it.
 */
/**
 * RE-MEASURED 2026-07-26 at 28 with the workspace fully resolved: the utils-barrel edge the old doc named as 74
 * of its 81 is gone, repointed at owners.
 *
 * RE-MEASURED at 28: the `@veyyon/utils` barrel edge the note above counts as 74 of its 81 is gone, repointed
 * at owners.
 */
const GH_FETCH_CEILING = 34;
/**
 * RE-MEASURED 2026-07-26 at 4 with the workspace fully resolved: unchanged, as a module of pure string work
 * should be.
 *
 * RE-MEASURED at 4, unchanged, as a module of pure string work should be.
 */
const GH_FORMAT_CEILING = 8;
/** Measured at 76, 79 and 89, down from 871, 369 and 571. Each is now its own handler and its own data. */
/**
 * RE-MEASURED 2026-07-26 at 4 with the workspace fully resolved: the utils barrel came off it.
 *
 * RE-MEASURED at 4, down from the 76 recorded above: the `@veyyon/utils` barrel came off it.
 */
const MCP_PROTOCOL_CEILING = 10;
/**
 * RE-MEASURED 2026-07-26 at 6 with the workspace fully resolved: the utils barrel came off it.
 *
 * RE-MEASURED at 6, down from 79, the same way.
 */
const SKILL_PROTOCOL_CEILING = 12;
/**
 * RE-MEASURED 2026-07-26 at 97 with the workspace fully resolved: it keeps `@veyyon/utils/dirs`, which a memory
 * path needs.
 *
 * RE-MEASURED at 97. It keeps `@veyyon/utils/dirs`, which resolving a memory path needs.
 */
const MEMORY_PROTOCOL_CEILING = 104;
/** Measured at 182, down from 609. The rest is `config/settings` (it reads `tui.hyperlinks`) and `@veyyon/tui`. */
/**
 * RE-MEASURED 2026-07-26 at 497 with the workspace fully resolved: it reads `tui.hyperlinks` out of settings,
 * and settings is where agent-core arrives.
 *
 * RE-MEASURED at 497, then 192 after the compaction cut, for the same reason as the theme engine: it reads
 * `tui.hyperlinks` out of settings.
 *
 * AND THEN 93, because reading `tui.hyperlinks` no longer means importing the thing that WRITES it. The
 * store is 95 modules and the slot it lives in is 1.
 *
 * 94 from 2026-07-27, and the extra one is `@veyyon/utils/json`. `file-lock.ts` had its own copy of
 * `tryParseJson` written out as a try/catch around `JSON.parse`, which the source lock in
 * `packages/utils/test/json.test.ts` reports; routing it at the owner costs exactly the module that
 * owns it, since `json.ts` imports only `type-guards` and this graph already had that. A second
 * answer to "parse it or give me null" is worse than one module.
 */
const HYPERLINK_CEILING = 94;

/**
 * The slot leaf itself, measured at 1: it holds the process-global `Settings` slot, the proxy over it and the
 * test-reset registry, and imports nothing at runtime. Pinned at 1 rather than at a comfortable bound because
 * the whole value of the split is that reading a setting costs one module, and a single value import here
 * would put 94 back on every one of the twenty-odd consumers at once. `test/config/settings-instance.test.ts`
 * holds the behavioural half, including that the `Settings` type stays a type-only import.
 */
const SETTINGS_INSTANCE_CEILING = 1;

describe("reading a local file does not load the MCP client, the skill loader or the consolidator", () => {
	it(`tools/read reaches at most ${READ_CEILING} modules`, () => {
		expect(reach("tools/read.ts")).toBeLessThanOrEqual(READ_CEILING);
	});

	/**
	 * THE FOUR ABSENCES, stated from `read.ts` because that is where they were paid. Each names a
	 * subsystem a file reader has no business instantiating, and each is one value import away from
	 * coming back: the slot readers are the fragile ones, since `MCPManager.instance()` and
	 * `getActiveSkills()` still exist on the heavy modules and still work.
	 */
	it("reaches none of the four subsystems the chain used to drag in", () => {
		const reached = reachedNames("tools/read.ts");

		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "mcp/manager.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "extensibility/skills.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "memories/index.ts")));
	});

	/**
	 * THE PROMPT-REGISTRY EDGE, which was the largest single one this file had: 167 modules for one string.
	 * A tool renders its own description from a row, and the aggregate registry holds the `.md` import for
	 * all 163 prompts, so importing it to read one of them cost the corpus. `read.ts` takes its directory's
	 * row module instead.
	 *
	 * Asserted as REACHABILITY rather than as source text, because the aggregate is still reachable from
	 * plenty of places and a text search for `prompts/registry` would match this file's own comments. Both
	 * directions are here: the row module must be reached (or the tool is not getting its description from
	 * where this claims) and the aggregate must not (or the cut is decoration).
	 */
	it("takes its description from its directory's row module and not from the whole registry", () => {
		const reached = reachedNames("tools/read.ts");

		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "prompts/tools/rows.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "prompts/registry.ts")));
		// And it reaches its own prompt's text, so the row module is genuinely the one that holds it.
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "prompts/tools/read.md")));
		// While no other directory's rows arrive with it. `session/` is the largest of the twenty others.
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "prompts/session/rows.ts")));
	});

	/**
	 * NON-VACUITY. `read.ts` genuinely resolves internal URLs of every scheme, so it DOES reach the
	 * router and the handlers; what it no longer reaches is what each handler used to drag behind it.
	 * A walk that resolved nothing would satisfy the absences above and fail this.
	 */
	it("still reaches the router and its handlers, which is what makes the absences meaningful", () => {
		const reached = reachedNames("tools/read.ts");

		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "internal-urls/router.ts")));
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "internal-urls/mcp-protocol.ts")));
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "internal-urls/skill-protocol.ts")));
		expect(reach("tools/read.ts")).toBeGreaterThan(300);
	});

	/**
	 * THE BARREL IS OFF THIS GRAPH, which is the claim a ceiling cannot make. Twelve modules in this closure
	 * imported `@veyyon/utils` whole for one or two names, and the barrel is 81 small leaves: the edge only
	 * leaves when the last path does, so eleven repoints measure as nothing and the twelfth is worth 19
	 * modules. Asserted as reachability, on the module that is imported by 54 test files.
	 */
	it("reaches no module through the @veyyon/utils barrel", () => {
		const reached = reachedNames("tools/read.ts");

		expect(reached).not.toContain(path.join("utils", "src", "index.ts"));
		// The control: it still uses utils, through owners. `type-guards` holds `errorMessage`, which almost
		// everything in this closure needs, so an absence here would mean the walk stopped resolving.
		expect(reached).toContain(path.join("utils", "src", "type-guards.ts"));
	});

	/**
	 * THE SETTINGS STORE, stated as an absence from the three files that paid for it by three different
	 * paths. A ceiling cannot make this claim: the store is 95 modules and most of them are shared with
	 * things these files legitimately reach, so a number could stay flat while the edge came back.
	 *
	 * Each path wanted something small. `output-meta.ts` wanted `getDefault`, which `config/settings-schema.ts`
	 * owns and the store only re-exports. `render-utils.ts` wanted two image-size settings. `markdown-theme.ts`
	 * wanted to REGISTER a test-teardown hook, a `Set.add`. None of them fills the slot, and filling it is the
	 * only thing the store is for.
	 */
	it("reaches the settings slot but not the store that fills it", () => {
		const store = path.relative(PACKAGES, path.join(SRC, "config/settings.ts"));
		const slot = path.relative(PACKAGES, path.join(SRC, "config/settings-instance.ts"));

		for (const file of ["tools/read.ts", "tools/fetch.ts", "web/search/index.ts"]) {
			expect(reachedNames(file), `${file} should not reach the settings store`).not.toContain(store);
		}
		// The control: they still read settings, through the slot. An absence of both would mean the walk
		// stopped resolving rather than that the edge was cut.
		expect(reachedNames("tools/read.ts")).toContain(slot);
	});

	it(`the settings slot reaches exactly ${SETTINGS_INSTANCE_CEILING} module, itself`, () => {
		expect(reach("config/settings-instance.ts")).toBe(SETTINGS_INSTANCE_CEILING);
	});

	it(`internal-urls reaches at most ${INTERNAL_URLS_CEILING} modules`, () => {
		expect(reach("internal-urls/index.ts")).toBeLessThanOrEqual(INTERNAL_URLS_CEILING);
	});

	it(`the issue/pr handler reaches at most ${ISSUE_PR_PROTOCOL_CEILING} modules`, () => {
		expect(reach("internal-urls/issue-pr-protocol.ts")).toBeLessThanOrEqual(ISSUE_PR_PROTOCOL_CEILING);
	});

	it(`the gh fetchers reach at most ${GH_FETCH_CEILING}, and their shared primitives ${GH_FORMAT_CEILING}`, () => {
		expect(reach("tools/gh-fetch.ts")).toBeLessThanOrEqual(GH_FETCH_CEILING);
		expect(reach("tools/gh-format.ts")).toBeLessThanOrEqual(GH_FORMAT_CEILING);
	});

	/**
	 * The edge that made the split worth doing, asserted by NAME rather than by count. `tools/gh.ts` is
	 * the `github` tool and it is allowed to be expensive: it renders its own description from the prompt
	 * registry, which is correct for a tool. What must not come back is a protocol handler naming it, so
	 * the assertion is about the handler's reach set, not about the tool's size.
	 */
	it("the issue/pr handler does not reach the github tool or the prompt corpus", () => {
		const reached = reachedNames("internal-urls/issue-pr-protocol.ts");

		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "tools/gh.ts")));
		expect(reached).not.toContain(path.relative(PACKAGES, path.join(SRC, "prompts/registry.ts")));
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "tools/gh-fetch.ts")));
		expect(reached).toContain(path.relative(PACKAGES, path.join(SRC, "tools/github-cache.ts")));
	});

	/**
	 * And the tool still re-exports every fetcher, which is the promise that made the move invisible to
	 * callers. `tools/gh-renderer.ts` and a long tail of tests name `./gh` for these, and the re-export is
	 * the only reason none of them changed. Asserted through the module's exports rather than by reading
	 * the source, so a re-export that compiles but resolves to nothing would fail here.
	 */
	it("the github tool still re-exports the fetchers it used to own", async () => {
		const tool = (await import("@veyyon/coding-agent/tools/gh")) as Record<string, unknown>;

		for (const name of [
			"getOrFetchIssue",
			"getOrFetchPr",
			"getOrFetchPrDiff",
			"githubIssueJsonWithStateReasonFallback",
			"parsePrUnifiedDiff",
			"resolveDefaultRepoMemoized",
			"parsePositiveDecimalInt",
		]) {
			expect(typeof tool[name], `tools/gh must still re-export ${name}`).toBe("function");
		}
	});

	it(`the mcp handler reaches at most ${MCP_PROTOCOL_CEILING} modules`, () => {
		expect(reach("internal-urls/mcp-protocol.ts")).toBeLessThanOrEqual(MCP_PROTOCOL_CEILING);
	});

	it(`the skill handler reaches at most ${SKILL_PROTOCOL_CEILING} modules`, () => {
		expect(reach("internal-urls/skill-protocol.ts")).toBeLessThanOrEqual(SKILL_PROTOCOL_CEILING);
	});

	it(`the memory handler reaches at most ${MEMORY_PROTOCOL_CEILING} modules`, () => {
		expect(reach("internal-urls/memory-protocol.ts")).toBeLessThanOrEqual(MEMORY_PROTOCOL_CEILING);
	});

	/**
	 * The handler-to-subsystem edges by name, so a failure says which import to change. The MCP one is
	 * the subtle case and the reason it is asserted as a runtime SPECIFIER rather than only as
	 * reachability: `import type { MCPManager }` and `import { MCPManager }` differ by one word, compile
	 * identically, run identically, and cost 626 modules.
	 */
	it("each handler reads its slot, not the module that fills it", () => {
		const mcp = runtimeImportsOf(path.join(SRC, "internal-urls/mcp-protocol.ts"));
		expect(mcp).toContain("../mcp/manager-instance");
		expect(mcp).not.toContain("../mcp/manager");

		const skill = runtimeImportsOf(path.join(SRC, "internal-urls/skill-protocol.ts"));
		expect(skill).toContain("../extensibility/active-skills");
		expect(skill).not.toContain("../extensibility/skills");

		const memory = runtimeImportsOf(path.join(SRC, "internal-urls/memory-protocol.ts"));
		expect(memory).toContain("../memories/paths");
		expect(memory).not.toContain("../memories");
	});

	/**
	 * The four leaves, each asserted to import NOTHING at runtime. That is what makes them leaves and it
	 * is the whole reason they exist: a slot that imports the thing it holds is not a slot, it is the
	 * thing. `memories/paths` is the exception at one import, `@veyyon/utils` for `getMemoriesDir`, and
	 * its number says so.
	 */
	it("the four leaves import nothing at runtime", () => {
		expect(runtimeImportsOf(path.join(SRC, "mcp/manager-instance.ts"))).toEqual([]);
		expect(runtimeImportsOf(path.join(SRC, "extensibility/active-skills.ts"))).toEqual([]);
		expect(runtimeImportsOf(path.join(SRC, "tools/tool-ui-status.ts"))).toEqual([]);
		// `node:path` and one utils name for the directory it joins under. Node builtins are not part of
		// the graph this file measures, and they are listed here so the assertion stays exact.
		// `@veyyon/utils/dirs` (15) rather than the barrel (74), for `getMemoriesDir`. Safe to name directly
		// since `dirs.ts` applies `$HOME/.env` itself; see `packages/utils/test/dotenv-*.test.ts`. 75 -> 18.
		expect(runtimeImportsOf(path.join(SRC, "memories/paths.ts"))).toEqual(["node:path", "@veyyon/utils/dirs"]);

		expect(reach("mcp/manager-instance.ts")).toBe(1);
		expect(reach("extensibility/active-skills.ts")).toBe(1);
		expect(reach("tools/tool-ui-status.ts")).toBe(1);
	});

	/** And the heavy modules still re-export what moved, which is why no caller had to change. */
	it("the heavy modules still forward the names that moved out of them", () => {
		const files = [
			["mcp/manager.ts", "manager-instance"],
			["extensibility/skills.ts", "./active-skills"],
			["memories/index.ts", "./paths"],
			["tools/render-utils.ts", "./tool-ui-status"],
		] as const;

		for (const [file, owner] of files) {
			expect(fs.readFileSync(path.join(SRC, file), "utf-8"), `${file} should name ${owner}`).toContain(owner);
		}
	});

	/**
	 * The status line is the extreme case of the same rule and worth its own exact number: TWO modules,
	 * itself and the status union it renders. It was 168, and `tui/index.ts` re-exports it into
	 * `tools/fetch.ts`, which `read.ts` imports, so those 166 were paid four hops away.
	 */
	it("the status line is two modules", () => {
		expect(reach("tui/status-line.ts")).toBe(2);
	});

	it(`the hyperlink formatter reaches at most ${HYPERLINK_CEILING} modules`, () => {
		expect(reach("tui/hyperlink.ts")).toBeLessThanOrEqual(HYPERLINK_CEILING);
	});

	/**
	 * A hyperlink formatter reaching the module that asks a model to summarise your memory is the single
	 * most surprising edge of the whole chain, and it is asserted separately because it is a plausible
	 * accident: `resolveMemoryUrlToPath` and `getMemoryRoot` sit next to each other conceptually and in
	 * two different modules by design.
	 */
	it("the hyperlink formatter does not reach the memory consolidator", () => {
		expect(reachedNames("tui/hyperlink.ts")).not.toContain(
			path.relative(PACKAGES, path.join(SRC, "memories/index.ts")),
		);
	});
});

/**
 * The cheap things that were living in expensive modules, as a RULE rather than as four more ceilings.
 *
 * Each row is (name, the leaf that owns it, the module it used to live in and still re-exports it from,
 * that module's reach). Two shapes, one rule:
 *
 *  - A PROCESS-GLOBAL SLOT. `mcpManagerInstance` was a `static #instance` on `MCPManager`, read through
 *    `MCPManager.instance()`, so reading the slot meant importing the MCP client, its transports and every
 *    server schema. `getActiveSkills` was a module-scope array in the skills subsystem.
 *  - A CHEAP PURE FUNCTION. `getMemoryRoot` is a two-line path join that sat in the module which asks a
 *    model to summarise your memory. `formatStatusIcon` is a switch over eight cases that sat in the
 *    render helpers.
 *
 * The rule both obey: the value is owned by a module that imports (nearly) nothing, the former home
 * re-exports it so no caller broke, and a file that wants ONLY that value names the leaf.
 *
 * WHY "ONLY THAT VALUE" AND NOT "EVERY READER, EVERYWHERE". The tempting stricter rule is that nobody may
 * ever take the name from the former home. It is wrong, and not because of effort: twelve renderers import
 * `formatStatusIcon` in the same statement as `replaceTabs` and `renderBox`, so they depend on
 * `render-utils` for reasons the icon has nothing to do with. Forcing a second import statement there
 * splits one honest edge into two and removes nothing from the graph. The defect this file is about is a
 * file paying for a subsystem it otherwise does not touch, so that is exactly what is asserted: if the
 * accessor is the ONLY name you take from the heavy module, you are paying for it alone, and you must name
 * the leaf. That is a rule about edges, not a hand-maintained list of forgiven filenames.
 *
 * `MCPManager` and `Skill` as TYPES stay out of scope, as everywhere else in this file: `import type` is
 * erased.
 */
const LEAF_OWNERS: ReadonlyArray<
	readonly [accessor: string, owner: string, formerHome: string, formerHomeReach: number]
> = [
	["mcpManagerInstance", "mcp/manager-instance.ts", "mcp/manager.ts", 702],
	["getActiveSkills", "extensibility/active-skills.ts", "extensibility/skills.ts", 366],
	["getMemoryRoot", "memories/paths.ts", "memories/index.ts", 559],
	["formatStatusIcon", "tools/tool-ui-status.ts", "tools/render-utils.ts", 168],
	// A THIRD SHAPE: a presentation LIST that sat with the thing it presents. The browse order is eight
	// strings, and `builtin-registry.ts` declares every builtin command, so it imports every command
	// implementation. `modes/prompt-action-autocomplete.ts` wanted the order and nothing else and paid 1,149
	// marginal modules for it: 1,386 -> 238.
	[
		"BUILTIN_SLASH_COMMAND_CATEGORY_ORDER",
		"slash-commands/category-order.ts",
		"slash-commands/builtin-registry.ts",
		1381,
	],
];

/** Every runtime (non-`type`) named binding a file takes from a module whose path ends with `suffix`. */
function runtimeNamesTakenFrom(source: string, suffix: string): string[] {
	const names: string[] = [];
	const statements = /import\s+(?!type\b)\{([^}]*)\}\s*from\s*"([^"]+)"/g;
	for (const match of source.matchAll(statements)) {
		if (!match[2].endsWith(suffix)) continue;
		for (const raw of match[1].split(",")) {
			const binding = raw.trim();
			if (binding.length === 0 || binding.startsWith("type ")) continue;
			names.push((binding.split(/\s+as\s+/)[0] ?? binding).trim());
		}
	}
	return names;
}

describe("a cheap value is owned by a leaf, and a file that wants only it names the leaf", () => {
	const sources = sourceFiles(SRC).map(file => [path.relative(SRC, file), fs.readFileSync(file, "utf-8")] as const);

	/**
	 * NON-VACUITY, in the two ways this block can quietly stop guarding.
	 *
	 * First the scan: `sourceFiles` really walked the package, so "no file does X" is not the answer an
	 * empty list gives for free. Second the rows: every accessor is imported from its LEAF by at least one
	 * file. A row whose leaf nobody imports would mean the extraction was pointless, and it would also mean
	 * the rule below has never once been exercised.
	 */
	it("reads the package, and every leaf is really imported", () => {
		expect(sources.length).toBeGreaterThan(400);

		for (const [accessor, owner] of LEAF_OWNERS) {
			const leafSuffix = (owner.replace(/\.ts$/, "").split("/").pop() ?? owner) as string;
			const importers = sources
				.filter(([relative]) => relative !== owner)
				.filter(([, source]) => runtimeNamesTakenFrom(source, leafSuffix).includes(accessor))
				.map(([relative]) => relative);

			expect(
				importers.length,
				`nothing imports ${accessor} from ${owner}, so the extraction bought nothing`,
			).toBeGreaterThan(0);
		}
	});

	/** And the leaves stay leaves. An owner that grows an import is an owner that stopped being cheap. */
	it("every owner still imports nearly nothing", () => {
		expect(runtimeImportsOf(path.join(SRC, "slash-commands/category-order.ts"))).toEqual([]);
		expect(runtimeImportsOf(path.join(SRC, "config/settings-instance.ts"))).toEqual([]);
		expect(runtimeImportsOf(path.join(SRC, "mcp/manager-instance.ts"))).toEqual([]);
		expect(runtimeImportsOf(path.join(SRC, "extensibility/active-skills.ts"))).toEqual([]);
		expect(runtimeImportsOf(path.join(SRC, "tools/tool-ui-status.ts"))).toEqual([]);
		// `@veyyon/utils/dirs` (15) rather than the barrel (74), for `getMemoriesDir`. Safe to name directly
		// since `dirs.ts` applies `$HOME/.env` itself; see `packages/utils/test/dotenv-*.test.ts`. 75 -> 18.
		expect(runtimeImportsOf(path.join(SRC, "memories/paths.ts"))).toEqual(["node:path", "@veyyon/utils/dirs"]);
	});

	it.each(LEAF_OWNERS)(
		"nobody imports %s alone from %s (%s, %i modules)",
		(accessor, owner, formerHome, formerHomeReach) => {
			const heavySuffix = formerHome.replace(/\.ts$/, "");
			// The leaf and its former home are both allowed to name it: that pair IS the re-export.
			const offenders = sources
				.filter(([relative]) => relative !== owner && relative !== formerHome)
				.filter(([, source]) => {
					const taken = runtimeNamesTakenFrom(source, heavySuffix);
					return taken.length === 1 && taken[0] === accessor;
				})
				.map(([relative]) => relative);

			expect(
				offenders,
				`${accessor} is the only thing these files want from ${formerHome} (${formerHomeReach} modules). Take it from ${owner}, which imports nearly nothing.`,
			).toEqual([]);
		},
	);

	/**
	 * The static accessor that used to be the only way to read the MCP slot is gone from every call site.
	 * `MCPManager.instance()` still exists and still delegates to the slot, so this is not about deleting
	 * API: it is about nobody importing a 702-module class in order to ask whether a manager was installed.
	 */
	/**
	 * THE TASK BARREL, named as an edge rather than as a count. `modes/session-observer-registry.ts`
	 * subscribes to two event channels BY NAME, and it took those two strings from `../task`, the barrel over
	 * the whole task subsystem: 1,407 modules to know what a channel is called. `task/types.ts` declares them
	 * and reaches 23, so the fix was one specifier and the file went to 24.
	 *
	 * Asserted as the SPECIFIER rather than as reachability, because `../task` and `../task/types` differ by
	 * one path segment, compile identically, and differ by 1,383 modules.
	 */
	it("subscribes to task channels through the module that declares them", () => {
		const imports = runtimeImportsOf(path.join(SRC, "modes/session-observer-registry.ts"));

		expect(imports).not.toContain("../task");
		expect(imports).toContain("../task/types");
		expect(reach("modes/session-observer-registry.ts")).toBeLessThanOrEqual(30);
	});

	it("nobody calls MCPManager.instance() to read the slot", () => {
		const offenders = sources
			.filter(([relative]) => relative !== "mcp/manager.ts")
			.filter(([, source]) => withoutComments(source).includes("MCPManager.instance()"))
			.map(([relative]) => relative);

		expect(
			offenders,
			"read the slot with `mcpManagerInstance()` from `mcp/manager-instance`; importing the class for it costs 702 modules",
		).toEqual([]);
	});
});

/**
 * DEFINING A WEB SEARCH DOES NOT OPEN THE CREDENTIAL STORE.
 *
 * `web/search/index.ts` is the module eighteen providers sit behind, and every consumer that so much as
 * lists the tool parses it. It needs credentials to RUN a search and it needs none to DECLARE one, but it
 * named `session/auth-broker-config` statically, so the broker client, the remote store, the snapshot cache
 * and the SQLite credential store under them arrived the moment the file was parsed.
 *
 * The load is deferred now, to a local helper that dynamic-imports the module inside three already-`async`
 * call sites. The same technique took the tool registry off the boot graph (`tools/index.ts`), and it is not
 * a fallback: a load failure rejects and the search reports it, exactly as an unresolvable static import
 * would.
 *
 * WHY BOTH HALVES ARE ASSERTED. A count alone cannot tell deferral from deletion, and a specifier alone
 * cannot tell a deferred edge from a static one, since `import(x)` and `import ... from x` name the same
 * path. So: the STATIC edge is gone, the DYNAMIC one is present, and the call sites still exist.
 */
describe("declaring the web-search tool does not load the credential store", () => {
	const source = fs.readFileSync(path.join(SRC, "web/search/index.ts"), "utf-8");

	it(`web/search reaches at most ${WEB_SEARCH_CEILING} modules`, () => {
		expect(reach("web/search/index.ts")).toBeLessThanOrEqual(WEB_SEARCH_CEILING);
	});

	/**
	 * The four modules by name, because the count is the symptom and these are the cause. Each is a piece of
	 * credential machinery, and a single static `import { discoverAuthStorage }` brings back all four.
	 */
	it("reaches no part of the auth broker or the credential store", () => {
		const reached = reachedNames("web/search/index.ts");

		expect(reached).not.toContain(path.join("coding-agent", "src", "session", "auth-broker-config.ts"));
		expect(reached).not.toContain(path.join("ai", "src", "auth-broker", "client.ts"));
		expect(reached).not.toContain(path.join("ai", "src", "auth-broker", "remote-store.ts"));
		expect(reached).not.toContain(path.join("ai", "src", "auth-broker", "snapshot-cache.ts"));
		expect(reached).not.toContain(path.join("ai", "src", "auth-storage.ts"));
	});

	/**
	 * NON-VACUITY for the assertion above: the walk really resolved this file, so "reaches none of those" is
	 * an answer about the graph rather than what an empty set gives for free. The provider table is what a
	 * declared search tool genuinely carries, and it must be there.
	 */
	it("still reaches what defining a search actually needs", () => {
		const reached = reachedNames("web/search/index.ts");

		expect(reached).toContain(path.join("coding-agent", "src", "web", "search", "provider.ts"));
		expect(reached).toContain(path.join("coding-agent", "src", "web", "search", "render.ts"));
		expect(reached.length).toBeGreaterThan(100);
	});

	/** The static edge is gone. This is the assertion that fails if someone re-adds the plain import. */
	it("names the broker config in no static import", () => {
		expect(runtimeImportsOf(path.join(SRC, "web/search/index.ts"))).not.toContain("../../session/auth-broker-config");
	});

	/**
	 * And the capability is still there, which a reach count cannot distinguish from its removal. The
	 * dynamic import must name the same module, and the three call sites that await the helper must remain:
	 * a search that stopped resolving credentials would pass every count assertion in this block.
	 */
	it("loads the broker config dynamically, and still asks it for credentials", () => {
		expect(source).toContain('await import("../../session/auth-broker-config")');

		const callSites = withoutComments(source).match(/await discoverAuthStorage\(\)/g) ?? [];
		expect(callSites.length).toBe(3);
	});
});
