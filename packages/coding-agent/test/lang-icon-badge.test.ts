/**
 * File-badge coherence for the default (unicode) symbol preset.
 *
 * The unicode preset leaves most `lang.*` glyphs empty by design, intending them
 * to fall back to the default mark (⌘). Two regressions this locks:
 *   1. `getLangIcon` returned the empty string for a *known* language whose
 *      preset glyph was empty (it only fell back for *unknown* languages), so
 *      ~30 languages rendered an invisible file badge in the shipped dark theme.
 *   2. lang.shell/html/css/yaml/env carried plain letters (S/N/A/C/T) mis-copied
 *      from the settings-tab icons — html showing "N" etc. — mismatched badges.
 */
import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";

const DEFAULT_MARK = "⌘";

async function unicodeTheme() {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	// The default dark theme ships the unicode symbol preset — the surface this bug lived on.
	expect(theme!.getSymbolPreset()).toBe("unicode");
	return theme!;
}

describe("lang icon badges (unicode preset)", () => {
	it("never renders an empty badge for a known language", async () => {
		const theme = await unicodeTheme();
		const langs = [
			"typescript",
			"javascript",
			"python",
			"rust",
			"go",
			"java",
			"cpp",
			"ruby",
			"php",
			"shell",
			"html",
			"css",
			"yaml",
			"env",
			"json",
			"markdown",
			"sql",
			"docker",
			"toml",
		];
		for (const lang of langs) {
			const icon = theme.getLangIcon(lang);
			expect(icon.length).toBeGreaterThan(0);
		}
	});

	it("maps the previously-mismatched languages to the default mark, not a stray letter", async () => {
		const theme = await unicodeTheme();
		// These carried S/N/A/C/T copied from the tab icons; now they use the
		// uniform default mark like the other empty-glyph languages.
		expect(theme.getLangIcon("shell")).toBe(DEFAULT_MARK);
		expect(theme.getLangIcon("html")).toBe(DEFAULT_MARK);
		expect(theme.getLangIcon("css")).toBe(DEFAULT_MARK);
		expect(theme.getLangIcon("yaml")).toBe(DEFAULT_MARK);
		expect(theme.getLangIcon("env")).toBe(DEFAULT_MARK);
		// Specifically not the mis-copied tab letters.
		expect(theme.getLangIcon("html")).not.toBe("N");
		expect(theme.getLangIcon("shell")).not.toBe("S");
	});

	it("keeps the deliberate enclosed-letter badges, width-1 and consistent", async () => {
		const theme = await unicodeTheme();
		expect(theme.getLangIcon("c")).toBe("Ⓒ");
		expect(theme.getLangIcon("julia")).toBe("Ⓙ");
		// kotlin was a width-2 emoji (🅺) — normalized to a width-1 circled letter
		// matching Ⓒ/Ⓙ.
		expect(theme.getLangIcon("kotlin")).toBe("Ⓚ");
	});

	it("falls back to the default mark for an unknown language", async () => {
		const theme = await unicodeTheme();
		expect(theme.getLangIcon("cobol-9000")).toBe(DEFAULT_MARK);
		expect(theme.getLangIcon(undefined)).toBe(DEFAULT_MARK);
	});
});

describe("standalone icon badges (unicode preset)", () => {
	// Icons consumed as a *sole* mark (not `${icon} ${value}`, where the value
	// carries the meaning) must be non-empty in the unicode preset, or the
	// affordance renders invisible. icon.search fronts every search box and
	// grep/glob tool title (7 sites); icon.file is the muted badge before file
	// names in eval/json-tree/task renders (8 sites) — both shipped empty.
	it("renders a visible glyph for search and file badges", async () => {
		const theme = await unicodeTheme();
		expect(theme.symbol("icon.search")).toBe("⌕");
		expect(theme.symbol("icon.file")).toBe("▤");
	});
});
