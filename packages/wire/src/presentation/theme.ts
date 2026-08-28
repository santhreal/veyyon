/**
 * Abstract theme contract: named roles with hex colours, so the same theme
 * drives a terminal that quantizes to 256 colours and a browser that does not.
 *
 * Colours are `#rrggbb` strings. Nothing here knows about ANSI, SGR, CSS
 * variables or terminal capability — a renderer converts on the way out.
 */

/** A colour in `#rrggbb` form. Lowercase hex, always six digits. */
export type HexColor = string;

/** How a run of text is weighted, independent of colour. */
export interface TextStyle {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	dim?: boolean;
}

/** A foreground colour with optional background and weight. */
export interface StyleRole {
	fg: HexColor;
	bg?: HexColor;
	style?: TextStyle;
}

/** Colour roles the transcript uses. */
export interface TranscriptPalette {
	userMessage: StyleRole;
	assistantMessage: StyleRole;
	thinking: StyleRole;
	toolName: StyleRole;
	toolInput: StyleRole;
	toolOutput: StyleRole;
	toolError: StyleRole;
	diffAdded: StyleRole;
	diffRemoved: StyleRole;
	diffContext: StyleRole;
	summary: StyleRole;
}

/** Colour roles the chrome around the transcript uses. */
export interface ChromePalette {
	background: HexColor;
	foreground: HexColor;
	border: StyleRole;
	statusLine: StyleRole;
	composer: StyleRole;
	placeholder: StyleRole;
	selection: StyleRole;
	accent: StyleRole;
	success: StyleRole;
	warning: StyleRole;
	error: StyleRole;
	muted: StyleRole;
}

/** Colour roles syntax highlighting uses. A renderer without a highlighter ignores them. */
export interface SyntaxPalette {
	keyword: StyleRole;
	string: StyleRole;
	number: StyleRole;
	comment: StyleRole;
	function: StyleRole;
	type: StyleRole;
	variable: StyleRole;
	operator: StyleRole;
	punctuation: StyleRole;
}

export interface PresentationTheme {
	/** Stable identifier, e.g. `"gruvbox-dark"`. */
	id: string;
	name: string;
	/** Which ground the palette was designed for. Drives a renderer's own defaults. */
	appearance: "light" | "dark";
	chrome: ChromePalette;
	transcript: TranscriptPalette;
	syntax: SyntaxPalette;
}
