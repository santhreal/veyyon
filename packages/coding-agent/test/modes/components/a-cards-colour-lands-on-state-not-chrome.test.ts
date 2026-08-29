// WHY THIS SUITE EXISTS (A-DOCUMENTED-ACCENT-CUE-THAT-ARRIVES-GREY).
//
// A card's chrome moved to a neutral hairline, which was right: the frame is the least informative
// thing on the card. What that exposed is that the cues which were SUPPOSED to carry the colour were
// not carrying it either, and never had been. `getSettingsListTheme()` comments its heading row as
// "a small ember diamond — the settings kicker"; `getSelectListTheme()` comments its cursor as "the
// design system's one live thing"; the settings sidebar comments its cursor as brightening "while
// the sidebar itself holds keyboard focus". All of them paint `theme.fg("accent", …)`, and
// `titanium` maps `accent` to `#C6CBD4` — a cool grey, chroma 14. So the selection cursor, the
// selected label, the selected value, the kicker diamond, the active section, the close glyph and
// the focused-pane cursor all rendered grey on grey, and the only warm pixels left on a card came
// from `borderAccent` on the frame. Removing that frame paint took the last colour off the surface:
// measured on the recorded captures, warm-hue pixels fell from 2781 to 12 on the account manager and
// from 3500 to 80 on settings.
//
// THE CLASS, NOT THE INCIDENT. The defect is not "titanium's accent is grey" and not "these seven
// call sites". It is that a cue whose JOB is to signal state can resolve to a colour that signals
// nothing, in any theme, at any call site. So the contract is about the RESOLVER
// (`Theme.stateAccentToken`) and it is swept over every bundled theme read from
// `getBuiltinThemes()` at run time:
//
//   1. A theme that declares a chromatic accent token anywhere never renders a state cue in a
//      neutral. This is the defect class stated positively, and it fails by default on a new theme
//      that reintroduces it.
//   2. A theme whose own `accent` already carries colour is BYTE-IDENTICAL to painting `accent`
//      directly. 95 of the 98 bundled themes are in this set, so the fallback must be invisible to
//      them; a resolver that "improved" their colour would be caught here.
//   3. A theme that declares no chromatic accent at all (`alabaster`) is monochrome on purpose and
//      is not handed a hue it never chose.
//   4. Chrome is unaffected: the frame paint stays neutral in a theme where state went warm, which
//      is the whole point of moving colour off the border and onto state.
//   5. The transcript's own accessor (`getAccentColorHex`) still returns the DECLARED accent, so
//      lighting the cards did not recolour prose. The shimmer ramp reads that one.
//
// WHAT IT DOES NOT CATCH. Whether the colour is the RIGHT one aesthetically — that is what the
// recorded before/after capture pair is for. It does not check where a cue is positioned, only what
// it resolves to. It says nothing about background bands: `paintBand`'s leading cell is asserted
// here as a hex, but the ramp's shape is the motion suite's contract. And a NEW cue that hand-rolls
// its own escape instead of going through the resolver is only caught if it is one of the cues swept
// below, which is why the resolver is the choke point rather than the seven call sites.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AnsiPolicy } from "@veyyon/tui";
import { getAnsiPolicy, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { getTabBarTheme } from "../../../src/modes/shared";
import { cardOutlineColor, cardScrollbarTheme } from "../../../src/modes/theme/card-outline";
import { hexChroma } from "../../../src/modes/theme/color";
import { setPaintedGround } from "../../../src/modes/theme/ground-tints";
import {
	createTheme,
	getBuiltinThemes,
	getSelectListTheme,
	getSettingsListTheme,
	paintBand,
} from "../../../src/modes/theme/theme";
import { setActiveTheme, theme } from "../../../src/modes/theme/theme-binding";

/**
 * The threshold the resolver uses. Restated rather than imported: this suite is asserting the
 * contract "a state cue carries visible colour", and a test that imports the implementation's own
 * constant cannot notice the implementation moving it.
 */
const MIN_CHROMA = 24;

let previousPolicy: AnsiPolicy;

/** Every bundled theme, read at run time so a new theme file joins the sweep without an edit. */
const THEMES = getBuiltinThemes();
const THEME_NAMES = Object.keys(THEMES).sort();

const use = (name: string): void => {
	const json = THEMES[name];
	// `mode`, not `colorMode`: the option is silently ignored under the wrong name, and the theme
	// then takes the mode of whatever terminal the suite happens to run in — 256-colour under the
	// sandbox, truecolor on a workstation. Every hex assertion below depends on this being 24-bit.
	if (json === undefined) throw new Error(`no bundled theme named ${name}`);
	setActiveTheme(createTheme(json, { mode: "truecolor" }));
};

/** The 24-bit foreground hexes a rendered string opens, in order. */
const fgHexesOf = (rendered: string): string[] => {
	const out: string[] = [];
	const pattern = /\x1b\[38;2;(\d+);(\d+);(\d+)m/g;
	let match = pattern.exec(rendered);
	while (match !== null) {
		const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
		out.push(`#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`);
		match = pattern.exec(rendered);
	}
	return out;
};

/**
 * The state cues a card renders, as rendered strings, keyed `surface:key` so the set of cues swept
 * here can be compared directly against the classification below. Each one is a site whose comment
 * or name claims it signals selection, focus or interaction.
 */
const stateCues = (): Record<string, string> => {
	const settings = getSettingsListTheme();
	const list = getSelectListTheme();
	// `heading` and `section` are optional on the interface (a theme may omit them and fall back to
	// `hint`/`label`). This product's theme supplies both, and a build that stopped supplying them
	// would drop two cues out of the sweep silently, so their absence is a failure here rather than
	// an optional chain that quietly yields nothing.
	const { heading, section } = settings;
	if (heading === undefined || section === undefined) {
		throw new Error("the settings list theme stopped supplying heading/section, so two cues are unswept");
	}
	return {
		"settings:cursor": settings.cursor,
		"settings:heading": heading("Theme", false),
		"settings:label": settings.label("Dark Theme", true, false),
		"settings:value": settings.value("titanium", true, false),
		"settings:section": section("Appearance", true),
		"list:selectedText": list.selectedText("Anthropic"),
		// The active tab of the shared strip: the dashboard's `Live (1)` and, through
		// `renderVertical`, the settings category sidebar. It paints its label ON the selection
		// band, so the assertion is about the foreground it opens inside that background.
		"tabs:activeTab": getTabBarTheme().activeTab("Live (1)"),
	};
};

/**
 * Every key each list theme exposes, classified by whether it signals STATE (and so must carry the
 * theme's colour) or is deliberately QUIET (a description, a hint, an unselected value).
 *
 * Pinned by set-equality against the live object so a NEW key fails this suite until somebody
 * classifies it. Without that, a cue added later — the exact way this defect arrived — would simply
 * not be swept, and the suite would stay green while a fresh grey cursor shipped.
 */
const SETTINGS_LIST_KEYS: Record<string, "state" | "quiet" | "band"> = {
	cursor: "state",
	heading: "state",
	label: "state",
	value: "state",
	section: "state",
	description: "quiet",
	hint: "quiet",
	hovered: "band",
};

const SELECT_LIST_KEYS: Record<string, "state" | "quiet" | "band" | "own-paint"> = {
	selectedText: "state",
	// Already warm by its own owner: a live molten arc, and a `borderAccent` ember without truecolor.
	selectedPrefix: "own-paint",
	// Already warm by its own owner: paints `borderAccent` directly.
	groupHeader: "own-paint",
	// The found thing is gold, which is its own token and not the accent.
	matchHighlight: "own-paint",
	description: "quiet",
	scrollInfo: "quiet",
	noMatch: "quiet",
	symbols: "quiet",
	hovered: "band",
};

const TAB_BAR_KEYS: Record<string, "state" | "quiet" | "band"> = {
	activeTab: "state",
	// The strip's own identity label, not a piece of state: it says what the strip is, and it says
	// the same thing whichever tab is live.
	label: "quiet",
	inactiveTab: "quiet",
	mutedTab: "quiet",
	hint: "quiet",
	hoverTab: "band",
};

beforeAll(() => {
	// Colour is off under a test runner, because stdout is not a terminal, and every paint would then
	// be the empty string and every assertion below trivially true.
	previousPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(previousPolicy);
});

describe("a state cue carries the theme's colour", () => {
	it("sweeps every bundled theme, and there are enough of them to be a sweep", () => {
		// A sweep that silently enumerated nothing would pass every assertion below.
		expect(THEME_NAMES.length).toBeGreaterThan(90);
		expect(THEME_NAMES).toContain("titanium");
	});

	it("has a classification for every key the shared themes expose", () => {
		// Set-equality, not a length or a subset: a key added to any of these themes lands here as a
		// failure, so a new cue cannot ship unswept. A key REMOVED fails too, which is correct —
		// the classification is stale either way.
		use("titanium");
		expect(Object.keys(getSettingsListTheme()).sort()).toEqual(Object.keys(SETTINGS_LIST_KEYS).sort());
		expect(Object.keys(getSelectListTheme()).sort()).toEqual(Object.keys(SELECT_LIST_KEYS).sort());
		expect(Object.keys(getTabBarTheme()).sort()).toEqual(Object.keys(TAB_BAR_KEYS).sort());
		// And every key classified "state" is actually one of the cues swept below.
		const claimed = [
			...Object.entries(SETTINGS_LIST_KEYS).map(([key, kind]) => [`settings:${key}`, kind] as const),
			...Object.entries(SELECT_LIST_KEYS).map(([key, kind]) => [`list:${key}`, kind] as const),
			...Object.entries(TAB_BAR_KEYS).map(([key, kind]) => [`tabs:${key}`, kind] as const),
		]
			.filter(([, kind]) => kind === "state")
			.map(([label]) => label)
			.sort();
		expect(Object.keys(stateCues()).sort()).toEqual(claimed);
	});

	it("never renders a state cue in a neutral when the theme declares a chromatic accent token", () => {
		const greyCues: string[] = [];
		for (const name of THEME_NAMES) {
			use(name);
			const declared = [theme.getColorHex("accent"), theme.getColorHex("borderAccent")];
			// The precondition: this theme HAS a colour to signal with. A deliberately monochrome
			// theme is the next test's subject, not a failure here.
			if (!declared.some(hex => hexChroma(hex) >= MIN_CHROMA)) continue;
			for (const [label, rendered] of Object.entries(stateCues())) {
				const hexes = fgHexesOf(rendered);
				// The cue must open at least one span, and the first span it opens — the cue's own
				// glyph or label, before any muted trailer — must carry colour.
				if (hexes.length === 0 || hexChroma(hexes[0] as string) < MIN_CHROMA) {
					greyCues.push(`${name}: ${label} -> ${hexes[0] ?? "no colour at all"}`);
				}
			}
		}
		expect(greyCues).toEqual([]);
	});

	it("is byte-identical to painting the accent directly in every theme whose accent has colour", () => {
		const drifted: string[] = [];
		for (const name of THEME_NAMES) {
			use(name);
			if (hexChroma(theme.getColorHex("accent")) < MIN_CHROMA) continue;
			if (theme.stateAccentToken() !== "accent") {
				drifted.push(`${name}: token is ${theme.stateAccentToken()}`);
				continue;
			}
			const probe = "Anthropic";
			if (theme.stateAccent(probe) !== theme.fg("accent", probe)) drifted.push(`${name}: bytes differ`);
		}
		expect(drifted).toEqual([]);
	});

	it("hands a monochrome theme no hue it never declared", () => {
		use("alabaster");
		// Both accent tokens are neutral greys in this theme; the resolver must not reach past them.
		expect(hexChroma(theme.getColorHex("accent"))).toBeLessThan(MIN_CHROMA);
		expect(hexChroma(theme.getColorHex("borderAccent"))).toBeLessThan(MIN_CHROMA);
		expect(theme.stateAccentToken()).toBe("accent");
		expect(theme.getStateAccentHex()).toBe(theme.getColorHex("accent"));
	});
});

describe("titanium, the theme whose accent token is a neutral", () => {
	beforeAll(() => {
		use("titanium");
	});

	it("resolves state to the ember it declares, not the grey its accent token names", () => {
		expect(theme.getColorHex("accent")).toBe("#C6CBD4");
		expect(hexChroma(theme.getColorHex("accent"))).toBeLessThan(MIN_CHROMA);
		expect(theme.stateAccentToken()).toBe("borderAccent");
		expect(theme.getStateAccentHex()).toBe("#F0862E");
	});

	it("paints every state cue in that ember", () => {
		// Reported as a map so a failure names WHICH cue lost its colour, rather than one label
		// argument that the workspace type check rejects on `expect`.
		const painted: Record<string, string | undefined> = {};
		for (const [label, rendered] of Object.entries(stateCues())) {
			painted[label] = fgHexesOf(rendered)[0]?.toLowerCase();
		}
		expect(painted).toEqual({
			"settings:cursor": "#f0862e",
			"settings:heading": "#f0862e",
			"settings:label": "#f0862e",
			"settings:value": "#f0862e",
			"settings:section": "#f0862e",
			"list:selectedText": "#f0862e",
			"tabs:activeTab": "#f0862e",
		});
	});

	it("leads the selection band with the state accent, so a selected row has a warm end", () => {
		const band = paintBand("Appearance", "selectedBg", 1);
		// The leading cell is a BACKGROUND, and it is the ember rather than the grey accent token.
		expect(band).toContain("\x1b[48;2;240;134;46m");
	});

	it("keeps a scrollbar thumb quiet, because a thumb is a stripe and not a cue", () => {
		// Recorded, not theorised: routing the thumb through the state accent put a saturated bar
		// some four hundred pixels tall down the settings card — louder than the accent frame this
		// whole pass removed for being loud. A thumb is as tall as the visible fraction of the list,
		// so it takes the theme's DECLARED accent, which is the neutral in this theme.
		const thumb = cardScrollbarTheme().thumb("█");
		expect(thumb).toBe(theme.fg("accent", "█"));
		expect(thumb).not.toContain("240;134;46");
		// The track is the frame's hairline, not the thumb's paint, or the bar would read as solid.
		expect(cardScrollbarTheme().track("│")).not.toBe(thumb);
	});

	it("keeps the frame neutral while state is warm, on both of the frame's paths", () => {
		// `cardOutlineColor()` has two branches and the interesting one is unreachable by default,
		// on two counts: with no OSC 11 report and no painted ground there is nothing to derive a
		// hairline FROM, and the derivation is also skipped unless the terminal reports 24-bit
		// colour, which a test runner's stdout does not. A version of this test that set neither
		// could not see the derived paint at all, and stayed green while the frame was mutated to
		// paint the state accent.
		const caps: { trueColor: boolean } = TERMINAL;
		const trueColorWas = caps.trueColor;
		const grounds: Array<[string, string | undefined]> = [
			["degraded (no ground)", undefined],
			["derived off a dark ground", "#1e2127"],
			["derived off a light ground", "#f5f5f7"],
		];
		const warm: string[] = [];
		const derivations: string[] = [];
		try {
			caps.trueColor = true;
			for (const [label, ground] of grounds) {
				setPaintedGround(ground);
				const painted = cardOutlineColor()("─");
				derivations.push(painted);
				for (const hex of fgHexesOf(painted)) {
					if (hexChroma(hex) >= MIN_CHROMA) warm.push(`${label}: ${hex}`);
				}
				// And the frame is genuinely a different paint from state, or "colour moved onto
				// state" would be vacuously true.
				if (painted.includes("240;134;46")) warm.push(`${label}: is the state accent`);
			}
		} finally {
			setPaintedGround(undefined);
			caps.trueColor = trueColorWas;
		}
		expect(warm).toEqual([]);
		// The two ground arms must actually have derived something, or the sweep above proved only
		// that the degraded token is neutral.
		expect(new Set(derivations).size).toBe(3);
		expect(derivations[1]).toContain("\x1b[38;2;");
	});

	it("leaves the declared accent accessor alone, so the transcript shimmer is unmoved", () => {
		// `getAccentColorHex` feeds the assistant-message shimmer ramp. It must keep returning what
		// the theme literally declared, or lighting the cards would have recoloured prose.
		expect(theme.getAccentColorHex()).toBe("#C6CBD4");
		expect(theme.getAccentColorHex()).not.toBe(theme.getStateAccentHex());
	});
});
