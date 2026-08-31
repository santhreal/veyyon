/**
 * The active theme's SYMBOLS, read from the live binding without loading the theme engine.
 *
 * WHY THIS IS ITS OWN MODULE, and it is the same argument `./theme-binding` already makes one door
 * along. That module exists so reading the active theme costs one leaf instead of the engine: theme JSON
 * loading, the hundred embedded theme modules, syntax highlighting, mermaid rendering, 281 modules of it.
 * Its doc says to keep it a leaf and warns that a value import of `./theme` puts the engine back in front
 * of every reader.
 *
 * That is exactly what had happened, one function away. `./markdown-theme` took `getSymbolTheme` from
 * `./theme` for one field of the markdown theme it builds, and `./theme` was 144 MARGINAL modules on its
 * graph. `tui/code-cell.ts` renders a markdown cell, `tools/read.ts` renders a code cell, and 54 test
 * files import `read`, so a box-drawing character set dragged the whole presentation layer into every file
 * read. This function needs the binding and a type, nothing else, so it belongs beside the binding.
 *
 * `./theme` re-exports it, so the eight modules that take it from the engine (which reach the engine for
 * other reasons anyway) are unchanged.
 *
 * KEEP THIS A LEAF, for the same reason and with the same discipline: the only imports are the binding
 * and an erased type. `packages/coding-agent/test/architecture/leveraged-imports-stay-cut.test.ts` fails
 * if this module's reach grows past the binding.
 */

import type { SymbolTheme } from "@veyyon/tui";
import { theme } from "./theme-binding";

/**
 * The ASCII preset, returned when no theme has been published yet.
 *
 * WHY A PRESET AND NOT A THROW. `theme` is undefined before the engine loads one and in a plugin running
 * against a second module instance, and both are real (see #2998). The degradation is not silent: ASCII
 * box drawing where Unicode belongs is visible in the rendered output, which is where a reader of this
 * code would look for it. Throwing here would take down a TUI that is otherwise fine.
 */
const ASCII_BOX = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
	cross: "+",
	teeDown: "+",
	teeUp: "+",
	teeLeft: "+",
	teeRight: "+",
} as const;

/** The symbol set the active theme asks for, or the ASCII preset when there is no active theme yet. */
export function getSymbolTheme(): SymbolTheme {
	if (typeof theme === "undefined") {
		return {
			cursor: ">",
			inputCursor: "|",
			boxRound: { ...ASCII_BOX },
			boxSharp: { ...ASCII_BOX },
			table: { ...ASCII_BOX },
			quoteBorder: "|",
			hrChar: "-",
			colorSwatch: "[]",
			spinnerFrames: ["-", "\\", "|", "/"],
		};
	}
	const preset = theme.getSymbolPreset();

	return {
		cursor: theme.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "▏",
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		colorSwatch: theme.md.colorSwatch,
		spinnerFrames: theme.getSpinnerFrames("activity"),
	};
}
