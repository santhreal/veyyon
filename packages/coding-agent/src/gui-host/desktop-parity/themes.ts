/**
 * The terminal's shipped themes, and whether the desktop draws them.
 *
 * The desktop draws its own dark and light palettes from
 * `crates/veyyon-desktop-ui/themes/`. A terminal theme is a set of terminal
 * color tokens; `LoadThemes` lists each theme's name and ground in the `Themes`
 * section and holds no color, so a terminal theme cannot restyle the window.
 * The decision is made per ground, and every shipped theme takes the decision
 * of its ground.
 */
import { isLightTheme } from "../../theme/builtin-themes";
import type { DesktopCarrier } from "./carrier";

/** The ground a theme is drawn on. */
export function themeGround(name: string): "dark" | "light" {
	return isLightTheme(name) ? "light" : "dark";
}

export const THEME_GROUND_CARRIERS: Readonly<Record<string, DesktopCarrier>> = {
	dark: {
		optOut: "The desktop draws its own dark palette from crates/veyyon-desktop-ui/themes/; a terminal theme holds terminal color tokens only.",
	},
	light: {
		optOut: "The desktop draws its own light palette from crates/veyyon-desktop-ui/themes/; a terminal theme holds terminal color tokens only.",
	},
};

/** The carrier for one theme: the decision for its ground, else none. */
export function themeCarrier(name: string): DesktopCarrier | undefined {
	return THEME_GROUND_CARRIERS[themeGround(name)];
}
