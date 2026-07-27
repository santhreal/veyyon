import type { ThemeJson } from "./color";
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };

/**
 * The bundled theme JSON, by name, kept apart from `./theme` so a caller can read a shipped theme
 * without loading the theme engine.
 *
 * WHY THIS FILE EXISTS. `config/settings` needed `isLightTheme` for one legacy migration, and importing
 * it from `./theme` closed an import cycle:
 * `config/settings` -> `modes/theme/theme` -> `./shimmer` -> `config/settings`. A cycle is one strongly
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
 * THE CLASSIFIER MOVED OUT, and the static JSON imports above are the reason. This module embeds one
 * JSON module per bundled theme, so anything importing it pays for all hundred. `config/settings`
 * wanted a single boolean and paid 103 modules for it, and so did every one of the ~1,500 test files
 * that import `Settings`. `./theme-luminance` answers the same question from a small table and is
 * re-exported below, so callers that already had this module keep working unchanged.
 */
export { BUILTIN_THEME_CLASSES, isLightTheme, isLightThemeJson } from "./theme-luminance";

/**
 * Every theme shipped in the binary, by name. `dark` and `light` are the two
 * defaults; the rest come from `./defaults`, which embeds one JSON file per
 * theme at build time.
 */
const BUILTIN_THEMES: Record<string, ThemeJson> = {
	dark: darkThemeJson as ThemeJson,
	light: lightThemeJson as ThemeJson,
	...(defaultThemes as Record<string, ThemeJson>),
};

/** The bundled themes. A function so callers cannot mutate the record. */
export function getBuiltinThemes(): Record<string, ThemeJson> {
	return BUILTIN_THEMES;
}
