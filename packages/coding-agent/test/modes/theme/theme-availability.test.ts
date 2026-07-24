// Regression locks for the 2026-07-24 revert of the "present only alabaster"
// stopgap (013d4956). That change hid every other theme from the picker,
// defaulted theme.dark/theme.light to alabaster, and forced tui.paintGround to
// "always" — which repainted the operator's terminal background (OSC 11) and
// still slabbed the composer, making a light-terminal setup strictly worse.
// The slab class is fixed at the root instead (no default background paint in
// the inline TUI), so theme presentation must never be curtailed again as a
// symptom patch.

import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { getAvailableThemes } from "@veyyon/coding-agent/modes/theme/theme";

describe("theme availability after the alabaster-only revert", () => {
	/** Every built-in theme is presented: dark, light, and neutral families all
	 * reach the picker. Hiding was the stopgap; with no default background
	 * paint there is nothing left to hide. */
	it("getAvailableThemes presents dark, light, and neutral built-ins alike", async () => {
		const themes = await getAvailableThemes();
		for (const expected of ["titanium", "alabaster", "dark-github", "light-github", "obsidian", "light-solarized"]) {
			expect(themes, `missing built-in theme: ${expected}`).toContain(expected);
		}
		// The full embedded set is large; a hidden-list regression would slash
		// this count to 1. Assert well above that without pinning the exact
		// number of shipped themes.
		expect(themes.length).toBeGreaterThan(90);
	});

	/** The mode defaults are the brand pair again, not the stopgap's alabaster
	 * for both: titanium (silver-on-black) for dark terminals, light for light
	 * terminals. */
	it("theme.dark defaults to titanium and theme.light to light", () => {
		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("titanium");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("light");
	});

	/** tui.paintGround defaults to "auto" (paint only when seamless), never
	 * "always": "always" is what overwrote the operator's terminal background
	 * with alabaster's near-white ground on every launch. */
	it("tui.paintGround defaults to auto", () => {
		expect(SETTINGS_SCHEMA["tui.paintGround"].default).toBe("auto");
	});
});
