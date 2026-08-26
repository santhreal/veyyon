/**
 * The active theme's SYMBOLS, read from the live binding without loading the theme engine. Same
 * argument as `./theme-binding`: `./markdown-theme` took `getSymbolTheme` from `./theme` (144 marginal
 * modules), dragging the presentation layer into every file read via `tools/read.ts`. This leaf needs
 * only the binding and a type. `./theme` re-exports it. KEEP THIS A LEAF —
 * `test/architecture/leveraged-imports-stay-cut.test.ts` fails if reach grows past the binding.
 */

import type { SymbolTheme } from "@veyyon/tui";
import { theme } from "./theme-binding";

/**
 * The ASCII preset, returned when no theme has been published yet. `theme` is undefined before the
 * engine loads one and in a plugin running against a second module instance (see #2998). Not silent:
 * ASCII box drawing is visible. Throwing would take down a TUI that is otherwise fine.
 */
const ASCII_BOX = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
	teeDown: "+",
	teeUp: "+",
	teeLeft: "+",
	teeRight: "+",
	cross: "+",
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
