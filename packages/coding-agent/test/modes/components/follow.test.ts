/**
 * The follow — the liquid accent glow on the newest of a live reveal.
 *
 * Design history this suite encodes: the follow used to run its own char-level
 * SmoothReveal governor AND grade the trailing cells to GOLD at the tip. Two
 * things were wrong and are locked out here:
 *  1. Pacing is owned in ONE place now — StreamingRevealController. This module
 *     no longer paces text at all, so there is no second governor to beat
 *     against the first and read as chunky. (Pacing is covered by
 *     streaming-reveal.test.ts and stream-reveal-monotonic.test.ts.)
 *  2. The trail is the theme ACCENT with a sheen that FLOWS over time, not a
 *     static gold "lava" tip. paintHotTail takes a `phase`; the same row at
 *     different phases paints differently (the liquid motion), the newest edge
 *     always reads hottest, and the oldest cell cools back into the named
 *     surface color.
 *
 * paintHotTail invariants held regardless of phase: visible text is unchanged
 * (only zero-width SGR is added), one color opens per trailing cell, and without
 * 24-bit color the row is returned byte-identical (loud degrade: no glow at all,
 * never a 16-color approximation of the ramp).
 */
import { describe, expect, it } from "bun:test";
import {
	FOLLOW_TUNING,
	paintHotTail,
	SHIMMER_PERIOD_MS,
	shimmerPhase,
} from "@veyyon/coding-agent/modes/components/follow";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { createTheme } from "@veyyon/coding-agent/modes/theme/theme";

const theme = createTheme(defaultThemes.titanium as ThemeJson, { mode: "truecolor" });

/** The exact `r;g;b` triple a theme token resolves to, as paintHotTail emits it. */
function rgbOf(token: "thinkingText" | "toolOutput" | "accent"): string {
	return theme
		.getColorHex(token)
		.replace("#", "")
		.match(/../g)!
		.map(h => parseInt(h, 16))
		.join(";");
}

/** Every `38;2;r;g;b` foreground open in `out`, in order. */
function opensOf(out: string): string[] {
	return [...out.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map(m => m[1]!);
}

/** Sum of a triple's channels — a cheap brightness proxy. */
function brightness(triple: string): number {
	return triple.split(";").reduce((a, c) => a + Number(c), 0);
}

/** A phase that parks the sheen band at the fresh tip, so the oldest cell has
 *  effectively zero sheen (its color is the pure cooled surface) and the tip is
 *  at full glow. Mirrors the module's sheen travel sheenPos = -0.2 + 1.4*phase,
 *  solved for sheenPos ≈ 1.0. */
const TIP_PHASE = (1.0 + 0.2) / 1.4;

describe("shimmerPhase", () => {
	/** Phase is a normalized [0,1) sweep over the period, wrapping cleanly so a
	 *  free-running clock never produces a discontinuity mid-sheen. */
	it("wraps into [0,1) across the period boundary", () => {
		expect(shimmerPhase(0)).toBeCloseTo(0, 6);
		expect(shimmerPhase(SHIMMER_PERIOD_MS / 2)).toBeCloseTo(0.5, 6);
		expect(shimmerPhase(SHIMMER_PERIOD_MS)).toBeCloseTo(0, 6);
		expect(shimmerPhase(SHIMMER_PERIOD_MS * 3.25)).toBeCloseTo(0.25, 6);
		expect(shimmerPhase(-SHIMMER_PERIOD_MS * 0.25)).toBeCloseTo(0.75, 6);
	});
});

describe("paintHotTail — the liquid accent glow", () => {
	const row = "the reasoning tail of the current line";

	it("adds only zero-width color: the visible text is unchanged", () => {
		const out = paintHotTail(row, theme, true, "thinkingText", 0.3);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(row);
	});

	it("opens exactly one color per trailing cell", () => {
		const out = paintHotTail(row, theme, true, "thinkingText", 0.3);
		expect(opensOf(out).length).toBe(FOLLOW_TUNING.trailCells);
	});

	it("caps the trail at the row width for short rows", () => {
		const out = paintHotTail("abc", theme, true, "thinkingText", 0.3);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("abc");
		expect(opensOf(out).length).toBe(3);
	});

	it("cools the oldest cell into the surface named by cooledToken", () => {
		// With the sheen parked at the tip, the oldest cell carries no sheen, so it
		// is the pure cooled surface color — the anchor that keeps the glow reading
		// as a continuation of thinking text (or tool output), not a foreign band.
		const thinking = paintHotTail(row, theme, true, "thinkingText", TIP_PHASE);
		const tool = paintHotTail(row, theme, true, "toolOutput", TIP_PHASE);
		expect(opensOf(thinking)[0]).toBe(rgbOf("thinkingText"));
		expect(opensOf(tool)[0]).toBe(rgbOf("toolOutput"));
	});

	it("burns hottest at the newest edge", () => {
		// The tip must always read as the freshest character: brighter than the
		// cooled oldest cell, and warmed past the plain accent (the sheen lightens
		// the accent toward glass-white).
		const out = paintHotTail(row, theme, true, "thinkingText", TIP_PHASE);
		const opens = opensOf(out);
		const tip = opens.at(-1)!;
		expect(brightness(tip)).toBeGreaterThan(brightness(opens[0]!));
		expect(brightness(tip)).toBeGreaterThan(brightness(rgbOf("accent")));
	});

	it("flows: the same row paints differently as the phase advances", () => {
		// The sheen band sweeps with time. If two well-separated phases produced
		// identical output the glow would be a static tint, not a liquid flow —
		// the exact defect this redesign fixes.
		const a = paintHotTail(row, theme, true, "thinkingText", 0.1);
		const b = paintHotTail(row, theme, true, "thinkingText", 0.6);
		expect(a).not.toBe(b);
	});

	it("defaults cooledToken to thinkingText and phase to 0", () => {
		expect(paintHotTail(row, theme, true)).toBe(paintHotTail(row, theme, true, "thinkingText", 0));
	});

	it("is a no-op without 24-bit color (loud degrade: no glow at all)", () => {
		expect(paintHotTail(row, theme, false, "thinkingText", 0.3)).toBe(row);
	});

	it("returns an empty row untouched", () => {
		expect(paintHotTail("", theme, true, "thinkingText", 0.3)).toBe("");
	});
});

describe("paintHotTail padding anchor", () => {
	/** The bug this locks out: rendered rows arrive right-padded to the
	 * component width, and the trail selected the last TRAIL_CELLS of the
	 * PADDED row — so the glow painted trailing spaces (invisible ink) and
	 * the visible text never glowed at all. Found 2026-07-22 while probing
	 * the "answer renders amber" report: the shipped glow had been a no-op
	 * on every padded row since it landed. */
	it("anchors the trail at the last visible character, not the padded edge", () => {
		const padded = `glow ends here${" ".repeat(30)}`;
		const out = paintHotTail(padded, theme, true, "thinkingText", 0);
		// The final color open must wrap a real character, not a space.
		const paintedChars = [...out.matchAll(/\x1b\[38;2;\d+;\d+;\d+m(.)/g)].map(m => m[1]!);
		expect(paintedChars.length).toBeGreaterThan(0);
		// The trail must cover real ink (word-interior spaces are fine, an
		// all-space trail is the regression).
		expect(paintedChars.some(ch => ch !== " ")).toBe(true);
		expect(paintedChars[paintedChars.length - 1]).toBe("e");
	});

	it("keeps the trailing padding byte-identical after the reset", () => {
		const padded = `short${" ".repeat(12)}`;
		const out = paintHotTail(padded, theme, true, "thinkingText", 0);
		expect(out.endsWith(`\x1b[39m${" ".repeat(12)}`)).toBe(true);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(padded);
	});

	it("still paints an unpadded row edge-to-edge", () => {
		const row = "no padding at all";
		const out = paintHotTail(row, theme, true, "thinkingText", 0);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(row);
		expect(opensOf(out).length).toBeGreaterThan(0);
	});

	it("returns an all-space row untouched", () => {
		const spaces = " ".repeat(20);
		expect(paintHotTail(spaces, theme, true, "thinkingText", 0)).toBe(spaces);
	});
});
