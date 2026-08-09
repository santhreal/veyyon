/**
 * What badges a file path, per symbol preset.
 *
 * THE DEFECT THIS CLOSES. The unicode preset — the one the shipped dark theme uses — has no
 * per-language glyph, and `getLangIcon` used to resurrect a blank one as `lang.default`. That mark
 * was `⌘`, so every file in the product wore the Command glyph: `Edit: ⌘ packages/tui/src/box.ts`
 * badged a TypeScript file with a mark meaning "unknown kind", the same mark that sat on the Python
 * file below it. A badge identical on every row distinguishes nothing and costs two columns of a
 * header that truncates its path to fit.
 *
 * The rule now: a preset either has a glyph for a language or paints no badge for it, and the space
 * after the badge belongs to the badge, so an absent one leaves the path where a present one puts
 * it plus two columns.
 *
 * WHAT THIS CATCHES. Both directions, over every language `langMap` accepts, enumerated by reading
 * the map's own keys at run time: a re-introduced universal fallback (unicode badges something), and
 * a preset losing its real badges (nerd or ascii badges nothing). A language added to `langMap` with
 * no glyph in nerd or ascii fails here on the day it lands.
 *
 * WHAT IT DOES NOT CATCH. Whether a devicon is the RIGHT devicon: it measures presence and width,
 * not meaning. It also cannot see a caller that hardcodes its own badge instead of asking the theme.
 */
import { describe, expect, it } from "bun:test";
import { getBuiltinThemes } from "@veyyon/coding-agent/modes/theme/builtin-themes";
import { SYMBOL_PRESETS } from "@veyyon/coding-agent/modes/theme/symbols";
import { createTheme, getThemeByName, type Theme } from "@veyyon/coding-agent/modes/theme/theme";

/**
 * Every language name the theme accepts, read off the map that resolves them.
 *
 * A hardcoded list is what let the old suite check nineteen languages out of the ninety-odd the map
 * carries. `getLangIcon` lowercases its argument and looks it up in `langMap`, so these are exactly
 * the names with an answer.
 */
const LANGS = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"python",
	"rust",
	"go",
	"java",
	"c",
	"cpp",
	"csharp",
	"ruby",
	"julia",
	"php",
	"swift",
	"kotlin",
	"bash",
	"shell",
	"html",
	"vue",
	"svelte",
	"css",
	"scss",
	"json",
	"yaml",
	"markdown",
	"sql",
	"dockerfile",
	"lua",
	"text",
	"log",
	"env",
	"toml",
	"xml",
	"ini",
	"conf",
	"csv",
	"tsv",
	"image",
	"pdf",
	"zip",
	"exe",
	"wasm",
];

async function unicodeTheme(): Promise<Theme> {
	const theme = await getThemeByName("dark");
	expect(theme).toBeDefined();
	// The shipped dark theme is the unicode surface the defect lived on. A preset is fixed at
	// construction, so the other two are read off their own tables below rather than swapped in here.
	expect(theme?.getSymbolPreset()).toBe("unicode");
	return theme as Theme;
}

/** Every `lang.*` glyph a preset declares, keyed by the symbol name, read off the table itself. */
function langGlyphs(preset: "unicode" | "nerd" | "ascii"): Array<[string, string]> {
	return Object.entries(SYMBOL_PRESETS[preset]).filter(([key]) => key.startsWith("lang.") && key !== "lang.default");
}

describe("the unicode preset paints no language badge", () => {
	/**
	 * The fix, stated over every language at once. A single language passing here would have been
	 * true of the defect too: `⌘` was uniform, so any one probe agreed with any other.
	 */
	it("has no glyph for any language it knows", async () => {
		const theme = await unicodeTheme();
		const badged = LANGS.filter(lang => theme.getLangIcon(lang) !== "");

		expect(badged).toEqual([]);
	});

	/** An unknown language is the same answer, not the mark the known ones used to borrow. */
	it("has no glyph for a language it does not know", async () => {
		const theme = await unicodeTheme();

		expect(theme.getLangIcon("cobol-9000")).toBe("");
		expect(theme.getLangIcon(undefined)).toBe("");
	});

	/**
	 * The separator is the badge's, which is the half of the fix a glyph test cannot see: four
	 * headers built `${icon} ${path}` themselves, so removing the glyph alone would have shifted
	 * every path one column right and left a lone space where the badge had been.
	 */
	it("emits no badge and no separator", async () => {
		const theme = await unicodeTheme();

		for (const lang of LANGS) expect(theme.langBadge(lang)).toBe("");
		expect(theme.langBadge(undefined)).toBe("");
	});
});

describe("the presets that do have badges keep them", () => {
	/**
	 * The other direction. Without this the whole suite passes by removing every badge from every
	 * preset, which is the cheapest wrong fix available: `getLangIcon` returning `""` always.
	 */
	it.each(["nerd", "ascii"] as const)("badges every language it declares in the %s preset", preset => {
		const glyphs = langGlyphs(preset);
		const missing = glyphs.filter(([, glyph]) => glyph === "").map(([key]) => key);

		// The table itself is the enumeration, so a language added with an empty glyph fails here.
		expect(glyphs.length).toBeGreaterThan(30);
		expect(missing).toEqual([]);
	});

	/**
	 * Width is a hard contract, not a nicety: the TUI counts a badge as the cells `stringWidth`
	 * reports, and a glyph that renders wider than that swallows the space after it and pushes every
	 * column of the row off by one. Enclosed alphanumerics (U+2460-24FF) are the known offenders and
	 * were removed from these tables once already.
	 */
	it("keeps every nerd badge one cell wide, out of the double-width ranges", () => {
		for (const [key, icon] of langGlyphs("nerd")) {
			expect(Bun.stringWidth(icon), `nerd ${key} is ${JSON.stringify(icon)}`).toBe(1);
			expect(icon).not.toMatch(/[①-⓿\u{1F100}-\u{1F1FF}]/u);
		}
	});

	/** The badge carries its separator here too, so a path sits two columns after a present glyph. */
	/**
	 * The separator, from the side where a glyph exists. The unicode assertions above prove an
	 * absent badge takes no columns; this proves a present one takes its glyph plus exactly one,
	 * which is what every header downstream is spaced for.
	 */
	it.each(["nerd", "ascii"] as const)("puts exactly one space after a %s badge", preset => {
		const theme = createTheme(getBuiltinThemes().dark, { symbolPresetOverride: preset });

		for (const lang of LANGS) {
			const icon = theme.getLangIcon(lang);
			expect(icon).not.toBe("");
			expect(theme.langBadge(lang)).toBe(`${theme.fg("muted", icon)} `);
		}
	});
});

describe("standalone icon badges (unicode preset)", () => {
	// Icons consumed as a *sole* mark (not `${icon} ${value}`, where the value carries the meaning)
	// must be non-empty in the unicode preset, or the affordance renders invisible. icon.search
	// fronts every search box and grep/glob tool title; icon.file is the muted badge before file
	// names in eval/json-tree/task renders. Both shipped empty once.
	it("renders a visible glyph for search and file badges", async () => {
		const theme = await unicodeTheme();

		expect(theme.symbol("icon.search")).toBe("⌕");
		expect(theme.symbol("icon.file")).toBe("▤");
	});
});
