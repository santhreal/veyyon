import * as fs from "node:fs";
import * as path from "node:path";
import { colorLuma } from "@veyyon/utils/color";
import { getCustomThemesDir } from "@veyyon/utils/dirs";
import { resolveVarRefs, type ThemeJson } from "./color";

/** The synchronous light/dark classifier, and the one place a bundled theme's class is written down. migration: an old flat `theme: "<name>"` string has to be placed in the `theme.light` or `theme.dark` */

/** Whether a bundled theme is light or dark, by name. Generated from the shipped theme JSON by `isLightThemeJson`, which reads the perceived luminance of */
export const BUILTIN_THEME_CLASSES: Readonly<Record<string, "light" | "dark">> = {
	alabaster: "light",
	amethyst: "dark",
	anthracite: "dark",
	basalt: "dark",
	birch: "light",
	dark: "dark",
	"dark-abyss": "dark",
	"dark-arctic": "dark",
	"dark-aurora": "dark",
	"dark-catppuccin": "dark",
	"dark-cavern": "dark",
	"dark-copper": "dark",
	"dark-cosmos": "dark",
	"dark-cyberpunk": "dark",
	"dark-dracula": "dark",
	"dark-eclipse": "dark",
	"dark-ember": "dark",
	"dark-equinox": "dark",
	"dark-forest": "dark",
	"dark-github": "dark",
	"dark-gruvbox": "dark",
	"dark-lavender": "dark",
	"dark-lunar": "dark",
	"dark-midnight": "dark",
	"dark-monochrome": "dark",
	"dark-monokai": "dark",
	"dark-nebula": "dark",
	"dark-nord": "dark",
	"dark-ocean": "dark",
	"dark-one": "dark",
	"dark-poimandres": "dark",
	"dark-rainforest": "dark",
	"dark-reef": "dark",
	"dark-retro": "dark",
	"dark-rose-pine": "dark",
	"dark-sakura": "dark",
	"dark-slate": "dark",
	"dark-solarized": "dark",
	"dark-solstice": "dark",
	"dark-starfall": "dark",
	"dark-sunset": "dark",
	"dark-swamp": "dark",
	"dark-synthwave": "dark",
	"dark-taiga": "dark",
	"dark-terminal": "dark",
	"dark-tokyo-night": "dark",
	"dark-tundra": "dark",
	"dark-twilight": "dark",
	"dark-volcanic": "dark",
	graphite: "dark",
	light: "light",
	"light-arctic": "light",
	"light-aurora-day": "light",
	"light-canyon": "light",
	"light-catppuccin": "light",
	"light-cirrus": "light",
	"light-coral": "light",
	"light-cyberpunk": "light",
	"light-dawn": "light",
	"light-dunes": "light",
	"light-eucalyptus": "light",
	"light-forest": "light",
	"light-frost": "light",
	"light-github": "light",
	"light-glacier": "light",
	"light-gruvbox": "light",
	"light-haze": "light",
	"light-honeycomb": "light",
	"light-lagoon": "light",
	"light-lavender": "light",
	"light-meadow": "light",
	"light-mint": "light",
	"light-monochrome": "light",
	"light-ocean": "light",
	"light-one": "light",
	"light-opal": "light",
	"light-orchard": "light",
	"light-paper": "light",
	"light-poimandres": "light",
	"light-prism": "light",
	"light-retro": "light",
	"light-sand": "light",
	"light-savanna": "light",
	"light-solarized": "light",
	"light-soleil": "light",
	"light-sunset": "light",
	"light-synthwave": "light",
	"light-tokyo-night": "light",
	"light-wetland": "light",
	"light-zenith": "light",
	limestone: "light",
	mahogany: "dark",
	marble: "light",
	obsidian: "dark",
	onyx: "dark",
	pearl: "light",
	porcelain: "light",
	quartz: "light",
	sandstone: "light",
	titanium: "dark",
};

/** Classify a parsed theme JSON as light/dark by the perceived luminance of its status-line background. Mirrors {@link Theme.isLight} so the synchronous helpers stay in lockstep with the runtime */
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

/** Is this theme a light theme? Synchronous, for callers in synchronous flows: the settings migration and the setup wizard. */
export function isLightTheme(themeName?: string): boolean {
	const name = themeName ?? "dark";
	const bundled = BUILTIN_THEME_CLASSES[name];
	if (bundled !== undefined) return bundled === "light";
	let themeJson: ThemeJson;
	try {
		const customPath = path.join(getCustomThemesDir(), `${name}.json`);
		themeJson = JSON.parse(fs.readFileSync(customPath, "utf-8")) as ThemeJson;
	} catch {
		// Classified as dark rather than reported, deliberately: this is a synchronous classifier called
		// on render paths, and the theme's LOAD reports the same broken file once with its error. A
		// warning here would repeat it for every frame.
		return false;
	}
	return isLightThemeJson(themeJson);
}
