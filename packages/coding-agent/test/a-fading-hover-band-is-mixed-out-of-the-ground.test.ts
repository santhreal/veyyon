// WHY THIS SUITE EXISTS (A-BAND-BELOW-FULL-STRENGTH-IS-A-COMPUTED-COLOR).
//
// The list decides WHEN a pointer band is at 0.4; the theme decides what 0.4 looks like. That
// second half is a color computation, and a wrong color is not a subtle regression — it is a band
// that flashes the wrong hue in the middle of every hover. Three ways it goes wrong:
//
//   1. Full strength stops being the switched band. The end of every fade-in is the band this
//      product has always painted; if that byte sequence changes, the fade did not add motion, it
//      changed the theme.
//   2. The mix comes out of the wrong ground. A band resolving out of black on a light theme, or
//      out of the terminal's own reported background, washes a hue the theme never chose. It has
//      exactly one legitimate source, and it is the same one a card unfolds out of.
//   3. A theme that cannot show the mix gets it anyway. In 256-color mode every intermediate color
//      quantizes onto the nearest palette entry, so a fade reads as the band changing color. That
//      mode gets the switched band, which is what it had.
//
// The suite drives the REAL theme builders (`getSelectListTheme`, `getSettingsListTheme`) against
// real loaded themes, one dark and one light, named explicitly. The theme's COLOR MODE decides which branch runs and
// is fixed at construction from the environment, so each case builds the theme it needs rather than
// trusting the CI terminal's own capability — otherwise the assertions silently test the other
// branch, which is how a suite stays green while the band is broken.
//
// WHAT IT DOES NOT CATCH: the timing of the fade (that is the tui suite that owns the clock), and
// how the band looks to an eye — a render proof answers that, an assertion cannot.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { modalRevealGround } from "@veyyon/coding-agent/modes/components/modal-shell";
import { selectionBand } from "@veyyon/coding-agent/modes/components/selector-helpers";
import {
	getSelectListTheme,
	getSettingsListTheme,
	getThemeByName,
	setThemeInstance,
	theme,
} from "@veyyon/coding-agent/modes/theme/theme";
import { getAnsiPolicy, setAnsiPolicy, visibleWidth } from "@veyyon/tui";

const originalColorterm = Bun.env.COLORTERM;
const originalAnsiPolicy = getAnsiPolicy();

/** `48;2;r;g;b` from a rendered band, or null when the row carries no truecolor background. */
function bandRgb(row: string): [number, number, number] | null {
	const match = /\x1b\[[0-9;]*?48;2;(\d+);(\d+);(\d+)/.exec(row);
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hexRgb(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

/** How far a band is from a color, summed over the channels. */
function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/**
 * Load a theme in a chosen color mode. The mode is read once, at construction, so it is set on the
 * environment first and the theme is built fresh — the same path the shimmer suites take.
 */
async function useTheme(name: string, mode: "truecolor" | "256color"): Promise<void> {
	if (mode === "truecolor") Bun.env.COLORTERM = "truecolor";
	else delete (Bun.env as Record<string, string | undefined>).COLORTERM;
	const originalTerm = Bun.env.TERM;
	if (mode === "256color") Bun.env.TERM = "linux";
	try {
		const loaded = await getThemeByName(name);
		if (!loaded) throw new Error(`${name} theme unavailable in test env`);
		if (loaded.getColorMode() !== mode) throw new Error(`${name} built as ${loaded.getColorMode()}, wanted ${mode}`);
		setThemeInstance(loaded);
	} finally {
		if (originalTerm === undefined) delete (Bun.env as Record<string, string | undefined>).TERM;
		else Bun.env.TERM = originalTerm;
	}
}

/** The band at a strength, with the two endpoints it was mixed between. */
function bandAt(strength: number): {
	rgb: [number, number, number];
	full: [number, number, number];
	ground: [number, number, number];
} {
	const paint = getSelectListTheme().hovered;
	if (paint === undefined) throw new Error("the select-list theme paints no hover band");
	const rgb = bandRgb(paint("row", strength));
	const full = bandRgb(paint("row", 1));
	if (rgb === null || full === null) throw new Error(`no truecolor background painted at strength ${strength}`);
	return { rgb, full, ground: hexRgb(modalRevealGround()) };
}

beforeAll(() => {
	// A test runtime with no TTY emits no color at all, so every band would come back as bare text
	// and each assertion would pass by comparing nothing to nothing. The bytes are the subject here.
	setAnsiPolicy("full");
});

afterAll(() => {
	setAnsiPolicy(originalAnsiPolicy);
	if (originalColorterm === undefined) delete (Bun.env as Record<string, string | undefined>).COLORTERM;
	else Bun.env.COLORTERM = originalColorterm;
});

describe("a fading hover band is mixed out of the ground", () => {
	it("paints the switched band, byte for byte, at full strength", async () => {
		await useTheme("titanium", "truecolor");
		const band = getSelectListTheme().hovered;
		const settingsBand = getSettingsListTheme().hovered;
		expect(band).toBeDefined();
		expect(settingsBand).toBeDefined();
		// The band a SWITCHED row paints, byte for byte. A fade that changes this changed the theme.
		// It is `selectionBand`'s own bytes rather than a flat `theme.bg` fill because the band is a
		// directional gradient now, and the contract is that hover and selection are one treatment:
		// re-deriving the expected bytes here would let the two drift apart in exactly the gap this
		// assertion exists to close.
		expect(band?.("row", 1)).toBe(selectionBand("row", visibleWidth("row")));
		// Both list families answer to the same band, so neither can drift from the other.
		expect(settingsBand?.("row", 1)).toBe(band?.("row", 1));
	});

	it("mixes a partial band between the ground and the selection background", async () => {
		await useTheme("titanium", "truecolor");
		const quarter = bandAt(0.25);
		const half = bandAt(0.5);
		const most = bandAt(0.9);

		// Monotone travel: every step is closer to the band and further from the page than the last.
		// Asserting direction rather than exact channels is what keeps this from breaking on a
		// theme's palette while still failing on a mix that runs backwards or off the line.
		expect(distance(quarter.rgb, quarter.full)).toBeGreaterThan(distance(half.rgb, half.full));
		expect(distance(half.rgb, half.full)).toBeGreaterThan(distance(most.rgb, most.full));
		expect(distance(quarter.rgb, quarter.ground)).toBeLessThan(distance(half.rgb, half.ground));
		expect(distance(half.rgb, half.ground)).toBeLessThan(distance(most.rgb, most.ground));
		// And the weakest band is nearer the page than the band it is arriving as.
		expect(distance(quarter.rgb, quarter.ground)).toBeLessThan(distance(quarter.rgb, quarter.full));
	});

	it("resolves out of the light theme's own ground, not a dark one", async () => {
		await useTheme("light-prism", "truecolor");
		const faint = bandAt(0.2);
		// A light theme's page is bright, so a barely-there band on it is bright too. A band mixed
		// out of black would be darker than either endpoint, which is the visible symptom of taking
		// the ground from the wrong place.
		expect(distance(faint.rgb, faint.ground)).toBeLessThan(distance(faint.rgb, [0, 0, 0]));
	});

	it("switches rather than mixes in a color mode that cannot show the mix", async () => {
		await useTheme("titanium", "256color");
		const band = getSelectListTheme().hovered;
		// Under half the band is not painted at all, over half it is the full one: the band still
		// tracks the pointer, and no frame shows a color the palette would have to guess at.
		expect(band?.("row", 0.4)).toBe("row");
		expect(band?.("row", 0.6)).toBe(theme.bg("selectedBg", "row"));
		expect(band?.("row", 1)).toBe(theme.bg("selectedBg", "row"));
		// And nothing it paints is a truecolor sequence.
		expect(bandRgb(band?.("row", 0.6) ?? "")).toBeNull();
	});
});
