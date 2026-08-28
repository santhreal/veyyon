/** The active theme's SYMBOLS, read from the live binding without loading the theme engine. along. That module exists so reading the active theme costs one leaf instead of the engine: theme JSON */

import type { SymbolTheme } from "@veyyon/tui";
import { theme } from "./theme-binding";

/** The ASCII preset, returned when no theme has been published yet. against a second module instance, and both are real (see #2998). The degradation is not silent: ASCII */
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
