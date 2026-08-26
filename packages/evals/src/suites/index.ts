/**
 * Every evaluation suite in this repository, and the one call that registers them.
 *
 * Registration is explicit. Nothing here scans the filesystem for suites, so a
 * suite that is not named below does not exist as far as the CLI, the manager and
 * the dashboard are concerned — which is the point: the set of suites a run can
 * name is readable in one place.
 *
 * The suite trees are NOT re-exported through this module. Three suites that each
 * describe tasks, provenance and metadata collide on those names, and a star that
 * merges them makes `TaskMetadata` mean whichever suite was listed first. Import a
 * suite's own module directly, as `@veyyon/evals/suites/terminal-bench/suite`.
 */

import { defaultSuiteRegistry, type SuiteRegistry } from "../core/suite-registry";
import { deepSweSuite } from "./deep-swe/suite";
import { terminalBenchSuite } from "./terminal-bench/suite";
import { typescriptEditSuite } from "./typescript-edit/suite";

export const builtinSuites = [deepSweSuite, terminalBenchSuite, typescriptEditSuite] as const;

/**
 * Registers every built-in suite in the given (or default) registry. Idempotent
 * per registry, so a caller that also imports a suite module directly cannot
 * trigger a duplicate-registration error.
 */
export function registerAllSuites(registry: SuiteRegistry = defaultSuiteRegistry): void {
	for (const suite of builtinSuites) {
		if (!registry.has(suite.name)) {
			registry.register(suite);
		}
	}
}
