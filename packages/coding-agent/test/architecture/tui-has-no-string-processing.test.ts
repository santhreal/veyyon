/**
 * WHY: `@veyyon/tui` is the render engine. The string, escape, keyboard, motion
 * and fuzzy-matching primitives it used to carry now live in `@veyyon/utils`,
 * and the point of the move is that a consumer can measure a width or parse a
 * key without a terminal. The defect class is a primitive coming back: a second
 * `visibleWidth`, a local SGR splitter, a private key table — after which two
 * implementations disagree and the one a caller reaches decides the answer.
 *
 * The rule is stated as a dependency direction, not as a text search for a
 * function body: the engine may IMPORT a primitive from `@veyyon/utils`, and it
 * may not own the module that defines one. So the assertion is that the moved
 * module names do not exist under `packages/tui/src/` any more, and that the
 * engine's own files import the primitives they use from `@veyyon/utils`.
 *
 * What it does NOT catch: a primitive re-implemented inline under a different
 * name inside an engine file.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { importSpecifiers, isDirectory, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

const TUI_SRC = repoPath("packages/tui/src");
const UTILS_SRC = repoPath("packages/utils/src");

/**
 * The modules the move relocated. Each one is now a `@veyyon/utils` subpath and
 * must not exist under the engine's tree.
 */
const MOVED_MODULES = [
	"ansi",
	"autocomplete",
	"bar",
	"bracketed-paste",
	"deccara",
	"fuzzy",
	"keybindings",
	"keys",
	"kill-ring",
	"kitty-graphics",
	"latex-block",
	"latex-unicode",
	"loop-watchdog",
	"motion",
	"mouse",
	"padding",
	"paint-columns",
	"paint-ground",
	"paint-surface",
	"sgr",
	"symbols",
	"text-sizing",
	"tight-mode",
	"tmux",
	"width",
	"word-nav",
	"wrap",
] as const;

describe("the primitives live in @veyyon/utils and not in the engine", () => {
	test("every moved module exists in utils", () => {
		// The list is only meaningful if it names real modules; a typo would make
		// the absence check below pass for the wrong reason.
		const missing = MOVED_MODULES.filter(name => !existsSync(`${UTILS_SRC}/${name}.ts`));
		expect(missing).toEqual([]);
	});

	test("no moved module reappeared under packages/tui/src", () => {
		expect(isDirectory(TUI_SRC)).toBe(true);
		const names = new Set<string>(MOVED_MODULES);
		const returned = typeScriptFiles(TUI_SRC)
			.filter(file => names.has(basename(file, ".ts")))
			.map(repoRelative);
		expect(returned).toEqual([]);
	});

	test("the engine imports the primitives it uses from utils", () => {
		// The engine's core modules measure and wrap constantly; if none of them
		// imports a utils subpath, the primitives came back under other names.
		const core = typeScriptFiles(repoPath("packages/tui/src/core"));
		expect(core.length).toBeGreaterThan(5);
		const importers = core.filter(file =>
			importSpecifiers(file).some(specifier => specifier.startsWith("@veyyon/utils/")),
		);
		expect(importers.length).toBeGreaterThan(3);
	});

	test("no engine file reaches into the utils source tree by relative path", () => {
		const offenders: string[] = [];
		for (const file of typeScriptFiles(TUI_SRC)) {
			if (importSpecifiers(file).some(specifier => specifier.includes("../utils/src"))) {
				offenders.push(repoRelative(file));
			}
		}
		expect(offenders).toEqual([]);
	});
});
