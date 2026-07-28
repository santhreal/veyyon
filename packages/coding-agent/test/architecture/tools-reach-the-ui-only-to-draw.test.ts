/**
 * `tools/` reaches `modes/` only to draw, and only through named leaves.
 *
 * WHY THIS SUITE EXISTS. A tool is domain code: it runs a command, reads a file,
 * calls a model. It also renders its own output block, so unlike `session/` it
 * cannot be forbidden the UI outright, and that partial permission is exactly how
 * the boundary rots. Thirty-two files under `tools/` import from `modes/` today.
 * Every one of them wanted a colour, a truncation, or a pad width, and each import
 * reads as obviously fine on its own; what nobody checks is whether the module on
 * the other end is a drawing leaf or a whole interactive component that happens to
 * export one constant.
 *
 * The rule this file enforces is therefore narrower than "no UI imports": every
 * target must be on the list below, and the list says what each one is FOR. Adding
 * an entry is a decision someone made in writing, not an import someone slipped in.
 *
 * If you are here because this failed, the move to copy is the one
 * `session-does-not-import-the-ui.test.ts` documents: split the file, detection or
 * measurement into a leaf, drawing left where it was. Two modules went further and
 * left `modes/` entirely, `turn-budget` and `context-usage`, because neither drew
 * anything at all.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

const SRC = path.join(import.meta.dir, "..", "..", "src");
const TOOLS = path.join(SRC, "tools");

/**
 * Every `modes/` module a tool may import, and the drawing job it does.
 *
 * The theme entries are the bulk and the least interesting: a tool that prints a
 * coloured block needs the palette, and the palette is the UI's. The four
 * component entries are the ones worth reading, because a component directory is
 * where a drawing helper hides next to an interactive surface.
 */
const ALLOWED = new Map<string, string>([
	["modes/theme/theme", "The palette and symbol set. What every coloured tool block is coloured with."],
	["modes/theme/theme-binding", "The live `theme` binding, one type and no values."],
	["modes/theme/markdown-theme", "Markdown styling for tools that print markdown."],
	["modes/theme/highlight", "Syntax highlighting for code a tool prints."],
	["modes/theme/shimmer", "The in-progress shimmer, a text effect."],
	["modes/utils/key-hint", "Formats a keybinding as the hint text a block prints. No key handling."],
	["modes/components/visual-truncate", "Truncates rendered output to a line budget. Pure text in, text out."],
	["modes/components/follow", "The hot-tail painter for streaming output. Drawing only."],
	[
		"modes/components/status-line/context-thresholds",
		"Formats a context-usage figure the way the status line does, so a tool that prints one agrees with the gauge.",
	],
	[
		"modes/components/hook-editor",
		"One layout constant, `HOOK_EDITOR_TEXT_PAD_COLS`, so the ask tool's block lines up with the editor above it. The editor itself is never constructed here.",
	],
]);

/** Every `.ts` file under `tools/`, recursively. */
function toolFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...toolFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Specifiers a file imports at runtime, resolved to `src`-relative module paths under `modes/`. */
function uiImportsIn(file: string): string[] {
	const found: string[] = [];
	for (const specifier of moduleSpecifiersIn(fs.readFileSync(file, "utf-8"))) {
		if (!specifier.startsWith(".")) continue;
		const resolved = path.resolve(path.dirname(file), specifier);
		const rel = path.relative(SRC, resolved).replace(/\\/g, "/");
		if (rel.startsWith("modes/")) found.push(rel);
	}
	return found;
}

describe("tools reach the terminal UI only to draw", () => {
	const files = toolFiles(TOOLS);

	/**
	 * Anti-vacuity first. Every assertion below is an absence, so a walker that
	 * found no files, or an extractor that found no imports, would pass all of them.
	 */
	it("reads a real set of tool modules, and they really do import the UI", () => {
		expect(files.length).toBeGreaterThan(50);
		const targets = new Set(files.flatMap(uiImportsIn));

		expect(targets.size).toBeGreaterThan(5);
		expect(targets).toContain("modes/theme/theme");
	});

	/**
	 * The rule. Reported as `file -> module` pairs because the useful information on
	 * failure is which import to look at, not that a count moved.
	 */
	it("imports nothing from modes/ outside the allowed drawing leaves", () => {
		const violations: string[] = [];
		for (const file of files) {
			for (const target of uiImportsIn(file)) {
				if (ALLOWED.has(target)) continue;
				violations.push(`${path.relative(SRC, file)} -> ${target}`);
			}
		}

		expect(violations).toEqual([]);
	});

	/**
	 * The list stays honest. An entry nothing imports any more reads as sanctioned,
	 * so the next person adds an import to it rather than asking whether it should
	 * be a UI module at all.
	 */
	it("has no stale entries in the allow-list", () => {
		const used = new Set(files.flatMap(uiImportsIn));
		const unused = [...ALLOWED.keys()].filter(allowed => !used.has(allowed));

		expect(unused).toEqual([]);
	});

	/**
	 * The two modules that left. `modes/turn-budget` parsed a directive out of
	 * message text and `modes/utils/context-usage` counted tokens; neither drew
	 * anything, and both were imported by `session/`, which is not allowed the UI at
	 * all. They live under `session/` now. Asserted as an absence from `modes/` so a
	 * revert puts them back in front of a reader rather than passing quietly.
	 */
	it.each(["modes/turn-budget.ts", "modes/utils/context-usage.ts"])("%s is not where the numbers live", relative => {
		const inModes = path.join(SRC, relative);
		if (relative === "modes/turn-budget.ts") {
			expect(fs.existsSync(inModes)).toBe(false);
			expect(fs.existsSync(path.join(SRC, "session/turn-budget.ts"))).toBe(true);
			return;
		}
		// The panel kept the name, so this one is checked by what it exports rather
		// than by whether the file is there: drawing stayed, accounting left.
		const source = fs.readFileSync(inModes, "utf-8");

		expect(source).toContain("export function renderContextUsage");
		expect(source).not.toContain("export function computeContextBreakdown");
		expect(fs.readFileSync(path.join(SRC, "session/context-usage.ts"), "utf-8")).toContain(
			"export function computeContextBreakdown",
		);
	});

	/**
	 * And the panel depends on the accounting rather than the other way round. A
	 * re-export left behind in `modes/` would satisfy every check above while
	 * keeping `session/` pointed at the UI, which is the failure this whole split
	 * was for.
	 */
	it("has the panel importing the numbers, not the numbers importing the panel", () => {
		const panel = path.join(SRC, "modes/utils/context-usage.ts");
		const numbers = path.join(SRC, "session/context-usage.ts");

		expect(uiImportsIn(numbers)).toEqual([]);
		// A TYPE import, which `moduleSpecifiersIn` deliberately does not report, so it is
		// read out of the source. That the panel needs only the shapes and no runtime value
		// is the strongest form of the dependency this split was after.
		expect(fs.readFileSync(panel, "utf-8")).toContain(
			'import type { CategoryId, ContextBreakdown } from "../../session/context-usage";',
		);
	});
});
