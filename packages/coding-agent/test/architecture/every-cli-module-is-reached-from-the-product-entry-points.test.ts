/**
 * WHY: a module under `src/cli/` that no product entry point imports is a command nobody can run.
 *
 * The defect: `src/cli/claude-trace-cli.ts` (820 lines) had no registration in `cli-commands.ts` and
 * no importer anywhere in `src/`. Its only caller was a developer script, so `veyyon` could not reach
 * it while it sat in the package source as if it were a subcommand. It now lives beside that script.
 *
 * The class closed here is every `src/cli/` module the product cannot reach: a command module never
 * registered, a helper whose last caller was deleted, a module only a script or a test imports. The
 * sweep enumerates `src/cli/` from the tree at run time and walks the import graph (static and
 * dynamic, relative edges) from the executable (`bin` in package.json) and the package root export
 * (`main`). A new module that nothing reaches turns this red until it is wired in or recorded below.
 *
 * Not caught: a module reached only through a string-built specifier the walk cannot read, and a
 * command registered in `cli-commands.ts` whose handler is unreachable for another reason.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { reachableFrom, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

const PACKAGE_ROOT = repoPath("packages", "coding-agent");

/** Modules under `src/cli/` that no entry point imports, each with the reason it stays. Pinned exactly. */
const UNREACHED_ON_PURPOSE: Record<string, string> = {};

function entryPoints(): string[] {
	const manifest = JSON.parse(readFileSync(repoPath("packages", "coding-agent", "package.json"), "utf8")) as {
		bin: Record<string, string>;
		main: string;
	};
	return [...Object.values(manifest.bin), manifest.main].map(entry => repoPath("packages", "coding-agent", entry));
}

describe("every src/cli module is reached from the product entry points", () => {
	const cliModules = typeScriptFiles(repoPath("packages", "coding-agent", "src", "cli"));
	const reached = reachableFrom(entryPoints());

	it("enumerates the cli directory and reaches into it", () => {
		// A walk that reads no edge would report every module unreached; one that reads them all reaches cli-commands.
		expect(cliModules.length).toBeGreaterThan(20);
		expect(reached.has(`${PACKAGE_ROOT}/src/cli-commands.ts`)).toBe(true);
	});

	it("leaves no module unreached except the ones recorded", () => {
		const unreached = cliModules.filter(file => !reached.has(file)).map(repoRelative);
		expect(unreached).toEqual(Object.keys(UNREACHED_ON_PURPOSE).sort());
	});
});
