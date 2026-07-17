/**
 * Composer chrome: the quiet frame around the prompt. The old design crammed
 * model, mode, path, git, and context into the top border of a heavy box. This
 * is the opposite: a dim hairline, an ember prompt glyph, and two whisper-quiet
 * lines with sweeping space between them — location above, capability below.
 */

import { stripVTControlCharacters } from "node:util";
import type { Component } from "@veyyon/pi-tui";
import { TERMINAL } from "@veyyon/pi-tui";
import { theme } from "../theme/theme";
import { EMBER, renderSunField } from "./sun";

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

/**
 * The ghost sun: a faded dome resting on the composer's hairline horizon, at
 * the location line's right edge. `sink` (0..1) lowers it into the horizon —
 * on submit the sun sets; when the agent comes to rest, it rises again.
 * Returns null once it has fully set (nothing to paint).
 */
export function ghostSunBar(trueColor: boolean, sink = 0): string | null {
	if (sink >= 1) return null;
	const bar = renderSunField({
		cols: 15,
		rows: 1,
		cx: 7,
		cy: 1.6 + sink * 3.2,
		radius: 5,
		time: 0.6,
		trueColor,
		intensity: 0.5 * (1 - sink * 0.5),
	})[0];
	return /\S/.test(stripVTControlCharacters(bar)) ? bar : null;
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
