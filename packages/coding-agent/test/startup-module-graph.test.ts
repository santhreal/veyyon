/**
 * The interactive TUI must not be in the CLI's STATIC import graph.
 *
 * WHY THIS SUITE EXISTS. `main.ts` loads interactive mode with `import("./modes/interactive-mode")` and
 * says why in a comment: the `modes/components` subtree is the largest single chunk of the boot graph, so
 * kicking it off deliberately lets it overlap with session creation "and so print/rpc/acp runs never pay
 * for it at all". That was not true. Two static edges pulled the same subtree in anyway, and a
 * `veyyon -p "hi"` run loaded the settings overlay, the plugin-settings panel and the interactive mode it
 * would never construct:
 *
 *   1. Four extensibility loaders held `import * as PiCodingAgent from "../../index"` so extension authors
 *      could be handed the package as `api.pi`. `src/index.ts` re-exports `./modes`, whose barrel
 *      re-exports `interactive-mode`. Three of those loaders run during startup, so every launch loaded
 *      the whole library surface -- with no extensions installed. They now go through
 *      `extensibility/coding-agent-api.ts`, which imports the barrel on demand.
 *   2. `main.ts` imported two tiny functions from `modes/components/welcome.ts`, which put a component
 *      module -- and `@veyyon/tui`, the theme and the shimmer machinery behind it -- in the static graph of
 *      every launch. Those two functions moved to `modes/components/launch-tip.ts`, which imports nothing
 *      but `APP_NAME`.
 *
 * A comment cannot hold this. Both edges were written by people who had no reason to think about startup
 * cost, and neither looked wrong: one is how the extension API is defined, the other is an import of two
 * functions. What makes the difference measurable is that they are STATIC -- Bun reads the entire
 * statically reachable graph before evaluating anything -- so the check has to be on the graph, not on a
 * naming convention. Resolving the graph here is why `interactive-mode`'s inclusive load fell from 402ms
 * to 75ms and the instrumented boot wall from ~2.0s to ~1.1s.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

const SRC = path.resolve(import.meta.dir, "..", "src");
const PACKAGES = path.resolve(SRC, "..", "..");

/**
 * Static import and re-export specifiers only.
 *
 * `import(...)` is deliberately NOT matched: a dynamic import is exactly the escape hatch this gate
 * exists to protect, so counting it would make every lazy load a violation. `import type` and
 * `export type` are dropped because they are erased before the module ever loads.
 */
function staticSpecifiers(source: string): string[] {
	const found: string[] = [];
	// `from "x"` preceded by an import/export clause, with the clause captured so type-only forms and
	// the `import("x")` call form can be told apart.
	for (const match of source.matchAll(/^[ \t]*(import|export)\s+([\s\S]*?)from\s*["']([^"']+)["']/gm)) {
		const [, keyword, clause, specifier] = match as unknown as [string, string, string, string];
		if (/^type\s/.test(clause)) continue;
		// `import { type A, type B } from "x"` erases to nothing, same as `import type { A, B }`. A clause
		// with even one value specifier keeps the module, so only an all-type brace list is skipped.
		const braced = clause.match(/^\{([\s\S]*)\}\s*$/);
		if (braced) {
			const specifiers = (braced[1] as string)
				.split(",")
				.map(entry => entry.trim())
				.filter(entry => entry !== "");
			if (specifiers.length > 0 && specifiers.every(entry => entry.startsWith("type "))) continue;
		}
		if (keyword === "import" || keyword === "export") found.push(specifier);
	}
	// Bare side-effect imports (`import "./x"`) have no `from` clause.
	for (const match of source.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) {
		found.push(match[1] as string);
	}
	return found;
}

/** The file a specifier resolves to, or `undefined` when it leaves this workspace. */
function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
	let base: string;
	if (specifier.startsWith(".")) {
		base = path.resolve(path.dirname(fromFile), specifier);
	} else if (specifier.startsWith("@veyyon/")) {
		const [, rest] = specifier.split("@veyyon/") as [string, string];
		const [pkg, ...subpath] = rest.split("/");
		base = path.join(PACKAGES, pkg as string, "src", ...subpath);
	} else {
		return undefined;
	}
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next form. An unresolvable specifier is `tsc`'s finding, not this test's.
		}
	}
	return undefined;
}

/** Every file reachable from `entry` through static imports alone. */
function staticGraph(entry: string): Set<string> {
	const seen = new Set<string>([entry]);
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		// A `.txt`/`.md` asset import resolves to a real file with no imports of its own.
		if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
		for (const specifier of staticSpecifiers(readFileSync(file, "utf8"))) {
			const resolved = resolveSpecifier(specifier, file);
			if (!resolved || seen.has(resolved)) continue;
			seen.add(resolved);
			queue.push(resolved);
		}
	}
	return seen;
}

/**
 * The boot graph, from both entry points that make it up.
 *
 * `cli.ts` hands off with `await import("./main")` on purpose -- profile selection has to run before
 * anything reads the agent directory -- so its own static graph stops at the handoff and says nothing
 * about what a launch loads. `main.ts` is where the rest of the launch is statically reachable from, and
 * it is reached on every run, so the union of the two is the graph a user actually pays for.
 */
const CLI_GRAPH = new Set([...staticGraph(path.join(SRC, "cli.ts")), ...staticGraph(path.join(SRC, "main.ts"))]);

/** Modules that must stay out of the static boot graph, with what each one drags in behind it. */
const MUST_BE_LAZY: ReadonlyArray<{ file: string; why: string }> = [
	{ file: "modes/interactive-mode.ts", why: "the whole interactive mode; print/rpc/acp runs never build it" },
	{ file: "modes/components/plugin-settings.ts", why: "the plugin settings panel and the marketplace types" },
	{ file: "modes/components/settings-selector.ts", why: "every settings tab and its component tree" },
	{ file: "modes/components/welcome.ts", why: "the welcome card, the sun mark and the tips corpus" },
	{ file: "index.ts", why: "the package barrel, which re-exports every mode and every component" },
	{ file: "modes/index.ts", why: "the modes barrel, which re-exports interactive-mode" },
];

describe("the CLI's static import graph", () => {
	for (const { file, why } of MUST_BE_LAZY) {
		/**
		 * One assertion per module so a regression names the module it broke, not a set difference. Each
		 * of these is reachable at runtime through a dynamic import when it is genuinely needed.
		 */
		it(`excludes ${file} (${why})`, () => {
			expect(CLI_GRAPH.has(path.join(SRC, file))).toBe(false);
		});
	}

	/**
	 * The walker has to actually reach the tree, or every assertion above passes on an empty set. Pin the
	 * entry point, a module that is unquestionably static, and a rough size.
	 */
	it("is walked, not merely empty", () => {
		expect(CLI_GRAPH.has(path.join(SRC, "cli.ts"))).toBe(true);
		expect(CLI_GRAPH.has(path.join(SRC, "main.ts"))).toBe(true);
		expect(CLI_GRAPH.has(path.join(SRC, "sdk.ts"))).toBe(true);
		expect(CLI_GRAPH.size).toBeGreaterThan(200);
	});

	/**
	 * And the walker must follow static edges while ignoring dynamic ones, which is the single distinction
	 * the whole gate rests on. Asserted on literal source rather than on the repo, so a regex change that
	 * quietly stopped seeing `export ... from` (how the barrels pull the mode tree in) fails here.
	 */
	it("reads static imports and re-exports, and ignores dynamic imports and type-only lines", () => {
		const source = [
			'import { a } from "./value";',
			'import "./side-effect";',
			'import * as ns from "./namespace";',
			'export { b } from "./re-export";',
			'export * from "./star";',
			'import type { T } from "./type-only";',
			'import type * as TN from "./type-namespace";',
			'import { type OnlyTypes, type AlsoTypes } from "./braced-types";',
			'import { type Mixed, real } from "./mixed";',
			'const lazy = await import("./dynamic");',
			'export type { U } from "./type-re-export";',
		].join("\n");

		expect(staticSpecifiers(source)).toEqual([
			"./value",
			"./namespace",
			"./re-export",
			"./star",
			"./mixed",
			"./side-effect",
		]);
	});

	/**
	 * The two fixes have to stay the way they are. `coding-agent-api.ts` is the one place allowed to reach
	 * the barrel, and it must do so dynamically; `main.ts` must take the launch tip from the module that
	 * carries no component with it. Without this, someone "simplifying" either one back to a static import
	 * would put the whole tree back in the boot graph, and only the assertions above would say so -- with
	 * no hint of which edge did it.
	 */
	it("keeps the barrel behind a dynamic import and the launch tip out of the welcome component", () => {
		const apiOwner = readFileSync(path.join(SRC, "extensibility", "coding-agent-api.ts"), "utf8");
		expect(apiOwner).toContain('import("../index")');
		expect(staticSpecifiers(apiOwner)).toEqual(["@veyyon/utils"]);

		const main = readFileSync(path.join(SRC, "main.ts"), "utf8");
		expect(moduleSpecifiersIn(main)).toContain("./modes/components/launch-tip");
		expect(moduleSpecifiersIn(main)).not.toContain("./modes/components/welcome");
	});
});
