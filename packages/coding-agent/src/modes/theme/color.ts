// Theme color model: theme JSON schema, the ThemeColor/ThemeBg token unions,
// variable-reference resolution, and terminal color-mode/ANSI-SGR emission.
// Owned here per the theme boundary split; theme.ts re-exports the public
// surface so external imports are unchanged.

import { parseHexColor } from "@veyyon/tui";
import { SGR_BG_RESET, SGR_FG_RESET } from "@veyyon/tui/ansi";
import { isRecord } from "@veyyon/utils/type-guards";
import type { SpinnerFramesOverride } from "./symbols";

// ============================================================================
// Types & Schema
// ============================================================================

export type ColorValue = string | number;

/**
 * A theme file, as a custom theme on disk is allowed to be written.
 *
 * Declared rather than inferred from a schema library. The library was reached at module load
 * for the sake of validating a file that only a custom theme has, and its own evaluation is
 * 362ms before a single schema is built -- paid by every launch, because the theme module is on
 * the path that draws the first frame. The token lists below carry a `satisfies` proof that the
 * runtime key sets and the compile-time unions are the same set, which is what the schema was
 * really providing.
 */
export interface ThemeJson {
	$schema?: string;
	name: string;
	vars?: Record<string, ColorValue>;
	colors: ThemeJsonColors;
	export?: {
		pageBg?: ColorValue;
		cardBg?: ColorValue;
		infoBg?: ColorValue;
	};
	symbols?: {
		preset?: "unicode" | "nerd" | "ascii";
		overrides?: Record<string, string>;
		spinnerFrames?: SpinnerFramesOverride;
	};
}

/**
 * Color tokens a theme file may leave out; every other token in `ThemeColor | ThemeBg` is
 * required. A token added to this list stops being required, which is the whole reason the list
 * is one array and not a `?` sprinkled across seventy lines.
 */
export const OPTIONAL_THEME_COLOR_TOKENS = [
	"link",
	"thinkingMax",
	"sessionAccent",
	"modeAccent",
	"shareAccent",
	"infoAccent",
	"matchHighlight",
	"composerBg",
] as const satisfies readonly (ThemeColor | ThemeBg)[];

type OptionalThemeColorToken = (typeof OPTIONAL_THEME_COLOR_TOKENS)[number];
type RequiredThemeColorToken = Exclude<ThemeColor | ThemeBg, OptionalThemeColorToken>;

/**
 * A theme file's `colors` object.
 *
 * An alias and not an interface: callers pass it where a `Record<string, ColorValue>` is wanted,
 * and TypeScript grants an implicit index signature to an alias of a mapped type but never to an
 * interface.
 */
export type ThemeJsonColors = Record<RequiredThemeColorToken, ColorValue> &
	Partial<Record<OptionalThemeColorToken, ColorValue>>;

/**
 * What a theme file got wrong, or nothing.
 *
 * Missing colors are separated from the rest because the reader tells a theme author which
 * tokens to add, and the previous code recovered that list by running a regular expression over
 * a validator's prose summary.
 */
export interface ThemeJsonProblems {
	missingColors: string[];
	problems: string[];
}

function isColorValue(value: unknown): boolean {
	return typeof value === "string" || typeof value === "number";
}

function isColorValueRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(isColorValue);
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(entry => typeof entry === "string");
}

function isSpinnerFrameList(value: unknown): boolean {
	return Array.isArray(value) && value.length >= 1 && value.every(item => typeof item === "string");
}

/** A frame list, or a named set of them with at least one lane declared. */
function isSpinnerFramesOverride(value: unknown): value is SpinnerFramesOverride {
	if (isSpinnerFrameList(value)) {
		return true;
	}
	if (!isRecord(value)) {
		return false;
	}
	const lanes = [value.status, value.activity, value.thinking];
	if (lanes.every(lane => lane === undefined)) {
		return false;
	}
	return lanes.every(lane => lane === undefined || isSpinnerFrameList(lane));
}

/**
 * Checks a parsed theme file. Both lists empty means the value is a {@link ThemeJson}.
 *
 * Unknown keys pass, as they did before: a theme written for a newer build carries tokens this
 * one has never heard of, and refusing the file would make an upgrade the only way to open it.
 */
export function validateThemeJson(value: unknown): ThemeJsonProblems {
	const problems: string[] = [];
	const missingColors: string[] = [];

	if (!isRecord(value)) {
		return { missingColors, problems: ["the file is not a JSON object"] };
	}
	if (typeof value.name !== "string") {
		problems.push('"name" must be a string');
	}
	if (value.$schema !== undefined && typeof value.$schema !== "string") {
		problems.push('"$schema" must be a string');
	}
	if (value.vars !== undefined && !isColorValueRecord(value.vars)) {
		problems.push('"vars" must map each name to a string or a number');
	}

	const colors = value.colors;
	if (!isRecord(colors)) {
		problems.push('"colors" must be an object');
	} else {
		for (const token of REQUIRED_THEME_COLOR_TOKENS) {
			if (colors[token] === undefined) {
				missingColors.push(token);
			} else if (!isColorValue(colors[token])) {
				problems.push(`"colors.${token}" must be a string or a number`);
			}
		}
		for (const token of OPTIONAL_THEME_COLOR_TOKENS) {
			if (colors[token] !== undefined && !isColorValue(colors[token])) {
				problems.push(`"colors.${token}" must be a string or a number`);
			}
		}
	}

	const exported = value.export;
	if (exported !== undefined) {
		if (!isRecord(exported)) {
			problems.push('"export" must be an object');
		} else {
			for (const key of ["pageBg", "cardBg", "infoBg"] as const) {
				if (exported[key] !== undefined && !isColorValue(exported[key])) {
					problems.push(`"export.${key}" must be a string or a number`);
				}
			}
		}
	}

	const symbols = value.symbols;
	if (symbols !== undefined) {
		if (!isRecord(symbols)) {
			problems.push('"symbols" must be an object');
		} else {
			if (
				symbols.preset !== undefined &&
				(typeof symbols.preset !== "string" || !["unicode", "nerd", "ascii"].includes(symbols.preset))
			) {
				problems.push('"symbols.preset" must be "unicode", "nerd" or "ascii"');
			}
			if (symbols.overrides !== undefined && !isStringRecord(symbols.overrides)) {
				problems.push('"symbols.overrides" must map each name to a string');
			}
			if (symbols.spinnerFrames !== undefined && !isSpinnerFramesOverride(symbols.spinnerFrames)) {
				problems.push(
					'"symbols.spinnerFrames" must be a non-empty list of strings, or name at least one of status, activity, thinking with one',
				);
			}
		}
	}

	return { missingColors, problems };
}

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "link"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode"
	| "pythonMode"
	| "statusLineSep"
	| "statusLineModel"
	| "statusLinePath"
	| "statusLineGitClean"
	| "statusLineGitDirty"
	| "statusLineContext"
	| "statusLineSpend"
	| "statusLineStaged"
	| "statusLineDirty"
	| "statusLineUntracked"
	| "statusLineOutput"
	| "statusLineCost"
	| "statusLineSubagents"
	| "sessionAccent"
	| "modeAccent"
	| "shareAccent"
	| "infoAccent"
	| "matchHighlight";

/** Set of all valid ThemeColor string values for runtime validation */
const THEME_COLOR_RECORD = {
	accent: true,
	border: true,
	borderAccent: true,
	borderMuted: true,
	success: true,
	error: true,
	warning: true,
	muted: true,
	dim: true,
	text: true,
	thinkingText: true,
	userMessageText: true,
	customMessageText: true,
	customMessageLabel: true,
	toolTitle: true,
	toolOutput: true,
	mdHeading: true,
	mdLink: true,
	mdLinkUrl: true,
	link: true,
	mdCode: true,
	mdCodeBlock: true,
	mdCodeBlockBorder: true,
	mdQuote: true,
	mdQuoteBorder: true,
	mdHr: true,
	mdListBullet: true,
	toolDiffAdded: true,
	toolDiffRemoved: true,
	toolDiffContext: true,
	syntaxComment: true,
	syntaxKeyword: true,
	syntaxFunction: true,
	syntaxVariable: true,
	syntaxString: true,
	syntaxNumber: true,
	syntaxType: true,
	syntaxOperator: true,
	syntaxPunctuation: true,
	thinkingOff: true,
	thinkingMinimal: true,
	thinkingLow: true,
	thinkingMedium: true,
	thinkingHigh: true,
	thinkingXhigh: true,
	thinkingMax: true,
	bashMode: true,
	pythonMode: true,
	statusLineSep: true,
	statusLineModel: true,
	statusLinePath: true,
	statusLineGitClean: true,
	statusLineGitDirty: true,
	statusLineContext: true,
	statusLineSpend: true,
	statusLineStaged: true,
	statusLineDirty: true,
	statusLineUntracked: true,
	statusLineOutput: true,
	statusLineCost: true,
	statusLineSubagents: true,
	sessionAccent: true,
	modeAccent: true,
	shareAccent: true,
	infoAccent: true,
	matchHighlight: true,
} satisfies Record<ThemeColor, true>;

const VALID_THEME_COLORS: ReadonlySet<string> = new Set(Object.keys(THEME_COLOR_RECORD));

/** Check if a string is a valid ThemeColor value */
export function isValidThemeColor(color: string): color is ThemeColor {
	return VALID_THEME_COLORS.has(color);
}

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "statusLineBg"
	| "composerBg";

/** Set of all valid ThemeBg string values, and the runtime half of the required-token list. */
const THEME_BG_RECORD = {
	selectedBg: true,
	userMessageBg: true,
	customMessageBg: true,
	toolPendingBg: true,
	toolSuccessBg: true,
	toolErrorBg: true,
	statusLineBg: true,
	composerBg: true,
} satisfies Record<ThemeBg, true>;

/**
 * Every color token a theme file must carry: both unions minus the optional list.
 *
 * Derived from the two `satisfies Record<..., true>` tables rather than written out again, so a
 * token added to either union is required by this validator without anyone remembering to add
 * it here. The `satisfies` on the result is the proof that the derivation stayed a subset.
 */
export const REQUIRED_THEME_COLOR_TOKENS: readonly RequiredThemeColorToken[] = [
	...Object.keys(THEME_COLOR_RECORD),
	...Object.keys(THEME_BG_RECORD),
].filter(
	(token): token is RequiredThemeColorToken => !(OPTIONAL_THEME_COLOR_TOKENS as readonly string[]).includes(token),
);

export type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

export function detectColorMode(): ColorMode {
	const colorterm = Bun.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	// Windows Terminal supports truecolor
	if (Bun.env.WT_SESSION) {
		return "truecolor";
	}
	const term = Bun.env.TERM || "";
	// Only fall back to 256color for truly limited terminals
	if (term === "dumb" || term === "" || term === "linux") {
		return "256color";
	}
	// Assume truecolor for everything else - virtually all modern terminals support it
	return "truecolor";
}

export function colorToAnsi(color: string, mode: ColorMode): string {
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const ansi = Bun.color(color, format);
	if (ansi === null) {
		throw new Error(`Invalid color value: ${color}`);
	}
	return ansi;
}

export function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return SGR_FG_RESET;
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (typeof color === "string") {
		return colorToAnsi(color, mode);
	}
	throw new Error(`Invalid color value: ${color}`);
}

export function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return SGR_BG_RESET;
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	const ansi = colorToAnsi(color, mode);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

export function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

export function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

/**
 * Resolve a theme color value (hex string or 256-color index) to a CSS hex string.
 * Empty string represents the default terminal color.
 */
export function resolveToHex(value: string | number, isLight: boolean): string {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return isLight ? "#000000" : "#e5e5e7";
	return value;
}

/**
 * How much colour a hex carries: the spread between its strongest and weakest
 * channel, 0..255. A grey has none, a saturated hue has a lot.
 *
 * This exists because a theme token's NAME does not tell you whether it will
 * read as a colour. `titanium` maps `accent` to `#C6CBD4`, a cool grey with a
 * chroma of 14, so every cue the code paints "in the accent" — the selection
 * cursor, the selected label, the settings kicker diamond — arrived on screen
 * as grey text on grey, and the only warm pixels on a card came from
 * `borderAccent` on the frame. Chroma is the measurable property those cues
 * actually depend on, so the fallback is decided by measuring it rather than by
 * special-casing a theme by name.
 *
 * Unparseable input scores 0: a token that resolved to nothing cannot be
 * claimed to carry colour.
 */
export function hexChroma(hex: string): number {
	const rgb = parseHexColor(hex);
	if (rgb === null) return 0;
	return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
}

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
export function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}
