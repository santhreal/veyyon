/**
 * Composer chrome: the quiet frame around the prompt. The old design crammed
 * model, mode, path, git, and context into the top border of a heavy box. This
 * is the opposite: a dim hairline, an ember prompt glyph, and two whisper-quiet
 * lines with sweeping space between them — location above, capability below.
 */

import type { Component } from "@veyyon/tui";
import { TERMINAL } from "@veyyon/tui";
import { theme } from "../theme/theme";
import { EMBER, emberBandEscape } from "./sun";

/**
 * One optional dim line (location above the composer, capability below it).
 * Renders nothing when the provider has nothing to say — no empty chrome rows.
 */
export class QuietZoneLine implements Component {
	constructor(private readonly line: (width: number) => string | null) {}

	render(width: number): string[] {
		const line = this.line(width);
		return line === null ? [] : [line];
	}

	invalidate(): void {}
}

/** Lower-block eighths; index = cell fill height 0..8 (0 paints nothing). */
const DOME_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** The resting sun's silhouette, in eighths of a cell per column. */
const DOME_HEIGHTS = [1, 3, 6, 8, 6, 3, 1] as const;

/**
 * The ghost sun: a small ember dome resting on the composer's hairline
 * horizon, at the location line's right edge. `sink` (0..1) lowers it into
 * the horizon — on submit the sun sets; when the agent comes to rest, it
 * rises again. Returns null once it has fully set (nothing to paint).
 *
 * Deliberately a smooth graded silhouette, NOT a slice of the dithered sun
 * field: one row of ordered dither reads as line noise (`·░▒▒▒░··`), while a
 * solid dome of lower-block eighths reads as a sun on the horizon.
 */
export function ghostSunBar(trueColor: boolean, sink = 0): string | null {
	if (sink >= 1) return null;
	// Setting drops every column by the same number of eighths, so the shape
	// stays a dome as it slides below the horizon.
	const drop = Math.round(sink * 8);
	let out = "";
	let visible = false;
	for (const h of DOME_HEIGHTS) {
		const height = Math.max(0, h - drop);
		if (height === 0) {
			out += " ";
			continue;
		}
		visible = true;
		// Heat follows height: the core column glows, the rim cools.
		out += `${emberBandEscape((height / 8) * (1 - sink * 0.5), trueColor)}${DOME_BLOCKS[height]}`;
	}
	return visible ? `${out}\x1b[0m` : null;
}

/** The horizon sun tick: three rule cells fading down the ember ramp — the
 *  website's progress-sun-on-the-header-rule motif, one shared recipe. */
export function emberTick(trueColor: boolean, cells = 3): string {
	const rule = theme.boxSharp.horizontal;
	if (!trueColor) return theme.fg("accent", rule.repeat(cells));
	let out = "";
	for (let i = 0; i < cells; i++) {
		const band = Math.max(0, 6 - i * 2);
		out += `\x1b[38;2;${EMBER[band].join(";")}m${rule}`;
	}
	return out;
}

/**
 * Full-width dim hairline separating the transcript from the composer zone.
 * It is the horizon: the first cells carry the ember sun tick — the website's
 * progress-sun-on-the-header-rule motif, resting where the prompt's `›` sits.
 */
export class ComposerHairline implements Component {
	render(width: number): string[] {
		const w = Math.max(1, width);
		const rule = theme.boxSharp.horizontal;
		if (w < 8) return [theme.fg("dim", rule.repeat(w))];
		return [`${emberTick(TERMINAL.trueColor)}${theme.fg("dim", rule.repeat(w - 3))}`];
	}

	invalidate(): void {}
}
