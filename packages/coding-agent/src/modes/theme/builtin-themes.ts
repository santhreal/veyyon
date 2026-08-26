import type { ThemeJson } from "./color";
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };

/**
 * The bundled theme JSON, by name, kept apart from `./theme` so a caller can read a shipped theme
 * without loading the engine. Exists to break an import cycle: `config/settings` -> `./theme` ->
 * `./shimmer` -> `config/settings` was one SCC costing 51 MB, re-instantiated ~1,800 times per test
 * run. Nothing here may import `config/settings`, `./theme`, `./shimmer`, or `./theme-class`. The
 * classifier moved to `./theme-luminance` (a small table, not 103 JSON modules); re-exported below.
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
