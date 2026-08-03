/**
 * The test suite's module reach, ratcheted, so the dependency graph cannot widen unnoticed.
 *
 * WHY THIS SUITE EXISTS, AND WHAT IT DOES NOT PROVE. An earlier version of this header said the
 * total predicted a full run's memory. That is true in one run mode and false in the other, so read
 * which one you are in before you use these numbers for anything but the graph.
 *
 * Under bun's DEFAULT parallelism, files run in worker processes that get recycled, modules are
 * cached across the files a worker runs, and the quantity a worker holds is the UNION of what those
 * files reach. That union is 1,902 distinct source modules for the whole package: bounded, and far
 * too small to be a memory story. Sixty real test files peak at 0.76 GB that way.
 *
 * Under `--parallel=1` every file runs in one process, and workspace source is re-instantiated for
 * every file and never freed, so the run costs roughly the SUM of what each file reaches. Measured
 * 2026-07-26: eight probe files each importing `session/agent-session` climb 232, 286, 343, 388,
 * 427, 475, 522, 564 MB with no sign of settling, while the same shape of probe importing `arktype`
 * from `node_modules` flattens at 173 MB. The same sixty real files that peak at 0.76 GB by default
 * peak at 4.62 GB with the flag, a slope of 75.8 MB per file, and 1,887 files at that slope is the
 * 13.4 GB kill recorded in `BACKLOG.md` as `FULLRUN-OOM-KILLS-THE-CODING-AGENT-SUITE`. So for that
 * run mode the ceilings below really are a memory bound, and trimming a file's reach really does
 * reduce it. Retained per-file state is a separate problem tracked in the same row.
 *
 * The numbers below are kept anyway, because they guard something real. A file that imports a
 * barrel for one symbol makes its declared dependencies a lie, invites an import cycle, and slows
 * every cold start that touches it; `validateRelativePath` cost 378 modules that way and
 * `namespaceSessionId` 510. `no-import-cycles.test.ts` catches that for a NAMED hot entry point.
 * It cannot catch the diffuse version -- a helper every suite copies, or fifty suites each widening
 * one import -- because no single ceiling moves. The total does, so the total is what is pinned
 * here. Read the ceilings as "the graph did not widen" first, and as a memory bound only for a
 * `--parallel=1` run.
 *
 * When one fails, the fix is essentially always to import from the owning leaf rather than from a
 * barrel. Raising the number is the one move that guarantees nobody looks again.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createModuleReachCache, type ModuleReachResolution, moduleReachCount } from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const PACKAGE_ROOT = path.join(import.meta.dir, "..", "..");
const REPO_ROOT = path.join(PACKAGE_ROOT, "..", "..");
const TEST_ROOT = path.join(PACKAGE_ROOT, "test");

/**
 * THE WALK IS NOT DEFINED HERE ANY MORE. It was, and `packages/utils/test/barrel-stays-cheap.test.ts`
 * had a near-identical copy that resolved relative specifiers only. Both gates are upper bounds, so a
 * resolver that resolves less reports a smaller number and the gate passes while measuring less than it
 * claims -- which is exactly the 774,730-instead-of-1,020,705 under-count recorded below.
 * `@veyyon/utils/module-reach` owns the walk and `packages/utils/test/module-reach.test.ts` tests it
 * against fixtures with known answers, including the bare-package case that caused that under-count.
 * What stays here is what is specific to this gate: which specifiers count as inside the world, and
 * the ceilings.
 *
 * WORKSPACE SPECIFIERS RESOLVE TO SOURCE, not to a built entry point. A test importing `@veyyon/tui`
 * instantiates that package's source graph in the same realm, so it costs exactly what a relative
 * import of the same files costs and belongs in the count.
 *
 * THE BARE NAMES MATTER MORE THAN THE SUBPATHS. 664 test files import `@veyyon/utils` whole, and the
 * barrel is 82 modules against the one or two a file usually wants. Leaving them out would make this
 * gate blind to the exact regression it exists to catch -- a subpath import widened to the barrel,
 * which is the cheapest possible edit and one of the most expensive possible outcomes.
 *
 * WHICH IS WHY THE TABLE IS DERIVED AND NOT TYPED OUT HERE, and the reason is not tidiness. The version of
 * this gate that listed packages by hand listed FOUR, and one of the four was `@veyyon/agent` -- a name no
 * package in this workspace has. The directory is `packages/agent`; the package is `@veyyon/agent-core`,
 * whose barrel is 406 modules. So every `@veyyon/agent-core` import in every test file resolved to nothing,
 * as did `@veyyon/mnemopi` (398), `@veyyon/stats` (365), `@veyyon/natives` and `@veyyon/tool-render`. The
 * total below was not one and a half percent from its ceiling; it was missing whole packages, and nothing
 * failed, because the ceiling is an upper bound. `@veyyon/utils/module-reach-workspace` reads every package
 * manifest under `packages/` and builds the table from its `exports` field, so a package cannot join this
 * workspace unresolved.
 */
const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);

/**
 * One memo for the whole gate, because this file walks 1,891 entries over a graph whose files overlap
 * almost completely. Without it every walk re-read and re-scanned the same modules and the gate took
 * minutes; the numbers are identical either way, which
 * `packages/utils/test/module-reach-cache.test.ts` is what pins.
 */
const CACHE = createModuleReachCache();

/** How many modules `entry` instantiates, itself included. */
function reachFrom(entry: string): number {
	return moduleReachCount(entry, RESOLUTION, CACHE);
}

/** Every `*.test.ts` under `test/`, which is exactly the set a full run instantiates. */
function testFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...testFiles(full));
		else if (entry.name.endsWith(".test.ts")) found.push(full);
	}
	return found;
}

const files = testFiles(TEST_ROOT);
const reaches = files.map(file => [path.relative(PACKAGE_ROOT, file), reachFrom(file)] as const);
const total = reaches.reduce((sum, [, count]) => sum + count, 0);

/**
 * Measured 2026-07-26 at 995,851 across 1,885 files, down from 1,029,705 when the light/dark classifier
 * left `modes/theme/builtin-themes` for `modes/theme/theme-luminance`. That one edge was 33,000 module
 * instantiations: `config/settings` reached the hundred embedded theme JSON modules for a single
 * boolean, and about 1,500 test files import `Settings`. The headroom is about one and a half percent,
 * which is room for a handful of ordinary new suites and not room for a new heavy import in a shared
 * helper.
 *
 * The first version of this gate read 774,730 because it resolved `@veyyon/utils/dirs` and not
 * `@veyyon/utils`. A quarter of the real total is bare-barrel imports, so a gate that skipped them
 * would have reported a healthy suite while the most expensive import style in the repository went
 * unmeasured. Worth remembering when adding a resolution rule: the omission does not fail, it just
 * quietly lowers the number it is guarding.
 *
 * RE-MEASURED 2026-07-26 at 922,380 across 1,889 files, about 72,000 lower, after fourteen barrel
 * imports were re-pointed at the modules that own the values they wanted: the in-flight caps setter out of
 * `@veyyon/ai/stream`, `THINKING_EFFORTS` out of the `@veyyon/ai` barrel in two files, the sqlite
 * credential store out of the barrel in two more, then nine more of the same shape: `assistantText`,
 * `assistantTextBlocks` and `instrumentationRank` (each defined in a module that reaches exactly ONE,
 * against the barrel's 346), `Effort`, `PASTE_CODE_LOGIN_PROVIDERS` and `PROVIDER_REGISTRY`.
 * `config/settings.ts` went 381 -> 250 and 528 test files import it; `modes/utils/copy-targets.ts`,
 * `hindsight/transcript.ts` and `cli/session-stats.ts` each went from ~347 to ~76, and
 * `task/agents.ts` 520 -> 253. `test/architecture/leveraged-imports-stay-cut.test.ts` holds those edges by name; it
 * exists because this gate cannot see them -- it resolves the workspace, so it sees the total move, but
 * the total moving does not say which import to change.
 *
 * RE-MEASURED AGAIN 2026-07-26 at 880,658 across the same 1,889 files, another 41,700 lower, after
 * `packages/ai` split the sqlite credential store and the row logic out of `auth-storage.ts`, the module
 * that also owns the OAuth machinery. Nothing in this package changed except one file's imports:
 * `session/agent-storage.ts` wanted the store, so it now names `@veyyon/ai/auth-storage-sqlite` (83
 * modules) instead of `@veyyon/ai/auth-storage` (214), and fell from 213 to 84. `config/settings.ts`
 * imports it and went 250 -> 125, `session/session-manager.ts` 482 -> 369, `session/session-context.ts`
 * 472 -> 359, and those three are between them imported by most of the suite. The headroom below is
 * about one and a half percent, as before.
 *
 * AND 863,785 across 1,891 files after two splits inside this package, both of the same shape as the
 * credential store: a function living in a module that does more than the function needs.
 * `getMarkdownTheme` was in `modes/theme/theme.ts` and binds an ASCII diagram renderer to the palette,
 * so 291 test files paid 36 modules of mermaid for a closure most of them never call (307 -> 272), and
 * `session/messages.ts` reached the prompt registry for ONE envelope template and the whole tool layer
 * for one notice formatter (356 -> 100, carrying `session/session-manager.ts` 369 -> 155 and
 * `session/session-context.ts` 359 -> 107). `test/architecture/leveraged-imports-stay-cut.test.ts` names
 * each edge; this number is what says the suite as a whole felt it.
 *
 * AND 798,662 after the `tools/read.ts` chain, which is the largest single move recorded here. Four
 * process-global slots and two pure functions lived inside the heavy modules that fill them, chained five
 * hops deep: reading a local file reached the MCP client (through `MCPManager.instance()`, a static slot
 * read that costs the class), the skill loader (through the active-skill snapshot), and the memory
 * consolidator (through `getMemoryRoot`, a path join, reached via the hyperlink formatter of all things).
 * `read` 972 -> 736, `internal-urls` 911 -> 419, `tui/status-line` 168 -> 2. 54 test files import `read`
 * and far more import the TUI barrel behind it.
 *
 * AND 793,972 across 1,891 files, after the `gh` split and after a measurement bug in the walker itself
 * was fixed. Both belong in the same entry because the second one is the reason to distrust the first
 * number a little less.
 *
 * `tools/gh.ts` held the cache-aware issue/PR/diff fetchers AND the `GithubTool` class, and the class
 * renders its own description from `prompts/registry.ts`, so `internal-urls/issue-pr-protocol.ts` reached
 * the whole prompt corpus to resolve `issue://123`. The fetchers moved to `tools/gh-fetch.ts` (81) and the
 * primitives both halves share to `tools/gh-format.ts` (4), every name re-exported from `tools/gh.ts`:
 * `issue-pr-protocol` 355 -> 84, `internal-urls/index.ts` 418 -> 205. `prompts/registry.ts` also stopped
 * naming the `@veyyon/utils` barrel for `definePromptRegistry`, which its own owner module provides in 3
 * modules rather than 74, so the registry is 167 and 163 of those are the prompt `.md` texts it exists to
 * own.
 *
 * THE WALKER BUG matters more than either. `moduleSpecifiersIn` matched `import|export` at a line start
 * and then ran `[\s\S]*?` forward to the next `from "…"`, which does not stop at the end of a statement.
 * Most exports are not re-exports, so `export const $env: Record<string, string> = …;` in
 * `packages/utils/src/env.ts` started a match that settled 140 lines later on a doc comment saying
 * `import { $env } from "@veyyon/utils"` as ADVICE, and `env.ts` was recorded as importing its own package
 * barrel. Worse, `matchAll` resumes after a match ENDS, so every real import inside a swallowed span was
 * never examined: a sweep over all 22,539 source files found 426 phantom specifiers counted and 4 genuine
 * imports invisible. Every gate here is an upper bound, so the hidden ones passed. The pattern now holds an
 * import CLAUSE character class and comments are stripped first;
 * `packages/utils/test/module-reach-reads-code-not-prose.test.ts` pins both directions.
 *
 * RE-MEASURED 2026-07-26 at 896,262 across 1,891 files, and the jump is a CORRECTION rather than a
 * regression: this gate's resolution table listed four packages, one of them under a name no package here
 * has, so every `@veyyon/agent-core`, `@veyyon/mnemopi`, `@veyyon/stats`, `@veyyon/natives` and
 * `@veyyon/tool-render` import in every test file resolved to nothing. The table is derived from the
 * workspace now. 896,262 is what this suite has been costing the whole time, and it is what the cuts
 * recorded above were actually cutting from.
 *
 * The four cuts made once it became visible are in the number: `config/settings.ts` 442 -> 136,
 * `config/settings-schema.ts` 433 -> 58, `thinking.ts` 407 -> 7 and, from one specifier in
 * `session/session-context.ts`, `session/session-manager.ts` 455 -> 179, `internal-urls/index.ts` 497 -> 232
 * and `tools/read.ts` 918 -> 761.
 *
 * AND 893,359 after a sweep of the closures that carry the two package barrels: eleven files in
 * `packages/tui` and eleven in `packages/catalog` and sixteen under `packages/ai` took one or two pure
 * helpers each from the bare `@veyyon/utils` barrel, and two modules in this package whose whole content is
 * a re-export list did the same. `@veyyon/tui` is 70 modules instead of 119 and
 * `@veyyon/catalog/provider-models` 62 instead of 118, which most of this suite pays through one entry
 * point or another.
 *
 * AND 859,485 after the prompt registry was split into one row module per prompt DIRECTORY. It held the
 * `.md` import for all 163 prompts, so a tool importing it to render its own description reached the whole
 * corpus: 167 modules for one string, and 95 files in this package had that edge. Every one of them now
 * imports its own directory's rows (51 modules for `tools/`, 3 for `steering/`), which is 33,874 fewer
 * module instantiations across the suite. Headroom below is about one percent: room for a handful of
 * ordinary suites and none for a new heavy import in a shared helper.
 *
 * AND 832,035 after the theme ENGINE left the code renderers. `modes/theme/theme-binding.ts` exists so a
 * module can read the active theme without loading the loader that sets it, and two names got taken from
 * the engine anyway: `getSymbolTheme` (now its own leaf beside the binding) and `highlightCode`, which the
 * engine only forwards from `modes/theme/highlight`. The last paths mattered more than the direct ones:
 * `tools/bash.ts` and `tools/write.ts` reached the engine through the local `tui` barrel's `./file-list`,
 * four hops from a status line. `tools/read.ts` 648 -> 542, `tools/bash.ts` 504 -> 353, `tools/write.ts`
 * 536 -> 386, and 376 files above 800 modules instead of 387.
 *
 * AND 826,776 after the env-key lookup in `@veyyon/ai` stopped importing the provider registry to read the
 * three credential probes that used to hang on the provider definitions. That is 121 modules off
 * `env-api-key.ts`, which eighteen web-search providers and `tools/fetch.ts` reach, so it lands broadly:
 * `tools/read.ts` 542 -> 468.
 *
 * AND 822,349 after a twelve-file sweep took the `@veyyon/utils` BARREL off `tools/read.ts`'s closure
 * entirely. The barrel is 81 small leaves and each of the twelve wanted one or two names, so the edge only
 * left when the last path did: `packages/agent/src/compaction/messages.ts` 96 -> 20,
 * `session/session-context.ts` 130 -> 82, `session/messages.ts` 122 -> 74, `internal-urls/index.ts`
 * 231 -> 205, `tools/read.ts` 468 -> 449.
 *
 * AND 834,139 across 2,093 files after the session durability, secret-boundary, and telemetry suites
 * landed. This is suite growth, not a widened shared import: the batch adds 64 dedicated behavioral
 * suites whose current gross reach is 31,464 modules, while the source-graph cuts above absorb most of
 * that cost. Seventeen of those suites cross 800 because they exercise the real SDK, session, or tool
 * boundary; the net heavy-file count is 385, seven above the previous ceiling. The new bounds restore
 * about one percent aggregate headroom and three heavy-file slots, rather than hiding the measured
 * baseline behind a broad round number.
 *
 * AND 843,797 across 2,108 files after the startup scrollback suite landed. This is one file, and it is
 * deliberately heavy for the same reason the `createAgentSession` boot below is: it starts a REAL
 * `InteractiveMode` over a real TUI and asserts on the bytes that reach the terminal. Three separate
 * paths were erasing the operator's saved scrollback on every launch, and the two lighter suites written
 * first proved only the one path they drove; the cold-launch replay and the startup theme resolution were
 * caught by capturing a real launch, not by a leaf import. Reaching for the seam instead of the entry
 * point here would delete exactly the property that found the bug. 797 modules, one slot.
 *
 * AND 846,976 across 2,112 files after the four silent-fallback suites landed, which is two costs and
 * only one of them is suite growth. The suites themselves are 2,135 modules: an unparseable `.mcp.json`
 * driven through the live capability providers (514), a broken agent definition (120), a host-provider
 * isolation check (127), and an extension that throws while importing (1,374, the one that crosses 800).
 * The other 1,044 are diffuse and are the interesting half: `test/helpers/hermetic-spawn-env.ts` went 88
 * to 126 because the list of provider credential variables it scrubs is now DERIVED from
 * `CATALOG_PROVIDERS` instead of hand-written, and 28 files import that helper, so one edge is paid 28
 * times. That is exactly the "new heavy import in a shared helper" this header warns has no headroom.
 * It is taken deliberately: a hand-written copy of that list is a list that falls behind, and the
 * failure mode it prevents is a test spawning a CLI that reaches the developer's real credentials. The
 * cheaper import does not exist, since the provider table is 64 modules on its own and the barrel adds
 * only two over the descriptors it re-exports.
 */
const TOTAL_CEILING = 846_976;

/**
 * Measured 2026-07-26 at 531, down from 552 with the same theme-classifier change: eleven `eval-*`
 * suites and ten others sat between 800 and 825 purely on theme data they never touch. Same reasoning
 * as the total: a little room for new suites, none for a regression.
 *
 * RE-MEASURED 2026-07-26 at 376, down from 531, by the same `tools/read.ts` chain cuts. This number is
 * the SHAPE check rather than the size one, and it moved further in proportion than the total did: the
 * files that crossed 800 were mostly crossing it on one import of a tool or a TUI component that dragged
 * a subsystem, so cutting four such edges moved 155 files below the line at once.
 *
 * RE-MEASURED at 375 after the `gh` split. One file, which is the honest scale of that cut for this
 * particular check: the handlers it made cheap are imported by the router, and a test file that reaches
 * the router usually reaches an application entry point anyway.
 *
 * RE-MEASURED at 424 with the workspace resolved, for the same reason the total moved: files that were
 * recorded below 800 were carrying `@veyyon/agent-core` and nobody could see it. 424 is after the cuts, not
 * before -- the correction alone put it well above this. 423 after the barrel-closure sweep, which moved
 * one file below the line: this check is about SHAPE, and a file that crosses 800 usually does it on an
 * application entry point rather than on a barrel.
 *
 * RE-MEASURED at 376 after the theme engine left the code renderers, and at 387 before that after the
 * prompt-registry split, down from 423. Thirty-six files crossed back below
 * the line, which is a larger share than the total moved: a test file reaching one tool reached the whole
 * prompt corpus with it, and 167 modules is most of the distance from a middling file to 800.
 *
 * RE-MEASURED at 376 after the eval tool stopped reaching its own renderer. This case is what caught it:
 * eleven `tools/eval-*` test files sat at 802 and 803, one or two modules over the line, because
 * `tools/eval.ts` was 801 on its own. It runs code, and it held TWO edges to the module that DRAWS results,
 * which brings `Markdown` and `Text` from `@veyyon/tui`, the theme engine, the markdown theme and the
 * settings store with it. One edge imported a ten-line array helper, `upsertStatusEvent`, now a leaf beside
 * the event type it operates on. The other re-exported the renderer for consumers, and no consumer needed
 * the indirection: `tools/renderers.ts` already imported the renderer directly, and the only other reader
 * wanted a preview-line count and was pulling the Python kernel machinery to get it. 801 to 638.
 *
 * WHAT THAT SHOWS ABOUT THIS CASE AND THE TOTAL. A re-export counts, and it has to: `export ... from`
 * instantiates the module exactly like an import, and the first attempt at this removed only the import and
 * measured no change, because the re-export still carried the whole renderer. The total moved 0.8% for a
 * change that took a hot tool down by a fifth. That asymmetry is why both cases exist.
 *
 * RE-MEASURED at 389 after the tool-loading differential added one deliberate
 * `createAgentSession` boot. That suite freezes the exact active and discoverable
 * tool lists across the loading matrix, so replacing the assembled SDK path with
 * leaf policy imports would stop testing the behavior the model receives. The
 * ceiling remains exact: the next accidental application-entry import still fails.
 *
 * RE-MEASURED at 390 after the startup scrollback suite added one more deliberate real-launch boot, for
 * the same reason: it drives a real `InteractiveMode` over a real TUI because the defect it locks out
 * (three paths erasing the operator's saved scrollback at startup) is only visible in the bytes a real
 * launch emits. One slot, and the ceiling stays exact.
 *
 * RE-MEASURED at 391 after the extension-load-failure suite added one more deliberate
 * `createAgentSession` boot (1,374 modules). The defect it locks out is that an extension which throws
 * while importing was dropped with no word to the operator, and the quietest path was the preloaded
 * branch the CLI actually uses. Only a real session assembles that branch, so a leaf import would
 * assert the report exists without proving the path that loses it reaches the report. One slot, and the
 * ceiling stays exact.
 */
const HEAVY_FILE_CEILING = 391;

/** Above this a file is carrying most of an application entry point into its own realm. */
const HEAVY_REACH = 800;

describe("the test suite's module reach", () => {
	/**
	 * The diffuse widening no per-module ceiling can see: a change that adds forty modules to four
	 * hundred files leaves every named entry point inside its own limit and still moves this.
	 */
	it(`instantiates at most ${TOTAL_CEILING} modules across the whole suite`, () => {
		const worst = [...reaches]
			.sort((left, right) => right[1] - left[1])
			.slice(0, 10)
			.map(([file, count]) => `${count} ${file}`)
			.join("\n");

		expect(
			total,
			`total module instantiations across ${files.length} test files. Heaviest:\n${worst}`,
		).toBeLessThanOrEqual(TOTAL_CEILING);
	});

	/**
	 * The shape of the total, not just its size. A suite can hold the total steady while turning
	 * cheap files into heavy ones, and a file that reaches past 800 modules is one that has pulled
	 * most of an application entry point into a test of something much smaller.
	 */
	it(`keeps at most ${HEAVY_FILE_CEILING} files above ${HEAVY_REACH} modules`, () => {
		const heavy = reaches.filter(([, count]) => count > HEAVY_REACH);

		expect(heavy.length, `files reaching more than ${HEAVY_REACH} modules`).toBeLessThanOrEqual(HEAVY_FILE_CEILING);
	});

	/**
	 * NON-VACUITY. Every assertion above is an upper bound, so a resolver that silently returned
	 * nothing would satisfy all of them with a count of one per file and report a healthy suite while
	 * checking nothing. These pin the floor: the suite is large, the alias resolution works, and at
	 * least one known file really does drag an application entry point.
	 */
	it("actually resolves the graph it is measuring", () => {
		expect(files.length).toBeGreaterThan(1_500);
		// DELIBERATELY WELL BELOW the measurement, and that is a correction. This floor was 930,000
		// against a total of about 995,000, and the next real cut took the total to 929,832 and turned
		// this case red -- a gate reporting a FAILURE for an improvement it was built to encourage. A
		// floor that hugs the number it guards does that on every genuine reduction, and what it teaches
		// is to edit the constant without reading the case. Its actual job is to prove the walk happened
		// at scale, and the failure it is aimed at is not subtle: a resolver that stopped resolving
		// workspace specifiers would report roughly one module per file, so a few thousand against
		// hundreds of thousands. The two exact checks below are the precise half of this non-vacuity
		// argument; this one only has to be lower than any working resolver can reach.
		expect(total).toBeGreaterThan(700_000);

		// This suite imports exactly two workspace modules, the shared walk and the derived workspace table,
		// so it is the floor case: three. An exact number rather than a bound, because that is what makes it
		// a floor -- a resolver that found nothing would read 1 and a resolver that started following
		// type-only edges would read more (`ModuleReachResolution` is imported as a type here and must not
		// count).
		const selfReach = reachFrom(path.join(import.meta.dir, "test-suite-module-reach.test.ts"));
		expect(selfReach).toBe(3);

		// And a known interactive-mode suite is the ceiling case, which only holds if `@veyyon/*`
		// specifiers resolved: its imports are almost entirely aliased.
		const interactive = reaches.find(([file]) => file.endsWith("test/interactive-mode-loop.test.ts"));
		expect(interactive?.[1] ?? 0).toBeGreaterThan(1_000);
	});
});
