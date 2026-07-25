/**
 * The launch wordmark on a light ground.
 *
 * `v e y y o n` was painted from one hardcoded silver ramp whatever the theme
 * was. Those are the brand silvers, chosen against a near-black ground, and on
 * white the middle stop sits a few percent off the background: the largest and
 * most prominent element of the launch screen was the one you could not see. It
 * was found by looking at a light-white capture, not by reading the diff, and no
 * assertion in the suite would have caught it.
 *
 * Silver is a value rather than a hue, so the fix is the same family inverted
 * for a light ground, not a different colour. What these tests hold:
 *
 *   - The light stops ARE the light theme's own `silverDim` / `silver` /
 *     `silverStrong`. A second hardcoded triple would drift from the palette it
 *     is supposed to belong to, so this reads `light.json` and compares.
 *   - The wordmark actually clears a contrast floor on white, and the dark
 *     ground is unchanged, since the whole risk of a ramp swap is fixing one
 *     ground by breaking the other.
 */
import { describe, expect, it } from "bun:test";
import { LIGHT_SILVER_STOPS, SILVER_STOPS, silverEscape } from "@veyyon/coding-agent/modes/components/welcome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import lightThemeJson from "../../src/modes/theme/light.json" with { type: "json" };

/** `#RRGGBB` to the triple the stops are written as. */
function hexToRgb(hex: string): [number, number, number] {
	const v = hex.replace("#", "");
	return [Number.parseInt(v.slice(0, 2), 16), Number.parseInt(v.slice(2, 4), 16), Number.parseInt(v.slice(4, 6), 16)];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: readonly [number, number, number]): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours. */
function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

/** The RGB a truecolor SGR foreground sequence sets. */
function rgbOf(sgr: string): [number, number, number] {
	const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(sgr);
	if (!match) throw new Error(`not a truecolor foreground: ${JSON.stringify(sgr)}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const WHITE: [number, number, number] = [255, 255, 255];
const BRAND_BLACK: [number, number, number] = [8, 9, 11];
/** The intensity the wordmark rests at once its entrance animation settles. */
const RESTING = 0.55;

describe("the light-ground stops", () => {
	it("are the light theme's own silver vars, not a second palette", () => {
		// The one that matters: if someone retunes `light.json`, this fails rather
		// than leaving the wordmark on stale values that no longer match the theme
		// around it.
		const vars = (lightThemeJson as { vars: Record<string, string> }).vars;

		expect(LIGHT_SILVER_STOPS[0]).toEqual(hexToRgb(vars.silverDim!));
		expect(LIGHT_SILVER_STOPS[1]).toEqual(hexToRgb(vars.silver!));
		expect(LIGHT_SILVER_STOPS[2]).toEqual(hexToRgb(vars.silverStrong!));
	});

	it("run toward MORE contrast as intensity rises, the same as the dark ramp", () => {
		// The dark ramp brightens; the light ramp darkens. Both mean "stands out
		// more", and a ramp that ran the wrong way would make the entrance shine
		// fade the wordmark into the page instead of lighting it.
		expect(luminance(LIGHT_SILVER_STOPS[0]!)).toBeGreaterThan(luminance(LIGHT_SILVER_STOPS[2]!));
		expect(luminance(SILVER_STOPS[0]!)).toBeLessThan(luminance(SILVER_STOPS[2]!));
	});
});

describe("on a light theme", () => {
	it("paints the wordmark with real contrast against white", async () => {
		await initTheme(false, "unicode", false, "light", "light");

		// 4.5:1 is the WCAG floor for body text; the wordmark is far larger than
		// body text, so clearing it outright leaves no argument.
		expect(contrast(rgbOf(silverEscape(RESTING)), WHITE)).toBeGreaterThan(4.5);
	});

	it("keeps every stop legible, not just the resting one", async () => {
		await initTheme(false, "unicode", false, "light", "light");

		// The entrance sweeps the whole ramp. A stop that vanished would show as a
		// letter dropping out mid-animation.
		for (const intensity of [0, 0.25, 0.5, 0.75, 1]) {
			expect(contrast(rgbOf(silverEscape(intensity)), WHITE)).toBeGreaterThan(3);
		}
	});
});

describe("on a dark theme", () => {
	it("still paints the brand silver, unchanged", async () => {
		await initTheme(false, "unicode", false, "titanium", "titanium");

		// The fix must not cost the ground it was already right on. This is the
		// exact resting colour the dark launch screen shipped with.
		const rgb = rgbOf(silverEscape(RESTING));
		expect(rgb[0]).toBeGreaterThan(150);
		expect(contrast(rgb, BRAND_BLACK)).toBeGreaterThan(4.5);
	});

	it("does not reach for the light stops", async () => {
		await initTheme(false, "unicode", false, "titanium", "titanium");
		const rgb = rgbOf(silverEscape(RESTING));

		for (const stop of LIGHT_SILVER_STOPS) expect(rgb).not.toEqual([...stop]);
	});
});
