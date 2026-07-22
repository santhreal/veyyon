// Theme color model: theme JSON schema, the ThemeColor/ThemeBg token unions,
// variable-reference resolution, and terminal color-mode/ANSI-SGR emission.
// Owned here per the theme boundary split; theme.ts re-exports the public
// surface so external imports are unchanged.

import { type } from "arktype";
import type { SpinnerFramesOverride } from "./symbols";

// ============================================================================
// Types & Schema
// ============================================================================

export type ColorValue = string | number;

// Schema construction is deferred: building these arktype schemas costs
// ~15ms at import time, yet they are only needed when validating a CUSTOM
// theme JSON file (builtin themes bypass validation). getThemeJsonSchema()
// builds once on first use.
function buildThemeJsonSchema() {
	const themeColorsSchema = type({
		accent: "string | number",
		border: "string | number",
		borderAccent: "string | number",
		borderMuted: "string | number",
		success: "string | number",
		error: "string | number",
		warning: "string | number",
		muted: "string | number",
		dim: "string | number",
		text: "string | number",
		thinkingText: "string | number",
		selectedBg: "string | number",
		userMessageBg: "string | number",
		userMessageText: "string | number",
		customMessageBg: "string | number",
		customMessageText: "string | number",
		customMessageLabel: "string | number",
		toolPendingBg: "string | number",
		toolSuccessBg: "string | number",
		toolErrorBg: "string | number",
		toolTitle: "string | number",
		toolOutput: "string | number",
		mdHeading: "string | number",
		mdLink: "string | number",
		mdLinkUrl: "string | number",
		"link?": "string | number",
		mdCode: "string | number",
		mdCodeBlock: "string | number",
		mdCodeBlockBorder: "string | number",
		mdQuote: "string | number",
		mdQuoteBorder: "string | number",
		mdHr: "string | number",
		mdListBullet: "string | number",
		toolDiffAdded: "string | number",
		toolDiffRemoved: "string | number",
		toolDiffContext: "string | number",
		syntaxComment: "string | number",
		syntaxKeyword: "string | number",
		syntaxFunction: "string | number",
		syntaxVariable: "string | number",
		syntaxString: "string | number",
		syntaxNumber: "string | number",
		syntaxType: "string | number",
		syntaxOperator: "string | number",
		syntaxPunctuation: "string | number",
		thinkingOff: "string | number",
		thinkingMinimal: "string | number",
		thinkingLow: "string | number",
		thinkingMedium: "string | number",
		thinkingHigh: "string | number",
		thinkingXhigh: "string | number",
		"thinkingMax?": "string | number",
		bashMode: "string | number",
		pythonMode: "string | number",
		statusLineBg: "string | number",
		statusLineSep: "string | number",
		statusLineModel: "string | number",
		statusLinePath: "string | number",
		statusLineGitClean: "string | number",
		statusLineGitDirty: "string | number",
		statusLineContext: "string | number",
		statusLineSpend: "string | number",
		statusLineStaged: "string | number",
		statusLineDirty: "string | number",
		statusLineUntracked: "string | number",
		statusLineOutput: "string | number",
		statusLineCost: "string | number",
		statusLineSubagents: "string | number",
		// Identity/state accent tokens (the design system's cool arc) plus the
		// match highlight (warm arc). Optional: themes that predate them get the
		// documented load-time defaults (see QUIET_TOKEN_DEFAULTS in theme.ts).
		"sessionAccent?": "string | number",
		"modeAccent?": "string | number",
		"shareAccent?": "string | number",
		"infoAccent?": "string | number",
		"matchHighlight?": "string | number",
		// Composer quiet-card ground (DS-6 layer 0). Optional: themes that omit
		// it inherit statusLineBg (see QUIET_TOKEN_DEFAULTS in theme.ts).
		"composerBg?": "string | number",
	});
	const spinnerFramesSchema = type("unknown").narrow((value): value is SpinnerFramesOverride => {
		if (Array.isArray(value)) {
			return value.length >= 1 && value.every(item => typeof item === "string");
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			const entries = [obj.status, obj.activity, obj.thinking];
			if (entries.every(entry => entry === undefined)) return false;
			for (const entry of entries) {
				if (entry === undefined) continue;
				if (!Array.isArray(entry) || entry.length < 1 || !entry.every(item => typeof item === "string")) {
					return false;
				}
			}
			return true;
		}
		return false;
	});
	return type({
		"$schema?": "string",
		name: "string",
		"vars?": "Record<string, string | number>",
		colors: themeColorsSchema,
		"export?": {
			"pageBg?": "string | number",
			"cardBg?": "string | number",
			"infoBg?": "string | number",
		},
		"symbols?": {
			"preset?": "'unicode' | 'nerd' | 'ascii'",
			"overrides?": "Record<string, string>",
			"spinnerFrames?": spinnerFramesSchema,
		},
	});
}

let themeJsonSchemaCache: ReturnType<typeof buildThemeJsonSchema> | undefined;

/** The theme JSON validator, built lazily on first custom-theme load. */
export function getThemeJsonSchema(): ReturnType<typeof buildThemeJsonSchema> {
	themeJsonSchemaCache ??= buildThemeJsonSchema();
	return themeJsonSchemaCache;
}

export type ThemeJson = ReturnType<typeof buildThemeJsonSchema>["infer"];

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
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (typeof color === "string") {
		return colorToAnsi(color, mode);
	}
	throw new Error(`Invalid color value: ${color}`);
}

export function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
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
