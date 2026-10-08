/**
 * Nothing joins the launch card's path without being counted.
 *
 * WHY THIS SUITE EXISTS. The compiled binary is split at every `import()`, and Bun's standalone loader
 * links a chunk and evaluates the modules in it before the module that asked for it continues. An
 * interactive launch reaches the card through a fixed chain of those boundaries: the entry `cli.ts`,
 * the CLI runner (`@veyyon/utils/cli` and `cli-commands.ts`, imported together), `commands/launch.ts`,
 * and `cli/launch-card.ts`, which paints. The union of those five static graphs is what the operator
 * waits on before the first byte. On the compiled binary, warm, on a pty with echo disabled, that byte
 * lands at 36-38ms over seven runs, split as 10-11ms before the entry's first statement, 2.2ms for the
 * runner, 1.0ms for the launch command, 8.6-9.5ms to import the card and 16-17ms of prologue. It
 * landed at 119-128ms when the product linked as one chunk.
 *
 * `the-boot-path-stays-thin.test.ts` bounds `cli.ts` and `the-launch-card-opens-no-database.test.ts`
 * bounds `cli/launch-card.ts`. Nothing bounded the runner or the launch command, and none of the walks
 * follows a specifier out of the workspace, so a third-party package imported anywhere on the path
 * added its whole evaluation to the card without moving any count.
 *
 * THE CLASS. A subtree joins the card's path. The workspace half is the union of the five graphs, held
 * to a ceiling. The third-party half is derived from every module on the path and pinned by exact
 * equality, each package with what it costs and why the path imports it. A workspace specifier the
 * resolution table cannot resolve lands in the third-party half too, so an under-resolved walk fails
 * here instead of passing with a smaller count.
 *
 * WHAT IT DOES NOT CATCH. A sixth boundary on the way to the card: which `import()` runs before the
 * paint is control flow the walk cannot read, so the chain is listed. A package reached through
 * `require()` or `import()`, which the walk does not follow because deferring evaluation is the fix
 * these gates want; in the compiled binary a `require()` target is still linked in the requiring
 * module's chunk, which is where `yaml` sits (159 KB of the entry chunk's 327 KB). And an admitted
 * module that grows heavier on its own.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import { moduleSpecifiersIn, resolveModuleSpecifier } from "@veyyon/utils/module-reach";
import { PACKAGES, RESOLUTION, reachedNames } from "../helpers/module-reach-gate";

/** The modules a launch imports on the way to the card's first byte, one `import()` boundary apart. */
const CARD_PATH = [
	"cli.ts",
	"cli-commands.ts",
	path.join("..", "..", "utils", "src", "cli.ts"),
	path.join("commands", "launch.ts"),
	path.join("cli", "launch-card.ts"),
];

/** Every workspace module the five graphs reach, as names relative to `packages/`, sorted. */
function modulesOnThePath(): string[] {
	const found = new Set<string>();
	for (const entry of CARD_PATH) {
		for (const name of reachedNames(entry)) found.add(name);
	}
	return [...found].sort();
}

/**
 * The third-party packages the modules on the path import statically, each with its importers.
 *
 * A specifier is third-party when it is not relative, not a runtime builtin and not resolved by the
 * workspace table. The package is its first path segment, or its first two for a scoped name.
 */
function thirdPartyPackagesOn(modules: readonly string[]): Record<string, string[]> {
	const found: Record<string, string[]> = {};
	for (const relative of modules) {
		const file = path.join(PACKAGES, relative);
		for (const specifier of moduleSpecifiersIn(fs.readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".") || isBuiltin(specifier)) continue;
			if (resolveModuleSpecifier(file, specifier, RESOLUTION) !== undefined) continue;
			const segments = specifier.split("/");
			const name = specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
			found[name] = [...(found[name] ?? []), relative];
		}
	}
	return found;
}

/**
 * The third-party packages the card's path is allowed to evaluate, and why each one is there. Costs are
 * import times inside a compiled bytecode binary, after a first `import()` has already run.
 *
 * `chalk` (0.37ms once `node:tty` is loaded) colours the help text and the usage errors in
 * `cli/args.ts`, the flag parser `commands/launch.ts` runs before it decides to paint. `lru-cache`
 * (0.5ms) is the highlight cache in `theme/highlight.ts`, which the theme the card paints with builds
 * on.
 */
const ADMITTED_THIRD_PARTY = ["chalk", "lru-cache"];

/**
 * Workspace modules the five graphs reach, measured 2026-10-04 with the workspace resolved to source:
 * 39 from `cli.ts`, 28 from `cli-commands.ts`, 5 from `@veyyon/utils/cli`, 44 from
 * `commands/launch.ts` and 311 from `cli/launch-card.ts`, 333 once the overlap is counted once. The
 * floor is what stops a resolution table that resolves nothing from passing the ceiling.
 *
 * 332 rather than 331 is `@veyyon/utils/local-time`, which the logger on every leg reads local time
 * through instead of a `Date` whose first local-time read builds the ICU time zone cache. It imports
 * only `bun:ffi`.
 *
 * 333 rather than 332 is `core/frame-pacing.ts`, the frame throttle and the terminal hosts' settle
 * windows split out of `core/tui.ts`, which the card already evaluates. It imports nothing.
 */
const CARD_PATH_CEILING = 333;
const CARD_PATH_FLOOR = 250;

describe("nothing joins the launch card path uncounted", () => {
	const modules = modulesOnThePath();

	/** The walk is real: each leg reaches what it is known to reach, so the bounds below measure a graph. */
	it("walks every leg of the path", () => {
		expect(modules.length).toBeGreaterThanOrEqual(CARD_PATH_FLOOR);
		expect(modules).toContain(path.join("coding-agent", "src", "cli-commands.ts"));
		expect(modules).toContain(path.join("utils", "src", "cli.ts"));
		expect(modules).toContain(path.join("coding-agent", "src", "commands", "launch.ts"));
		expect(modules).toContain(path.join("coding-agent", "src", "modes", "terminal", "first-frame.ts"));
	});

	/**
	 * The derivation sees a package where one is imported: the bash tool renders its prompt through
	 * `handlebars`, so the equality below is a measurement rather than a walk that found nothing.
	 */
	it("finds the third-party packages of a module that imports them", () => {
		const onATool = thirdPartyPackagesOn(reachedNames(path.join("tools", "shell", "bash.ts")));

		expect(Object.keys(onATool)).toContain("handlebars");
	});

	/**
	 * The first assertion fails naming each unadmitted package with the modules that import it, so the
	 * edge to cut is in the message. The second fails on an admission the path no longer needs.
	 */
	it("evaluates no third-party package it was not admitted", () => {
		const packages = thirdPartyPackagesOn(modules);
		const unadmitted = Object.entries(packages).filter(([name]) => !ADMITTED_THIRD_PARTY.includes(name));

		expect(Object.fromEntries(unadmitted)).toEqual({});
		expect(Object.keys(packages).sort()).toEqual(ADMITTED_THIRD_PARTY);
	});

	/** The ordinary way the cost comes back: no new package, just more workspace modules. */
	it("does not grow the path's workspace graph", () => {
		expect(modules.length).toBeLessThanOrEqual(CARD_PATH_CEILING);
	});
});
