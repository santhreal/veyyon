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
import * as contextUsagePanel from "@veyyon/coding-agent/modes/utils/context-usage";
import * as contextUsageNumbers from "@veyyon/coding-agent/session/context-usage";
import { moduleSpecifiersIn, namedImportsFrom } from "@veyyon/utils/module-reach";

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
	[
		"modes/components/modal-shell",
		"One width query, `mediumModalContentWidth`, so the ask tool pre-wraps its title to the width of the card the editor draws it in. Wrapping at the terminal width instead hands the card lines it wraps a second time. No card is constructed, rendered or hit-tested here.",
	],
]);

/**
 * Two allowed targets are whole interactive components that also export one thing a tool
 * legitimately needs. Module-level permission is too coarse for those: the entry reads as
 * "the ask tool may ask a card how wide it is" and grants "any tool may render a card".
 * The names below are the ONLY specifiers a tool may take out of each, so widening the
 * crossing is a decision recorded here rather than an import added upstream.
 */
const NARROW = new Map<string, readonly string[]>([
	["modes/components/hook-editor", ["HOOK_EDITOR_TEXT_PAD_COLS"]],
	["modes/components/modal-shell", ["mediumModalContentWidth"]],
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

/** Named specifiers a file takes out of one `src`-relative `modes/` module. */
function namesTakenFrom(file: string, target: string): string[] {
	const source = fs.readFileSync(file, "utf-8");
	const found: string[] = [];
	for (const specifier of moduleSpecifiersIn(source)) {
		if (!specifier.startsWith(".")) continue;
		const rel = path.relative(SRC, path.resolve(path.dirname(file), specifier)).replace(/\\/g, "/");
		if (rel === target) found.push(...namedImportsFrom(source, specifier));
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
	 * The narrow entries stay narrow. Asserted by exact equality per module, so a second
	 * name cannot arrive under a count or a superset match, and a name that stops being
	 * imported has to be struck from the list rather than left reading as sanctioned.
	 */
	it("takes only the sanctioned names out of the two interactive components", () => {
		const taken = new Map<string, string[]>();
		for (const [target] of NARROW) {
			taken.set(target, [...new Set(files.flatMap(file => namesTakenFrom(file, target)))].sort());
		}

		expect(taken).toEqual(new Map([...NARROW].map(([target, names]) => [target, [...names].sort()])));
	});

	/** A narrow rule over a module nobody allowed governs nothing, and reads as if it did. */
	it("narrows only modules the allow-list carries", () => {
		expect([...NARROW.keys()].filter(target => !ALLOWED.has(target))).toEqual([]);
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
	 * Locks out: the token accounting drifting back under `modes/`, where `session/` would have to
	 * import the UI to reach it. `modes/turn-budget` parsed a directive out of message text and
	 * `modes/utils/context-usage` counted tokens; neither drew anything, and both were imported by
	 * `session/`, which is not allowed the UI at all. They live under `session/` now.
	 *
	 * Asserted by IMPORTING the two modules and checking which one exports which function, not by
	 * searching either file's text for `export function ...`. A text search passes when the export is
	 * spelled `export const computeContextBreakdown = (...) =>` and fails on a comment that mentions
	 * the name, so it tests neither direction of the thing it claims.
	 */
	it("the panel exports the drawing and the session module exports the accounting", () => {
		expect(typeof contextUsagePanel.renderContextUsage).toBe("function");
		expect(contextUsagePanel).not.toHaveProperty("computeContextBreakdown");
		expect(typeof contextUsageNumbers.computeContextBreakdown).toBe("function");
	});

	/** And `modes/turn-budget.ts` is gone outright, so a revert cannot hide behind a re-export. */
	it("has no turn budget left under modes", () => {
		expect(fs.existsSync(path.join(SRC, "modes/turn-budget.ts"))).toBe(false);
		expect(fs.existsSync(path.join(SRC, "session/turn-budget.ts"))).toBe(true);
	});

	/**
	 * Locks out: the accounting module importing the panel, which is the failure the whole split was
	 * for, and the panel taking a RUNTIME edge on the accounting, which is the half a re-export left
	 * behind in `modes/` would satisfy while pointing `session/` back at the UI.
	 *
	 * Both directions are stated as runtime specifiers. The panel needs only the SHAPES
	 * (`CategoryId`, `ContextBreakdown`), and a type import is erased, so the observable contract is
	 * that the panel names the accounting at no runtime edge at all. That used to be asserted by
	 * searching the panel's source for one exact `import type { ... }` line, which reflowing the
	 * import or adding a third type to it would have broken for no reason.
	 */
	it("has the panel depending on the numbers only as types, and the numbers on nothing in the UI", () => {
		const panel = path.join(SRC, "modes/utils/context-usage.ts");
		const numbers = path.join(SRC, "session/context-usage.ts");

		expect(uiImportsIn(numbers)).toEqual([]);

		const panelRuntime = moduleSpecifiersIn(fs.readFileSync(panel, "utf-8"));

		expect(panelRuntime).not.toContain("../../session/context-usage");
	});
});
