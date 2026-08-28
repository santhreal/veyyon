/** The follow — the design system's rule for anything being produced live: you always see the newest of it, and the freshest characters carry a soft */

import { CHANNEL_STR, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import type { Theme } from "../theme/theme";

/** Visible cells of glowing trail at the newest edge. A little longer than a
 *  glance so the sweeping sheen has room to read as motion, not a blink. */
const TRAIL_CELLS = 16;
/** Wall-clock period (ms) of one full sheen sweep across the trail. ~1.4s reads
 *  as a calm liquid pour rather than a strobe. */
export const SHIMMER_PERIOD_MS = 1400;
/** Gaussian half-width of the moving sheen band, in trail-position units [0,1]. */
const SHEEN_SIGMA = 0.18;

/** Map a wall-clock timestamp to a sheen phase in [0, 1). Exported so every
 *  caller animates the same one sweep (ONE PLACE for the flow's tempo). */
export function shimmerPhase(nowMs: number): number {
	const t = ((nowMs % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS;
	return t / SHIMMER_PERIOD_MS;
}

function hexChannel(hex: string, i: number): number {
	const hi = hex.charCodeAt(1 + i * 2);
	const lo = hex.charCodeAt(2 + i * 2);
	return (hexVal(hi) << 4) | hexVal(lo);
}

function hexVal(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
	return c - 0x61 + 10;
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
	return [hexChannel(hex, 0), hexChannel(hex, 1), hexChannel(hex, 2)];
}

/** Linear blend of two `#rrggbb` colors, returning an RGB tuple. */
function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	return [
		Math.round(a[0] + (b[0] - a[0]) * c),
		Math.round(a[1] + (b[1] - a[1]) * c),
		Math.round(a[2] + (b[2] - a[2]) * c),
	];
}

/** Truecolor foreground SGR for an RGB tuple. */
function sgrRgb(rgb: Rgb): string {
	return `\x1b[38;2;${CHANNEL_STR[rgb[0]]};${CHANNEL_STR[rgb[1]]};${CHANNEL_STR[rgb[2]]}m`;
}

/** Smoothstep easing on [0,1] — the cool-in ramp reads softer than linear. */
function smoothstep(t: number): number {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	return c * c * (3 - 2 * c);
}

type FollowTheme = Pick<Theme, "getColorHex">;

/** Paint the liquid glow onto the LAST row of a live reveal: the trailing {@link TRAIL_CELLS} visible characters grade from the surface's cooled body */
export function paintHotTail(
	row: string,
	theme: FollowTheme,
	trueColor: boolean,
	cooledToken: "thinkingText" | "toolOutput" = "thinkingText",
	phase = 0,
): string {
	if (!trueColor) return row;
	// The glow anchors at the LAST VISIBLE character, not the row edge:
	// rendered rows arrive right-padded to the component width, and painting
	// fg color onto trailing spaces is invisible ink — the trail never showed.
	let paddingLen = 0;
	for (let i = row.length - 1; i >= 0; i--) {
		if (row.charCodeAt(i) !== 0x20) break;
		paddingLen++;
	}
	const padding = paddingLen > 0 ? row.slice(row.length - paddingLen) : "";
	const body = paddingLen > 0 ? row.slice(0, row.length - paddingLen) : row;
	const plain = stripAnsi(body);
	const width = visibleWidth(plain);
	if (width === 0) return row;
	const tip = Math.min(TRAIL_CELLS, width);
	const head = truncateToWidth(body, width - tip, "");
	const tailPlain = plain.slice(plain.length - tip);

	const cooledRgb = parseHex(theme.getColorHex(cooledToken));
	const accentRgb = parseHex(theme.getColorHex("accent"));
	// The sheen is a lightened accent — the liquid-glass highlight, not pure white
	// (that would read as a colorless flare and lose the accent identity).
	const sheenRgb = mixRgb(accentRgb, parseHex("#ffffff"), 0.55);

	// Travel the sheen from just before the oldest cell to just past the tip so
	// the highlight enters and exits the trail each period instead of ping-ponging.
	const sheenPos = -0.2 + 1.4 * (((phase % 1) + 1) % 1);

	let out = head;
	for (let i = 0; i < tailPlain.length; i++) {
		// 0 → oldest of the tail (cooled), 1 → the newest character (accent).
		const p = tailPlain.length === 1 ? 1 : i / (tailPlain.length - 1);
		const base = mixRgb(cooledRgb, accentRgb, smoothstep(p));
		// Moving sheen: a gaussian bump at sheenPos, weighted toward the fresh edge.
		const d = p - sheenPos;
		const bump = Math.exp(-(d * d) / (2 * SHEEN_SIGMA * SHEEN_SIGMA));
		const sheen = bump * (0.3 + 0.7 * p);
		// A fixed tip glow guarantees the newest characters always read hottest,
		// even at the moment the sheen band is elsewhere on the trail.
		const tipGlow = p > 0.8 ? ((p - 0.8) / 0.2) * 0.5 : 0;
		const amount = Math.min(1, sheen + tipGlow);
		out += `${sgrRgb(mixRgb(base, sheenRgb, amount))}${tailPlain[i]}`;
	}
	return `${out}\x1b[39m${padding}`;
}

/** Exposed for the follow test suite. */
export const FOLLOW_TUNING = {
	trailCells: TRAIL_CELLS,
	shimmerPeriodMs: SHIMMER_PERIOD_MS,
	sheenSigma: SHEEN_SIGMA,
} as const;
