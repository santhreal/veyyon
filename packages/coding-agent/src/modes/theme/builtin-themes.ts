import type { ThemeJson } from "./color";
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };

/** The bundled theme JSON, by name, kept apart from `./theme` so a caller can read a shipped theme without loading the theme engine. */
export { BUILTIN_THEME_CLASSES, isLightTheme, isLightThemeJson } from "./theme-luminance";

/** Every theme shipped in the binary, by name. `dark` and `light` are the two defaults; the rest come from `./defaults`, which embeds one JSON file per */
const BUILTIN_THEMES: Record<string, ThemeJson> = {
	dark: darkThemeJson as ThemeJson,
	light: lightThemeJson as ThemeJson,
	...(defaultThemes as Record<string, ThemeJson>),
};

/** The bundled themes. A function so callers cannot mutate the record. */
export function getBuiltinThemes(): Record<string, ThemeJson> {
	return BUILTIN_THEMES;
}
