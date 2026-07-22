/**
 * Composer chrome, per the agreed design (docs/internal + the "/ menu" design
 * pitch mockups): a near-invisible tone-on-tone hairline above the input, the
 * content inset from the terminal edge, an ember `›` caret, and ONE dim
 * metadata line below. The chrome is silent — motion and color belong to the
 * content (menu selection, match highlights, the working spinner), never to
 * the frame.
 */

import type { Component } from "@veyyon/tui";
import { theme } from "../theme/theme";
import { EMBER } from "./sun";

/**
 * One optional dim line of composer metadata. Renders nothing when the
 * provider has nothing to say — no empty chrome rows. `indent` shifts the
 * content off the terminal's left edge so the composer zone shares one
 * left margin (the mockups pad the composer; nothing sits at column 0).
 */
export class QuietZoneLine implements Component {
	constructor(
		private readonly line: (width: number) => string | null,
		private readonly indent = 0,
	) {}

	render(width: number): string[] {
		const pad = Math.max(0, Math.min(this.indent, width - 1));
		const line = this.line(width - pad);
		return line === null ? [] : [" ".repeat(pad) + line];
	}

	invalidate(): void {}
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
 * Full-width hairline separating the transcript from the composer zone.
 * A whisper, not a feature: the agreed composer mockups draw it as a 1px
 * tone-on-tone rule (near-black on black), so here it takes the faintest
 * structural token and never animates. Painting motion onto a solid rule
 * shatters it into uneven bright segments that read as a rendering glitch —
 * that mistake shipped once and is locked out by the composer-hairline suite.
 */
export class ComposerHairline implements Component {
	render(width: number): string[] {
		const w = Math.max(1, width);
		return [theme.fg("borderMuted", theme.boxSharp.horizontal.repeat(w))];
	}

	invalidate(): void {}
}
