// Theme color model: theme JSON schema, the ThemeColor/ThemeBg token unions,
// variable-reference resolution, and terminal color-mode/ANSI-SGR emission.
// Owned here per the theme boundary split; theme.ts re-exports the public
// surface so external imports are unchanged.

import { SGR_BG_RESET, SGR_FG_RESET } from "@veyyon/utils/ansi";
import { colorLuma } from "@veyyon/utils/color";
import { isRecord } from "@veyyon/utils/type-guards";
import {
	type ColorValue,
	type HexColor,
	type PresentationTheme,
	SPINNER_TYPES,
	type StyleRole,
	SYMBOL_PRESETS,
	type TextStyle,
	THEME_BG_COLORS,
	THEME_COLORS,
	type ThemeBg,
	type ThemeColor,
} from "@veyyon/wire/presentation/theme";
import type { SpinnerFramesOverride } from "./symbols";

export type { ColorValue, HexColor, StyleRole, TextStyle, ThemeBg, ThemeColor };
export { THEME_BG_COLORS, THEME_COLORS };

// ============================================================================
// Types & Schema
// ============================================================================
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

function isColorValue(value: unknown): value is ColorValue {
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

/**
 * Validate a PresentationTheme snapshot before constructing or applying a Theme.
 * Rejects invalid, missing required, or inconsistent properties.
 */
export function validatePresentationTheme(value: unknown): asserts value is PresentationTheme {
	if (!isRecord(value)) {
		throw new Error("PresentationTheme must be an object");
	}
	if (typeof value.id !== "string" || value.id.length === 0) {
		throw new Error('PresentationTheme "id" must be a non-empty string');
	}
	if (typeof value.name !== "string" || value.name.length === 0) {
		throw new Error('PresentationTheme "name" must be a non-empty string');
	}
	if (value.appearance !== "light" && value.appearance !== "dark") {
		throw new Error('PresentationTheme "appearance" must be "light" or "dark"');
	}
	if (typeof value.symbolPreset !== "string" || !(SYMBOL_PRESETS as readonly string[]).includes(value.symbolPreset)) {
		throw new Error('PresentationTheme "symbolPreset" must be "unicode", "nerd" or "ascii"');
	}
	if (!isRecord(value.colors)) {
		throw new Error('PresentationTheme "colors" must be an object');
	}
	if (!isRecord(value.backgrounds)) {
		throw new Error('PresentationTheme "backgrounds" must be an object');
	}

	for (const token of THEME_COLORS) {
		if (value.colors[token] === undefined) {
			throw new Error(`PresentationTheme missing required color: ${token}`);
		}
		if (!isColorValue(value.colors[token])) {
			throw new Error(`PresentationTheme "colors.${token}" must be a string or number`);
		}
	}

	for (const token of THEME_BG_COLORS) {
		if (value.backgrounds[token] === undefined) {
			throw new Error(`PresentationTheme missing required background: ${token}`);
		}
		if (!isColorValue(value.backgrounds[token])) {
			throw new Error(`PresentationTheme "backgrounds.${token}" must be a string or number`);
		}
	}

	// Verify appearance consistency if statusLineBg is evaluatable
	const statusLineBg = value.backgrounds.statusLineBg;
	if (isColorValue(statusLineBg)) {
		const luma = colorLuma(statusLineBg);
		if (luma !== undefined) {
			const expectedAppearance = luma > 0.5 ? "light" : "dark";
			if (value.appearance !== expectedAppearance) {
				throw new Error(
					`PresentationTheme appearance mismatch: declared "${value.appearance}" but statusLineBg resolves to "${expectedAppearance}"`,
				);
			}
		}
	}

	if (value.symbolOverrides !== undefined) {
		if (!isRecord(value.symbolOverrides) || !Object.values(value.symbolOverrides).every(v => typeof v === "string")) {
			throw new Error('PresentationTheme "symbolOverrides" must map symbol keys to strings');
		}
	}

	if (value.spinnerFrames !== undefined) {
		if (!isRecord(value.spinnerFrames)) {
			throw new Error('PresentationTheme "spinnerFrames" must be an object');
		}
		for (const [type, frames] of Object.entries(value.spinnerFrames)) {
			if (!(SPINNER_TYPES as readonly string[]).includes(type)) {
				throw new Error(`Invalid spinner type in spinnerFrames: ${type}`);
			}
			if (!isSpinnerFrameList(frames)) {
				throw new Error(`PresentationTheme "spinnerFrames.${type}" must be a non-empty string array`);
			}
		}
	}

	if (value.groundHex !== undefined && typeof value.groundHex !== "string") {
		throw new Error('PresentationTheme "groundHex" must be a string');
	}

	if (value.styles !== undefined) {
		if (!isRecord(value.styles)) {
			throw new Error('PresentationTheme "styles" must be an object');
		}
		for (const [token, style] of Object.entries(value.styles)) {
			if (!isValidThemeColor(token)) {
				throw new Error(`Invalid theme color in styles: ${token}`);
			}
			if (!isRecord(style)) {
				throw new Error(`PresentationTheme "styles.${token}" must be a TextStyle object`);
			}
			for (const [k, v] of Object.entries(style)) {
				if (!["bold", "dim", "italic", "underline", "inverse", "strikethrough"].includes(k)) {
					throw new Error(`Invalid style attribute in styles.${token}: ${k}`);
				}
				if (v !== undefined && typeof v !== "boolean") {
					throw new Error(`PresentationTheme "styles.${token}.${k}" must be a boolean`);
				}
			}
		}
	}
}

const VALID_THEME_COLORS: ReadonlySet<string> = new Set<string>(THEME_COLORS);

/** Check if a string is a valid ThemeColor value */
export function isValidThemeColor(color: string): color is ThemeColor {
	return VALID_THEME_COLORS.has(color);
}

const VALID_THEME_BG_COLORS: ReadonlySet<string> = new Set<string>(THEME_BG_COLORS);

/** Check if a string is a valid ThemeBg value */
export function isValidThemeBg(color: string): color is ThemeBg {
	return VALID_THEME_BG_COLORS.has(color);
}

/**
 * Every color token a theme file must carry: both unions minus the optional list.
 */
export const REQUIRED_THEME_COLOR_TOKENS: readonly RequiredThemeColorToken[] = [
	...THEME_COLORS,
	...THEME_BG_COLORS,
].filter(
	(token): token is RequiredThemeColorToken => !(OPTIONAL_THEME_COLOR_TOKENS as readonly string[]).includes(token),
);

/**
 * Defaults for the optional identity/state accent tokens, keyed by the token,
 * naming the token it defaults to. Single owner of that fallback chain.
 */
export const QUIET_TOKEN_DEFAULTS: Partial<Record<ThemeColor, ThemeColor>> = {
	sessionAccent: "accent",
	modeAccent: "accent",
	shareAccent: "link",
	infoAccent: "muted",
	matchHighlight: "warning",
};

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
