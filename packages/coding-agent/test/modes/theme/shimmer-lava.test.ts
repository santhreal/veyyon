/**
 * Lava — the molten warm-arc motion. The user-approved design gives LIVE
 * warm-arc glyphs (selection cursor, match hits, filter caret, spinner paint)
 * a slow heat cycle: deep-ember → ember → gold → back, built from theme
 * tokens (borderAccent, matchHighlight), never literal hexes.
 *
 * This suite locks the contracts that make lava a signal instead of noise:
 *  1. Periodicity: the color at t and t + LAVA_PERIOD_MS is byte-identical —
 *     a drifting period would make the motion feel random.
 *  2. The exact stops: phase 0 is deep ember (ember scaled toward black by
 *     the deep factor), phase 0.5 is exactly the theme's gold. Drifted stops
 *     are a silent rebrand.
 *  3. Warm-arc confinement: every sample stays between deep-ember and gold —
 *     lava must never wander into cool or semantic hues.
 *  4. Flow: adjacent cells carry different phases (the heat travels), and
 *     lavaText paints per-cell with one reset at the end.
 *  5. Loud non-truecolor degrade: without 24-bit color there is NO animation —
 *     static borderAccent ember, never a different color, never a half-ramp.
 */
import { describe, expect, it } from "bun:test";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { LAVA_TUNING, lavaAnsi, lavaText } from "@veyyon/coding-agent/modes/theme/shimmer";
import { createTheme } from "@veyyon/coding-agent/modes/theme/theme";

const theme = createTheme(defaultThemes.titanium as ThemeJson, { mode: "truecolor" });

function rgb(ansi: string | undefined): number[] {
	const m = ansi?.match(/38;2;(\d+);(\d+);(\d+)/);
	if (!m) throw new Error(`not a 24-bit open: ${ansi}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hexRgb(hex: string): number[] {
	const n = hex.replace("#", "");
	return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16));
}

describe("lava — periodicity and stops", () => {
	it("repeats exactly every LAVA_PERIOD_MS", () => {
		for (const t of [0, 1234, 4000]) {
			expect(lavaAnsi(theme, true, t)).toBe(lavaAnsi(theme, true, t + LAVA_TUNING.periodMs));
		}
	});

	it("phase 0 is deep ember: the theme's borderAccent scaled toward black", () => {
		const ember = hexRgb(theme.getColorHex("borderAccent"));
		const expected = ember.map(c => Math.round(c * (1 - LAVA_TUNING.deepFactor)));
		expect(rgb(lavaAnsi(theme, true, 0))).toEqual(expected);
	});

	it("the crest (half period) is exactly the theme's matchHighlight gold", () => {
		expect(rgb(lavaAnsi(theme, true, LAVA_TUNING.periodMs / 2))).toEqual(hexRgb(theme.getColorHex("matchHighlight")));
	});

	/** Warm-arc confinement: red channel dominant and every channel bounded by
	 * the ramp's endpoints — lava never cools into teal/violet or spikes into
	 * a hue outside deep-ember..gold. */
	it("every sample across a full cycle stays inside the warm arc", () => {
		const deep = hexRgb(theme.getColorHex("borderAccent")).map(c => Math.round(c * (1 - LAVA_TUNING.deepFactor)));
		const gold = hexRgb(theme.getColorHex("matchHighlight"));
		const lo = deep.map((c, i) => Math.min(c, gold[i]!));
		const hi = deep.map((c, i) => Math.max(c, hexRgb(theme.getColorHex("borderAccent"))[i]!, gold[i]!));
		for (let t = 0; t < LAVA_TUNING.periodMs; t += 250) {
			const [r, g, b] = rgb(lavaAnsi(theme, true, t));
			expect(r).toBeGreaterThanOrEqual(g);
			expect(g).toBeGreaterThanOrEqual(b);
			for (const [i, c] of [r, g, b].entries()) {
				expect(c).toBeGreaterThanOrEqual(lo[i]! - 1);
				expect(c).toBeLessThanOrEqual(hi[i]! + 1);
			}
		}
	});
});

describe("lava — flow across cells", () => {
	it("adjacent cells carry different phases so the heat travels", () => {
		const a = lavaAnsi(theme, true, 1000, 0);
		const b = lavaAnsi(theme, true, 1000, 3);
		expect(a).not.toBe(b);
	});

	it("lavaText paints each glyph and closes with one reset", () => {
		const out = lavaText("❯❯", theme, true, 1000);
		const opens = out.match(/\x1b\[38;2;/g) ?? [];
		expect(opens).toHaveLength(2);
		expect(out.endsWith("\x1b[39m")).toBe(true);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("❯❯");
	});
});

describe("lava — loud non-truecolor degrade", () => {
	it("lavaAnsi refuses to animate without 24-bit color", () => {
		expect(lavaAnsi(theme, false, 1000)).toBeUndefined();
	});

	it("lavaText falls back to static borderAccent ember, same glyphs", () => {
		const out = lavaText("❯", theme, false, 1000);
		expect(out).toBe(theme.fg("borderAccent", "❯"));
	});
});
