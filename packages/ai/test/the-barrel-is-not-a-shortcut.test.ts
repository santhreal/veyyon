/**
 * ONE-PLACE lock: a file that wants one function from `@veyyon/ai` names the module that declares it.
 *
 * WHY THIS IS NOT A STYLE RULE. `@veyyon/ai`'s entry point re-exports the package: the streaming engine, every
 * provider, the model catalogue, the error taxonomy, the usage backends. It reaches 363 modules. Importing a
 * NAME from it costs all of them, and importing a TYPE from it costs nothing at all, because type imports are
 * erased. Those two lines look identical, differ by one keyword, and differ by 363 modules.
 *
 * That is what made this accumulate silently. Every one of the files repointed below was written by someone
 * who wanted a single predicate or a retry wrapper, took it from the obvious place, and paid for the engine:
 *
 *   - `agent/src/proxy.ts` wanted `EventStream`, a 42-module class. 364 modules -> 118.
 *   - `stats/src/parser.ts` wanted three service-tier helpers declared in `types.ts`, which reaches 5. It is a
 *     SESSION FILE PARSER; it has no use for a provider. 366 -> 103, and `db.ts` and `sync-worker.ts` behind
 *     it went from 367 and 366 to 105 and 104.
 *   - `mnemopi/src/core/embeddings.ts` wanted a retry wrapper and a header builder. 369 -> 110.
 *   - `mnemopi/src/core/extraction/client.ts` wanted the same retry wrapper. 367 -> 105.
 *   - `coding-agent/src/config/api-key-resolver.ts` wanted `isUsageLimitOutcome`, a predicate over a status
 *     code in a module with NO imports. 364 -> 42.
 *   - `coding-agent/src/mcp/manager.ts` wanted a string test. 613 -> 498.
 *   - `coding-agent/src/commit/shared-llm.ts` wanted arktype's `type`, which this package only re-exports, and
 *     one validator. 368 -> 112, and then back to 325 when `fix(secrets): protect commit analysis requests`
 *     moved the actual model call into this file and took `completeSimple` from the barrel along with it.
 *     Repointed at its owner on 2026-07-27: 325 -> 184. The remaining 72 over the old ceiling ARE the
 *     streaming engine, which this file now genuinely calls, so its ceiling is re-measured below rather
 *     than left red. That is the distinction this whole suite is about: an engine a file uses is a cost,
 *     an engine a file merely imported a predicate through is a leak.
 *   - `coding-agent/src/tools/web/search/providers/perplexity.ts` wanted an OAuth retry wrapper. 372 -> 327.
 *
 * WHAT IS STILL ALLOWED, and it is most of the remaining list. `completeSimple` and `streamSimple` ARE the
 * engine, so a module that calls one of them reaches it whichever specifier it uses. The rule below is about
 * names whose owner is cheap, so it names the exemptions explicitly rather than trying to infer them.
 *
 * WHY A RATCHET. Nothing fails when a barrel import comes back. The code works, the tests pass, and the only
 * thing that moves is a number nobody looks at, so the number is what is pinned.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReachCount,
	moduleSpecifiersIn,
	typeOnlyModuleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";
import { MEMBERS, memberFileOf, memberRelative, REPO_ROOT } from "../../utils/test/support/package-sources";

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(memberFileOf(relative), RESOLUTION, CACHE);
}

/** Every `.ts` under a member's `src`, which is the set a "nowhere in this repo" claim has to cover. */
function sourceFiles(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === "dist") continue;
			sourceFiles(full, found);
		} else if (entry.name.endsWith(".ts")) {
			found.push(full);
		}
	}
	return found;
}

const SOURCES: Array<readonly [string, string]> = MEMBERS.map(member => path.join(REPO_ROOT, member, "src"))
	.filter(dir => fs.existsSync(dir))
	.flatMap(dir => sourceFiles(dir))
	.map(file => [memberRelative(file), fs.readFileSync(file, "utf-8")] as const);

/**
 * The runtime names a file takes from the `@veyyon/ai` entry point.
 *
 * Braced form only, and `type X` members dropped, because those are the two things the rule turns on: a
 * type is free and a value is not, and the clause is where the difference is written.
 */
function barrelRuntimeNames(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@veyyon\/ai["']/g)) {
		for (const raw of (match[1] ?? "").split(",")) {
			const name = raw.trim();
			if (name && !name.startsWith("type ")) names.push(name);
		}
	}
	return names;
}

/**
 * Single names whose owner is the ENGINE, so the barrel costs nothing extra.
 *
 * `completeSimple` and `streamSimple` are declared in `stream.ts`, which reaches 299 modules on its own; a
 * module that calls one of them has already bought the engine and repointing it would move nothing. Listed
 * rather than inferred, so that adding a cheap name to this set is a decision somebody had to write down.
 */
const ENGINE_NAMES: ReadonlySet<string> = new Set(["completeSimple", "streamSimple"]);

describe("nobody takes one cheap name from the whole package", () => {
	/**
	 * NON-VACUITY, first. Every case here is "no file does X", which an empty scan answers for free, and this
	 * scan walks the whole monorepo. The named file is one that really does import from the barrel.
	 */
	it("reads every package's sources", () => {
		expect(SOURCES.length).toBeGreaterThan(500);
		expect(SOURCES.some(([relative]) => relative === "agent/src/agent.ts")).toBe(true);
		expect(SOURCES.some(([, source]) => barrelRuntimeNames(source).length > 0)).toBe(true);
	});

	/**
	 * THE RULE. A file taking exactly one runtime name from the barrel is paying 363 modules for it, unless
	 * that name is the engine, in which case it was paying anyway.
	 *
	 * A file taking several names is left alone deliberately: splitting the import into three owner
	 * specifiers removes no edge if any one of them is expensive, and the rule for that case is already
	 * recorded in `coding-agent/test/architecture/leveraged-imports-stay-cut.test.ts`.
	 */
	it("no file takes a single non-engine runtime name from the barrel", () => {
		const offenders = SOURCES.filter(([, source]) => {
			const names = barrelRuntimeNames(source);
			return names.length === 1 && !ENGINE_NAMES.has(names[0] as string);
		}).map(([relative]) => relative);

		expect(offenders, "import it from the module that declares it; @veyyon/ai reaches 363 modules").toEqual([]);
	});

	/**
	 * NON-VACUITY for the rule above, and the reason it needs its own case: the detector is a regex over an
	 * import clause, and a formatting change is exactly what defeats that class of pattern. If it stopped
	 * matching, the rule would pass on a repository full of violations.
	 *
	 * Proven in two halves, because one filename cannot carry both. Inline clauses pin the spellings the
	 * regex has to survive, and they cannot go stale: repointing a file at its owner is the outcome this
	 * suite exists to produce, so a control anchored to a named file expires the moment the suite works.
	 * That is what happened to the previous anchor, `coding-agent/src/tools/fs/inspect-image.ts`, which now
	 * takes its names as `import type` and is no longer a runtime importer at all.
	 *
	 * The repository half then proves the regex still matches THIS tree, and the engine names are the proof
	 * because they are the ones the rule deliberately allows: they must be FOUND and then excused, not
	 * missed. Both halves derive their subject at run time, so the next repointing shrinks the set without
	 * turning the control vacuous.
	 */
	it("the detector really finds single-name barrel imports", () => {
		expect(barrelRuntimeNames('import { completeSimple } from "@veyyon/ai";')).toEqual(["completeSimple"]);
		expect(barrelRuntimeNames('import {\n\tcompleteSimple,\n} from "@veyyon/ai";')).toEqual(["completeSimple"]);
		expect(barrelRuntimeNames("import { streamSimple } from '@veyyon/ai';")).toEqual(["streamSimple"]);
		expect(barrelRuntimeNames('import { type Model, isUsageLimitOutcome } from "@veyyon/ai";')).toEqual([
			"isUsageLimitOutcome",
		]);
		expect(barrelRuntimeNames('import type { Model } from "@veyyon/ai";')).toEqual([]);
		expect(barrelRuntimeNames('import { completeSimple } from "@veyyon/ai/stream";')).toEqual([]);

		const singles = SOURCES.map(([relative, source]) => [relative, barrelRuntimeNames(source)] as const).filter(
			([, names]) => names.length === 1,
		);

		expect(singles.length).toBeGreaterThan(0);
		expect(
			singles.filter(([, names]) => !ENGINE_NAMES.has(names[0] as string)).map(([relative]) => relative),
			"a single non-engine name must be reported by the rule above, not swallowed here",
		).toEqual([]);
	});
});

describe("the modules that were repointed stay cut", () => {
	/**
	 * Ceilings, one per file, each a little above its measurement so an unrelated dependency does not fail
	 * the gate while a returned barrel import does. The numbers are the point: without them the rule above is
	 * satisfied by a file that takes TWO names from the barrel, which costs exactly the same.
	 *
	 * FOUR OF THEM ROSE BY SIX ON 2026-08-22, and the six are named rather than assumed. The error
	 * subsystem's classification moved out of one file into `error/flag.ts`, `error/registry.ts` and
	 * `error/domains/{network,account,request,turn}.ts`, and everything that classifies a failure reaches
	 * all six through `error/flags`. `.internal/reach-delta.ts` prints the reached names: the delta is
	 * exactly those six, every one a leaf inside `ai/src/error/` whose own imports (`../classes`,
	 * `../flag`, `../aws`, `../rate-limit`, `@veyyon/utils/fetch-retry`) were already reached before the
	 * split. No consumer gained an edge to anything outside the subsystem, which is the only reason these
	 * numbers may move: a raise that cannot name its new edges is a leak with a bigger ceiling.
	 */
	/**
	 * `agent/src/proxy.ts` was re-measured at 145 on 2026-08-23. Thirteen modules in this closure did not
	 * exist when it was last measured, and every one is a leaf that was carved out of a file already here:
	 * `error/{registry,flag,error-body,response}.ts` and `error/domains/{network,account,request,turn}.ts`
	 * from the error subsystem, `catalog/compat/markup-leaks.ts` and
	 * `catalog/provider-models/wire-capabilities.ts` from the compat and provider tables, and
	 * `utils/{stream-frame-limit,eval-prompt-overrides}.ts`. No consumer gained an edge to a subsystem it
	 * did not already reach, which is the only reason this number may move.
	 */
	/**
	 * Re-measured 2026-09-04 when the model and message vocabulary moved to `@veyyon/model`: `parser.ts`
	 * 115 -> 119, `db.ts` 120 -> 121, `shared-llm.ts` 202 -> 205, `sync-worker.ts` unchanged at 120. Every
	 * new module is a leaf of `contracts/model/src/` -- `effort.ts`, `model.ts`, `message.ts`,
	 * `service-tier.ts`, `stream-block.ts` -- carved out of `catalog/types.ts`, `catalog/effort.ts`,
	 * `ai/types.ts` and `ai/utils/block-symbols.ts`, each of which was already on the reach and now
	 * re-exports the contract module. A contract imports nothing in this repository, so no consumer
	 * gained an edge to a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-09-11: `parser.ts` 119 -> 120, `db.ts` 121 -> 122, `sync-worker.ts` 120 -> 121,
	 * each by the one module `@veyyon/utils/tab-width`, a zero-import leaf holding `DEFAULT_TAB_WIDTH`
	 * and `replaceTabs`, split out of `tab-spacing.ts` (already on every one of these reaches through
	 * the `@veyyon/utils` entry point) so the browser bundles can share the width without the
	 * `.editorconfig` reader. `shared-llm.ts` 205 -> 207 by two leaves under files already reached:
	 * `ai/providers/initial-message.ts` (the empty Responses assistant message, imported by
	 * `providers/gitlab-duo-workflow.ts` instead of restated; imports only `@veyyon/catalog/models`)
	 * and `catalog/discovery/failure.ts` (the discovery-failure vocabulary and its `readDiscoveryJson`
	 * reader, taken by `provider-models/ollama.ts`; imports only `@veyyon/utils/type-guards`). No
	 * consumer gained an edge to a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-09-15: `shared-llm.ts` 207 -> 208 by one module,
	 * `catalog/provider-models/command-code.ts`. It holds Command Code's
	 * deployment contract — the prices, effort ladders and output ceilings the
	 * Provider API does not publish — split out of `openai-compat.ts`, which is
	 * already on this reach, and its own imports (`discovery/openai-compatible`,
	 * `model-manager`, `provider-models/bundled-references`, `effort`, `utils`)
	 * were already reached through that file. No consumer gained an edge to a
	 * subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-09-18: `api-key-resolver.ts` 56 -> 57 and `shared-llm.ts` 208 -> 209, each by the
	 * one module `@veyyon/utils/backoff`, a zero-import leaf holding `exponentialBackoffDelay`.
	 * `@veyyon/utils/fetch-retry` and the SQLite credential store, already on both reaches, computed
	 * their retry doubling inline and now take it from that owner. The leaf imports nothing, so no
	 * consumer gained an edge to a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-09-29: `parser.ts` 120 -> 121, `db.ts` 122 -> 123, `sync-worker.ts` 121 -> 122,
	 * `api-key-resolver.ts` 57 -> 58 and `shared-llm.ts` 209 -> 210, each by the one module
	 * `@veyyon/utils/log-file`, the rotating profile log that replaced `winston` and
	 * `winston-daily-rotate-file`. `@veyyon/utils/logger`, already on every one of these reaches, writes
	 * through it; its imports are `node:` built-ins, `./app-identity` and `./fs-error`, all already
	 * reached. The two npm packages it replaced were never counted here, so no consumer gained an edge to
	 * a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-09-29 again: `parser.ts` 121 -> 122, `db.ts` 123 -> 124, `sync-worker.ts`
	 * 122 -> 123 and `shared-llm.ts` 210 -> 211, each by the one module `catalog/compat/share.ts`, a
	 * zero-import leaf holding `shareCompat`. `catalog/build.ts`, already on every one of these reaches,
	 * returns each model's resolved compat record through it so equal records are held once. The leaf
	 * imports nothing, so no consumer gained an edge to a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-09-30: `agent/src/proxy.ts` 145 -> 147, `parser.ts` 122 -> 124, `db.ts`
	 * 124 -> 126 and `sync-worker.ts` 123 -> 125, each by the two modules `utils/prompt-precompiled.ts`
	 * and `utils/prompt-handlebars.ts`. `utils/prompt.ts`, already on every one of these reaches, reads
	 * the binary's build-time precompiled templates from the first and loads the Handlebars compiler
	 * through the second only when a template has no precompiled form. The first imports one type from
	 * `./prompt-variables` and the second imports only `handlebars/runtime`, so no consumer gained an
	 * edge to a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-10-03: `agent/src/proxy.ts` 147 -> 148, `parser.ts` 124 -> 125, `db.ts`
	 * 126 -> 127 and `sync-worker.ts` 125 -> 126, each by the one module `catalog/catalog-spans.ts`, a
	 * zero-import leaf that finds a provider's and a model's byte range in `models.json` without parsing
	 * the document. `catalog/models.ts`, already on every one of these reaches, reads one provider's
	 * span through it. The leaf imports nothing, so no consumer gained an edge to a subsystem it did not
	 * already reach.
	 */
	/**
	 * Re-measured 2026-10-05: `agent/src/proxy.ts` 148 -> 149, `parser.ts` 125 -> 126, `db.ts`
	 * 127 -> 128, `sync-worker.ts` 126 -> 127 and `api-key-resolver.ts` 58 -> 59, each by the one module
	 * `@veyyon/utils/local-time`, which reads the local clock through the C library's `localtime_r` so
	 * naming a log file builds no ICU time zone cache. `@veyyon/utils/logger` and `@veyyon/utils/log-file`,
	 * already on every one of these reaches, take the local time from it. Its only import is `bun:ffi`, so
	 * no consumer gained an edge to a subsystem it did not already reach.
	 */
	/**
	 * Re-measured 2026-10-06: `shared-llm.ts` 211 -> 212 by the one module `ai/dialect/bracket-walk.ts`,
	 * a zero-import leaf holding the bracket-depth walk that splits call arguments. `dialect/gemini.ts`
	 * and `dialect/gemma.ts`, already on this reach, each walked brackets inline and now take the walk
	 * from that owner. The leaf imports nothing, so no consumer gained an edge to a subsystem it did not
	 * already reach.
	 */
	it.each([
		["agent/src/proxy.ts", 149],
		["apps/stats/src/parser.ts", 126],
		["apps/stats/src/db.ts", 128],
		["apps/stats/src/sync-worker.ts", 127],
		["plugins/mnemopi/src/core/embeddings.ts", 131],
		// Re-measured 2026-08-28 at 66, from 127. The file took `trimTrailingSlashes` and
		// `withScopedTimeoutSignal` from the `@veyyon/utils` entry point, so every module that entry
		// re-exports rode along and each new one raised this count by hand; both names are now taken
		// from `@veyyon/utils/url` and `@veyyon/utils/scoped-timeout`, which own them.
		["plugins/mnemopi/src/core/extraction/client.ts", 70],
		// Re-measured 2026-08-28 at 56, from 55. The one new module is `@veyyon/utils/ansi`, a
		// zero-import leaf that owns the escape constants; `sanitize-text.ts`, already on this reach,
		// used to spell `"\x1b"` inline and now takes `ESC` from that owner. The leaf adds no edge of
		// its own, so nothing outside this closure was gained.
		["coding-agent/src/config/api-key-resolver.ts", 59],
		// Re-measured 2026-09-11 at 207, from 205: the two leaves named above. 205 was the three
		// `@veyyon/model` leaves of 2026-09-04; 202 was one module from the catalog OpenCode discovery
		// header leaf; 184 was the 2026-07-27 engine-call remeasure; 325 before that was the leak. The
		// file still takes no name from the barrel.
		["coding-agent/src/commit/shared-llm.ts", 212],
		// The agent's hot loop and the `Agent` class. Both STREAM, so both reach the engine whatever
		// specifier they use; the ceilings are what the other ten names cost when taken from the entry
		// point. 378 -> 321 and 380 -> 323.
		["agent/src/agent-loop.ts", 340],
		["agent/src/agent.ts", 340],
	])("%s reaches at most %i modules", (relative, ceiling) => {
		expect(reach(relative)).toBeLessThanOrEqual(ceiling);
	});

	/**
	 * And none of them names the barrel at runtime any more, asserted as the SPECIFIER because that is the
	 * thing a future edit would change. A ceiling alone cannot say WHY a file grew; this says what to undo.
	 */
	it.each([
		"agent/src/proxy.ts",
		"apps/stats/src/parser.ts",
		"plugins/mnemopi/src/core/embeddings.ts",
		"plugins/mnemopi/src/core/extraction/client.ts",
		"coding-agent/src/config/api-key-resolver.ts",
		"coding-agent/src/mcp/manager.ts",
		"coding-agent/src/commit/shared-llm.ts",
		"coding-agent/src/tools/web/search/providers/perplexity.ts",
		"agent/src/agent-loop.ts",
		"agent/src/agent.ts",
	])("%s takes no runtime name from the barrel", relative => {
		const source = SOURCES.find(([name]) => name === relative)?.[1];

		expect(source, `${relative} is missing from the scan`).toBeDefined();
		expect(barrelRuntimeNames(source as string)).toEqual([]);
	});

	/**
	 * The types are still imported, from the barrel, on purpose.
	 *
	 * This is the case that proves the cuts were made by moving VALUE imports rather than by deleting
	 * things. `import type` is erased at compile time, so the barrel is the right place to take a type from:
	 * it is the package's public vocabulary and it costs nothing.
	 */
	it("still takes its types from the barrel, which is free", () => {
		const proxy = SOURCES.find(([name]) => name === "agent/src/proxy.ts")?.[1] ?? "";

		// Both halves. The scan this replaced was `toContain('from "@veyyon/ai"')`, which a RUNTIME
		// import satisfies just as well, so it could not tell "free" from the thing it forbids.
		expect(typeOnlyModuleSpecifiersIn(proxy)).toContain("@veyyon/ai");
		expect(moduleSpecifiersIn(proxy)).not.toContain("@veyyon/ai");
	});
});
