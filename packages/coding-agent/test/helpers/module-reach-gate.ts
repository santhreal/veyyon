import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

/**
 * The shared setup every module-reach gate in this package walks with.
 *
 * WHY IT IS HERE AND NOT IN EACH SUITE. The resolution table is the half of a reach measurement that
 * fails SILENTLY: a specifier it does not know resolves to nothing, the walk stops early, and every
 * assertion built on it is an upper bound or a "does not reach", so the gate passes while measuring less
 * than it claims. That already happened once, and the record of it is in the comment below. A second
 * copy of this setup is a second chance for the two to drift apart and for one gate to be measuring a
 * smaller graph than its neighbour while both stay green, so there is one copy and the suites import it.
 *
 * The cache is shared for the same reason it exists at all: the gates walk one graph between them, and a
 * memo per suite would re-read the same thousand files per file.
 */

/** `packages/coding-agent/src`. */
export const SRC = path.join(import.meta.dir, "..", "..", "src");

/** The workspace `packages/` directory, which is what reached names are made relative to. */
export const PACKAGES = path.join(SRC, "..", "..");

/**
 * The workspace resolved to source, which is the entire point of this file, DERIVED from every package's
 * `exports` field rather than typed out here.
 *
 * Every entry is load-bearing in one direction: a specifier the table does not know resolves to nothing,
 * the walk stops, and the count comes back SMALLER. Every assertion below is an upper bound or a "does not
 * reach", so under-resolution makes all of them pass while measuring less than they claim.
 *
 * WHICH IS EXACTLY WHAT HAPPENED, and it is why the table is no longer written here. This gate listed
 * seven packages by hand and `test-suite-module-reach.test.ts` listed four of the same seven, and both
 * listed `@veyyon/agent` -- a name no package in this workspace has. The directory is `packages/agent`
 * and the package is `@veyyon/agent-core`, whose barrel is 406 modules, so all 569 `@veyyon/agent-core`
 * specifiers in the repository resolved to nothing in both gates. `@veyyon/mnemopi` (398 modules),
 * `@veyyon/stats` (365), `@veyyon/natives` and `@veyyon/tool-render` were unknown to every copy. Nothing
 * failed. `thinking.ts` was recorded at 6 modules and is 407.
 *
 * `@veyyon/utils/module-reach-workspace` now reads the `exports` map of every package manifest under
 * `packages/` and builds the table from it, so the gate resolves what the runtime resolves, a package that
 * adds a subpath export is covered without an edit, and a NEW package cannot join the workspace unresolved
 * and silently lower every ceiling in the repository. The derivation is tested, and the completeness check
 * that every workspace package is in the table lives with it, in
 * `packages/utils/test/module-reach-workspace.test.ts`.
 *
 * WHAT THIS MEANS FOR EVERY NUMBER RECORDED ABOVE. The cuts are real: each one removed a named edge, and
 * the before/after pairs were measured the same way, so the ratios hold. The ABSOLUTE values were low,
 * some of them by a factor of sixty, because the graph they walked stopped at four package boundaries.
 * Each ceiling below carries the re-measured number.
 */
export const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(path.join(PACKAGES, ".."));

/** One memo for the whole gate: every entry below walks the same shared graph. See `ModuleReachCache`. */
export const CACHE = createModuleReachCache();

/** How many modules a path under `src/` instantiates, itself included. */
export function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

/** The same walk as {@link reach}, as names relative to `packages/`, sorted. */
export function reachedNames(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)]
		.map(file => path.relative(PACKAGES, file))
		.sort();
}
