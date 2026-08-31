import type { ThemeJson } from "./color";
import darkThemeText from "./dark.json" with { type: "text" };
import { DEFAULT_THEME_NAMES, getDefaultTheme, getDefaultThemes } from "./defaults";
import lightThemeText from "./light.json" with { type: "text" };

/**
 * The bundled theme JSON, by name, kept apart from `./theme` so a caller can read a shipped theme
 * without loading the theme engine.
 *
 * WHY THIS FILE EXISTS. `config/settings` needed `isLightTheme` for one legacy migration, and importing
 * it from `./theme` closed an import cycle:
 * `config/settings` -> `theme/theme` -> `./shimmer` -> `config/settings`. A cycle is one strongly
 * connected component, so every module in it has to be instantiated as a unit, and measuring the cost
 * said so plainly: importing `config/settings` into a file cost 51 MB, and so did importing `shimmer`,
 * or `discovery`, or `theme`, all of them the same number because they were the same component. Since
 * the test runner gives every test file a fresh realm, the whole component was re-instantiated about
 * 1,800 times in a full run, which is what exhausted memory.
 *
 * Nothing here may import `config/settings`, directly or transitively, or the cycle comes back.
 * `./color`, `./defaults` and `./theme-luminance` are safe; `./theme`, `./shimmer` and `./theme-class`
 * are not.
 *
 * THE CLASSIFIER MOVED OUT, and the JSON imports were the reason. This module embeds one file per
 * bundled theme, so anything importing it used to pay for all hundred. `config/settings`
 * wanted a single boolean and paid 103 modules for it, and so did every one of the ~1,500 test files
 * that import `Settings`. `./theme-luminance` answers the same question from a small table and is
 * re-exported below, so callers that already had this module keep working unchanged.
 *
 * What remains of that cost is now deferred: `./defaults` embeds each theme as text and parses one
 * on demand, and `dark` and `light` are read the same way here. A launch resolves a single name, so
 * it builds a single theme object; {@link getBuiltinThemes} parses the rest only when a caller
 * enumerates them.
 */
export { BUILTIN_THEME_CLASSES, isLightTheme, isLightThemeJson } from "./theme-luminance";

// Cast for the same reason as `./defaults`: the import attribute, not the specifier, decides that
// these are the files' text.
const ROOT_THEME_TEXT = { dark: darkThemeText, light: lightThemeText } as unknown as Readonly<Record<string, string>>;
const rootThemes = new Map<string, ThemeJson>();

/** Every theme name shipped in the binary. `dark` and `light` first, then the bundled set. */
export function getBuiltinThemeNames(): string[] {
	return [...Object.keys(ROOT_THEME_TEXT), ...DEFAULT_THEME_NAMES];
}

/** Whether a name is a shipped theme. Parses nothing. */
export function hasBuiltinTheme(name: string): boolean {
	return name in ROOT_THEME_TEXT || DEFAULT_THEME_NAMES.includes(name);
}

/** One shipped theme by name, parsed on first ask and shared after it. */
export function getBuiltinTheme(name: string): ThemeJson | undefined {
	const memo = rootThemes.get(name);
	if (memo !== undefined) return memo;
	const text = ROOT_THEME_TEXT[name];
	if (text === undefined) return getDefaultTheme(name);
	const theme = JSON.parse(text) as ThemeJson;
	rootThemes.set(name, theme);
	return theme;
}

/**
 * Every theme shipped in the binary, by name, parsed. For a caller that enumerates them, such as
 * the theme picker; a caller resolving one name wants {@link getBuiltinTheme}.
 */
export function getBuiltinThemes(): Record<string, ThemeJson> {
	return {
		dark: getBuiltinTheme("dark") as ThemeJson,
		light: getBuiltinTheme("light") as ThemeJson,
		...getDefaultThemes(),
	};
}
