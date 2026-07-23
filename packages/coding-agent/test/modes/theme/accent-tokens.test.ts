/**
 * The identity/state accent tokens — sessionAccent, modeAccent, shareAccent,
 * infoAccent, matchHighlight — are the design system's cool arc (plus the warm
 * match highlight). They are OPTIONAL in theme JSON because ~100 themes predate
 * them; `createTheme` fills a missing one from a documented fallback token
 * (QUIET_TOKEN_DEFAULTS) so `getFgAnsi` never throws on an older theme.
 *
 * This suite locks three contracts:
 *  1. Titanium (the brand theme) binds the Daybreak arcs to the EXACT approved
 *     hexes — teal session, violet modes, indigo share, rose info, gold match.
 *     A drifted hex here is a silent rebrand and must fail loudly.
 *  2. A theme that omits the tokens resolves them to its own accent/link/
 *     muted/warning colors — the documented defaults, not a crash and not
 *     black. This is what keeps every pre-existing theme valid.
 *  3. The defaults are load-time resolution, not lookup-time guessing: the
 *     resolved ANSI for a defaulted token is byte-identical to its fallback
 *     token's ANSI.
 */
import { describe, expect, it } from "bun:test";
import { createTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";

const titanium = defaultThemes.titanium;

/** Extract `r;g;b` from a 24-bit foreground open sequence. */
function rgbOf(ansi: string): string {
	const m = ansi.match(/38;2;(\d+;\d+;\d+)/);
	return m?.[1] ?? ansi;
}

function hexToRgb(hex: string): string {
	const n = hex.replace("#", "");
	return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)).join(";");
}

describe("accent tokens — titanium binds the approved Daybreak arcs", () => {
	const theme = createTheme(titanium as ThemeJson, { mode: "truecolor" });

	/** Each row is (token, approved artifact hex). If any assertion fails, the
	 * brand theme has drifted from the user-approved design artifact. */
	const APPROVED: [Parameters<typeof theme.getFgAnsi>[0], string][] = [
		["sessionAccent", "#3FB6A8"],
		["modeAccent", "#9B7EDE"],
		["shareAccent", "#6478D8"],
		["infoAccent", "#E88AA8"],
		["matchHighlight", "#F5B841"],
	];

	for (const [token, hex] of APPROVED) {
		it(`${token} resolves to the approved ${hex}`, () => {
			expect(rgbOf(theme.getFgAnsi(token))).toBe(hexToRgb(hex));
		});
	}

	/** The composer hairline's whisper weight — sky-line #202329 — and the
	 * Daybreak night dim. Locked because the hairline being too bright was a
	 * shipped, user-rejected defect. */
	it("borderMuted is the sky-line whisper and dim is night-dim", () => {
		expect(rgbOf(theme.getFgAnsi("borderMuted"))).toBe(hexToRgb("#202329"));
		expect(rgbOf(theme.getFgAnsi("dim"))).toBe(hexToRgb("#565F77"));
	});
});

describe("accent tokens — themes that predate them get the documented defaults", () => {
	/** A minimal legacy theme: titanium's colors with the five new tokens
	 * stripped, simulating any of the ~100 themes authored before the arc. */
	const legacyJson = {
		...(titanium as ThemeJson),
		name: "legacy-sim",
		colors: Object.fromEntries(
			Object.entries((titanium as ThemeJson).colors).filter(
				([k]) => !["sessionAccent", "modeAccent", "shareAccent", "infoAccent", "matchHighlight"].includes(k),
			),
		),
	} as ThemeJson;
	const legacy = createTheme(legacyJson, { mode: "truecolor" });

	it("does not throw on lookup of any of the five tokens", () => {
		for (const token of ["sessionAccent", "modeAccent", "shareAccent", "infoAccent", "matchHighlight"] as const) {
			expect(() => legacy.getFgAnsi(token)).not.toThrow();
		}
	});

	/** The default is inheritance, byte-for-byte: session/mode → accent,
	 * share → link, info → muted, match → warning. */
	it("resolves each missing token to its documented fallback token's bytes", () => {
		expect(legacy.getFgAnsi("sessionAccent")).toBe(legacy.getFgAnsi("accent"));
		expect(legacy.getFgAnsi("modeAccent")).toBe(legacy.getFgAnsi("accent"));
		expect(legacy.getFgAnsi("shareAccent")).toBe(legacy.getFgAnsi("link"));
		expect(legacy.getFgAnsi("infoAccent")).toBe(legacy.getFgAnsi("muted"));
		expect(legacy.getFgAnsi("matchHighlight")).toBe(legacy.getFgAnsi("warning"));
	});

	/** The preferred fallback can itself be optional: a theme with no `link`
	 * color (dark-cosmos shipped this way and its load once broke on exactly
	 * this) must chain down to `accent`, never store undefined. */
	it("chains to accent when the preferred fallback token is absent too", () => {
		const noLinkJson = {
			...legacyJson,
			name: "legacy-no-link",
			colors: Object.fromEntries(Object.entries(legacyJson.colors).filter(([k]) => k !== "link")),
		} as ThemeJson;
		const noLink = createTheme(noLinkJson, { mode: "truecolor" });
		expect(noLink.getFgAnsi("shareAccent")).toBe(noLink.getFgAnsi("accent"));
	});

	/** EVERY builtin theme must load with the new tokens resolvable — the
	 * regression that motivated the chain was a single optional-color theme
	 * failing to load at all. */
	it("all builtin themes load and resolve all five tokens", () => {
		for (const [name, json] of Object.entries(defaultThemes)) {
			const t = createTheme(json as ThemeJson, { mode: "truecolor" });
			for (const token of ["sessionAccent", "modeAccent", "shareAccent", "infoAccent", "matchHighlight"] as const) {
				expect(t.getFgAnsi(token), `${name}.${token}`).toBeTruthy();
			}
		}
	});

	/** Declaring the token must beat the default — titanium's teal is not its
	 * accent silver, proving override wins. */
	it("an explicit declaration overrides the default", () => {
		const branded = createTheme(titanium as ThemeJson, { mode: "truecolor" });
		expect(branded.getFgAnsi("sessionAccent")).not.toBe(branded.getFgAnsi("accent"));
	});
});

describe("mode glyph hues — the DS-6 morph palette on titanium", () => {
	/** The approved morph pairs glyph AND hue: `$` bash runs amber. titanium
	 * shipped bashMode bound to silver, which made the morphed `$` read as
	 * ordinary text — this locks the approved amber. */
	it("binds bashMode to the amber arc", () => {
		const theme = createTheme(titanium as ThemeJson, { mode: "truecolor" });
		expect(rgbOf(theme.getFgAnsi("bashMode"))).toBe(hexToRgb("#C9A24B"));
	});
});

describe("composerBg — the quiet card ground (DS-6 layer 0)", () => {
	/** Titanium declares composerBg "" (transparent): explicit dark fills
	 * assume a pure-black terminal ground and render as harsh black slabs on
	 * any other terminal background (live report 2026-07-22, grey-bg
	 * terminal). The composer inherits the REAL terminal ground instead; a
	 * future card must derive from the detected OSC 11 background, never a
	 * hardcoded near-black. */
	it("titanium keeps the composer ground transparent", () => {
		const theme = createTheme(titanium as ThemeJson, { mode: "truecolor" });
		expect(theme.getBgAnsi("composerBg")).toBe("\x1b[49m");
	});

	/** A theme that omits composerBg inherits statusLineBg at load time — the
	 * same one-owner default pattern as the accent tokens, so ~100 legacy
	 * themes keep loading and get a coherent card for free. */
	it("defaults to the theme's statusLineBg when omitted", () => {
		for (const [name, json] of Object.entries(defaultThemes)) {
			const colors = (json as ThemeJson).colors as Record<string, unknown>;
			if ("composerBg" in colors) continue;
			const t = createTheme(json as ThemeJson, { mode: "truecolor" });
			expect(t.getBgAnsi("composerBg"), name).toBe(t.getBgAnsi("statusLineBg"));
		}
	});

	/** All builtin themes must still load with the new bg token resolvable. */
	it("all builtin themes resolve composerBg", () => {
		for (const [name, json] of Object.entries(defaultThemes)) {
			const t = createTheme(json as ThemeJson, { mode: "truecolor" });
			expect(t.getBgAnsi("composerBg"), name).toBeTruthy();
		}
	});
});
