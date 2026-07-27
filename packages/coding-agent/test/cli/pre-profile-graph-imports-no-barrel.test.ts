/**
 * Nothing in `cli.ts`'s static import graph may import the `@veyyon/utils` barrel, because the barrel
 * chooses a profile's `.env` before `--profile` has been read.
 *
 * WHY THIS SUITE EXISTS. `packages/utils/src/env.ts` parses `$HOME/.env`, the config-root `.env`, the AGENT
 * `.env` and the project `.env` at module scope, applies them to `Bun.env`, and then rebuilds the directory
 * resolver. The barrel re-exports that module, so importing `@veyyon/utils` anywhere reachable from `cli.ts`
 * loads the DEFAULT profile's `.env` before `runCli` has parsed `--profile` and called `setProfile`. The
 * result is a session running with another profile's environment: its API keys, its directory overrides.
 *
 * `profile-cli.test.ts` proves the end result by spawning a probe that imports the CLI entry, never calls
 * `runCli`, and asserts a planted sentinel from the default profile's `.env` never reached the process. That
 * test is the contract and it went RED because `cli/args.ts` imported `APP_NAME`, `CONFIG_DIR_NAME`,
 * `logger` and `pluralize` from the barrel, and `cli/exit-codes.ts` re-exported `SIGNAL_EXIT_BASE` from it.
 * A red spawn tells you a `.env` leaked; it does not tell you which of thirteen modules pulled it in.
 *
 * So this suite walks the real graph and names the file. It is the same guard as
 * `eval/__tests__/process-entry-imports-no-barrel.test.ts`, applied to the other entry point that has the
 * same ordering constraint, and it exists because both were violated by ordinary-looking imports that no
 * reviewer would flag.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli.ts");
const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

/** Resolve a relative specifier to a source file the way the runtime does, or null if it is not one. */
async function resolveRelative(fromFile: string, specifier: string): Promise<string | null> {
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
		if (candidate.endsWith(".ts") && (await Bun.file(candidate).exists())) return candidate;
	}
	return null;
}

/**
 * Every STATIC `from "..."` specifier in a source file.
 *
 * Static only, on purpose: `cli.ts` reaches the rest of the program through dynamic `await import(...)`
 * AFTER `setProfile` has run, and those modules are free to use the barrel. The invariant is about what
 * loads before that point, which is exactly the static graph.
 */
function staticSpecifiers(source: string): string[] {
	return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+"([^"]+)"/g)].map(
		match => match[1] as string,
	);
}

interface Graph {
	files: string[];
	barrelImporters: string[];
}

async function walkFromCliEntry(): Promise<Graph> {
	const visited = new Set<string>();
	const barrelImporters: string[] = [];
	const queue = [CLI_ENTRY];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (visited.has(file)) continue;
		visited.add(file);
		const source = await Bun.file(file).text();
		for (const specifier of staticSpecifiers(source)) {
			if (specifier === "@veyyon/utils") {
				barrelImporters.push(path.relative(SRC_ROOT, file));
				continue;
			}
			if (!specifier.startsWith(".")) continue;
			const resolved = await resolveRelative(file, specifier);
			if (resolved) queue.push(resolved);
		}
	}
	return { files: [...visited], barrelImporters };
}

describe("the pre-profile CLI import graph", () => {
	/**
	 * The walk must reach the two modules that regressed, or a pass would prove nothing. Both sit behind
	 * `profile-bootstrap.ts` rather than in `cli.ts` itself, which is why the existing source lock on `cli.ts`
	 * did not catch them.
	 */
	it("reaches the modules this test is meant to police", async () => {
		const { files } = await walkFromCliEntry();
		const relative = files.map(file => path.relative(SRC_ROOT, file));

		expect(relative).toContain("cli.ts");
		expect(relative).toContain("cli/args.ts");
		expect(relative).toContain("cli/exit-codes.ts");
	});

	/** The contract: no module loaded before `setProfile` pulls the env-loading barrel. */
	it("imports no module that loads the @veyyon/utils barrel", async () => {
		const { barrelImporters } = await walkFromCliEntry();

		expect(barrelImporters).toEqual([]);
	});

	/**
	 * And the fixes stay subpath imports. Naming the specifiers documents where these symbols live, which is
	 * what an editor reaching for the barrel out of habit does not know.
	 */
	it("keeps args.ts and exit-codes.ts on subpath imports", async () => {
		const args = staticSpecifiers(await Bun.file(path.join(SRC_ROOT, "cli/args.ts")).text());
		const exitCodes = staticSpecifiers(await Bun.file(path.join(SRC_ROOT, "cli/exit-codes.ts")).text());

		expect(args).toContain("@veyyon/utils/dirs");
		expect(args).toContain("@veyyon/utils/format");
		expect(args).not.toContain("@veyyon/utils");
		expect(exitCodes).toContain("@veyyon/utils/signal-exit");
		expect(exitCodes).not.toContain("@veyyon/utils");
	});

	/**
	 * The graph must stay small. It is small BY DESIGN -- everything else is loaded through dynamic imports
	 * after the profile is known -- and a graph that quietly grew to dozens of modules would mean that design
	 * had eroded, which is how a barrel import gets in unnoticed in the first place.
	 */
	it("stays a small graph, as the design requires", async () => {
		const { files } = await walkFromCliEntry();

		expect(files.length).toBeLessThan(30);
	});
});
