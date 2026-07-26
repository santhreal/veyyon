import * as fs from "node:fs";
import * as path from "node:path";
import { colorLuma, getCustomThemesDir } from "@veyyon/utils";
import { resolveVarRefs, type ThemeJson } from "./color";
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
import lightThemeJson from "./light.json" with { type: "json" };

/**
 * The bundled themes and the synchronous light/dark classifier, kept apart from
 * `./theme` so a caller can ask "is this theme light?" without loading the theme
 * engine.
 *
 * WHY THIS FILE EXISTS. `config/settings` needs `isLightTheme` for one legacy
 * migration, and importing it from `./theme` closed an import cycle:
 * `config/settings` -> `modes/theme/theme` -> `./shimmer` -> `config/settings`.
 * A cycle is one strongly connected component, so every module in it has to be
 * instantiated as a unit. That is why `config/settings`, `shimmer`, `discovery`
 * and `theme` all reported the identical cost when measured separately: they were
 * one thing wearing four names. Reaching any of them meant loading all of them,
 * plus everything they import.
 *
 * Nothing here may import `config/settings`, directly or transitively, or the
 * cycle comes back. `./color` and `./defaults` are safe; `./theme`,
 * `./shimmer` and `./theme-class` are not.
 */

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

/**
 * Classify a parsed theme JSON as light/dark by the perceived luminance of its
 * status-line background. Mirrors {@link Theme.isLight} so the synchronous
 * helpers stay in lockstep with the runtime classifier. See the comment on
 * `Theme.statusLineLuminance` for why `statusLineBg` is the source of truth
 * (themes like `porcelain` style a dark chat bubble on an otherwise-light
 * theme, so `userMessageBg` is unreliable).
 */
export function isLightThemeJson(themeJson: ThemeJson): boolean {
	try {
		const resolved = resolveVarRefs(themeJson.colors.statusLineBg, themeJson.vars ?? {});
		const luminance = colorLuma(resolved);
		return luminance !== undefined && luminance > 0.5;
	} catch {
		// A theme whose status-line background cannot be resolved gets classified as dark, which is the
		// same answer an unreadable luminance gives above. Dark is the safe default because it is the
		// shipped default, and the load path reports the malformed theme with its parse error.
		return false;
	}
}

/**
 * Check if a theme is a "light" theme by analyzing its status-line background
 * luminance. Loads theme JSON synchronously (built-in or custom file on disk)
 * for callers in synchronous flows (settings migration, setup wizard).
 */
export function isLightTheme(themeName?: string): boolean {
	const name = themeName ?? "dark";
	const builtinThemes = getBuiltinThemes();
	let themeJson: ThemeJson | undefined;
	if (name in builtinThemes) {
		themeJson = builtinThemes[name];
	} else {
		try {
			const customPath = path.join(getCustomThemesDir(), `${name}.json`);
			const content = fs.readFileSync(customPath, "utf-8");
			themeJson = JSON.parse(content) as ThemeJson;
		} catch {
			// Classified as dark rather than reported, deliberately: this is a synchronous classifier called
			// on render paths, and the theme's LOAD reports the same broken file once with its error. A
			// warning here would repeat it for every frame.
			return false;
		}
	}
	return isLightThemeJson(themeJson);
}
