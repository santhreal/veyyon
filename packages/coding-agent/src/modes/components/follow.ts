import { CHANNEL_STR, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { parseHex, type Rgb } from "../theme/color-helpers";
import type { Theme } from "../theme/theme";

const TRAIL_CELLS = 16;
export const SHIMMER_PERIOD_MS = 1400;
const SHEEN_SIGMA = 0.18;

export function shimmerPhase(nowMs: number): number {
	const t = ((nowMs % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS;
	return t / SHIMMER_PERIOD_MS;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	return [
		Math.round(a[0] + (b[0] - a[0]) * c),
		Math.round(a[1] + (b[1] - a[1]) * c),
		Math.round(a[2] + (b[2] - a[2]) * c),
	];
}

function sgrRgb(rgb: Rgb): string {
	return `\x1b[38;2;${CHANNEL_STR[rgb[0]]};${CHANNEL_STR[rgb[1]]};${CHANNEL_STR[rgb[2]]}m`;
}

function smoothstep(t: number): number {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	return c * c * (3 - 2 * c);
}

type FollowTheme = Pick<Theme, "getColorHex">;

export function paintHotTail(
	row: string,
	theme: FollowTheme,
	trueColor: boolean,
	cooledToken: "thinkingText" | "toolOutput" = "thinkingText",
	phase = 0,
): string {
	if (!trueColor) return row;
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
	const sheenRgb = mixRgb(accentRgb, parseHex("#ffffff"), 0.55);

	const sheenPos = -0.2 + 1.4 * (((phase % 1) + 1) % 1);

	let out = head;
	for (let i = 0; i < tailPlain.length; i++) {
		const p = tailPlain.length === 1 ? 1 : i / (tailPlain.length - 1);
		const base = mixRgb(cooledRgb, accentRgb, smoothstep(p));
		const d = p - sheenPos;
		const bump = Math.exp(-(d * d) / (2 * SHEEN_SIGMA * SHEEN_SIGMA));
		const sheen = bump * (0.3 + 0.7 * p);
		const tipGlow = p > 0.8 ? ((p - 0.8) / 0.2) * 0.5 : 0;
		const amount = Math.min(1, sheen + tipGlow);
		out += `${sgrRgb(mixRgb(base, sheenRgb, amount))}${tailPlain[i]}`;
	}
	return `${out}\x1b[39m${padding}`;
}

export const FOLLOW_TUNING = {
	trailCells: TRAIL_CELLS,
	shimmerPeriodMs: SHIMMER_PERIOD_MS,
	sheenSigma: SHEEN_SIGMA,
} as const;
