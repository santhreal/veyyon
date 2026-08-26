// Frame transforms an animation drives: blending colors, fading a rendered
// block toward the ground it sits on, and growing a block a row at a time.
//
// These are pure functions over already-rendered lines. That is deliberate: a
// component renders once, at full strength, and the animation reshapes the
// bytes on the way out. Nothing downstream has to know a transition is running,
// and every frame of a transition is byte-assertable in a test.
//
// Only truecolor (`38;2;r;g;b` / `48;2;r;g;b`) is faded. An indexed color is
// left exactly as written: guessing its RGB means carrying a palette that the
// terminal may not be using, and a wrong guess is a visible color shift rather
// than a missing fade. Motion is gated on truecolor at the call site anyway.

import { clamp, clamp01 } from "@veyyon/utils/math";
import { sgrSequence } from "./ansi";
import { parseHexColor } from "./paint-ground";

function clampChannel(value: number): number {
	return clamp(Math.round(value), 0, 255);
}

/** `#rrggbb` from channels, each clamped to a byte. */
export function toHexColor(r: number, g: number, b: number): string {
	return `#${[r, g, b].map(c => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Mix two colors. `t` 0 returns `from`, 1 returns `to`. Blending is done on
 * the raw channels rather than in a perceptual space: over the 90-220ms these
 * transitions run, the difference is invisible, and the cost is not.
 */
export function blendHex(from: string, to: string, t: number): string {
	const a = parseHexColor(from);
	const b = parseHexColor(to);
	if (a === null || b === null) return t >= 0.5 ? to : from;
	const k = clamp01(t);
	return toHexColor(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

/**
 * The SGR scanner. `ansi.ts` owns the pattern: four modules used to spell it
 * out themselves and the fourth had already drifted into dropping colon-form
 * truecolor. This is the fifth caller, not a fifth copy.
 */
const SGR = sgrSequence("g");

/**
 * Fade one rendered line toward `groundHex`. `strength` 1 leaves the line
 * untouched; 0 paints every truecolor channel as the ground, which reads as
 * the line dissolving into the background rather than blinking out.
 *
 * Parameters are split keeping their separators, so a colon-form sequence
 * (`ESC [ 38:2:255:0:0 m`, which libvte and several test runners emit) comes
 * back out in the spelling it went in with.
 */
export function fadeLineTowards(line: string, groundHex: string, strength: number): string {
	const k = clamp01(strength);
	if (k >= 1) return line;
	const ground = parseHexColor(groundHex);
	if (ground === null) return line;
	const channels = [ground.r, ground.g, ground.b];
	SGR.lastIndex = 0;
	return line.replace(SGR, (whole, params: string) => {
		if (params === "") return whole;
		// Even indices are values, odd indices the `;` or `:` between them.
		const tokens = params.split(/([;:])/);
		let changed = false;
		for (let i = 0; i < tokens.length; i += 2) {
			const code = tokens[i];
			if ((code !== "38" && code !== "48") || tokens[i + 2] !== "2") continue;
			const first = i + 4;
			if (tokens[first + 4] === undefined) break; // truncated triple: leave it alone
			for (let c = 0; c < 3; c++) {
				const from = Number(tokens[first + c * 2]);
				if (!Number.isFinite(from)) continue;
				tokens[first + c * 2] = String(clampChannel(channels[c]! + (from - channels[c]!) * k));
				changed = true;
			}
			i = first + 4;
		}
		return changed ? `\x1b[${tokens.join("")}m` : whole;
	});
}

/** Fade a block of rendered lines toward the ground behind it. */
export function fadeLinesTowards(lines: readonly string[], groundHex: string, strength: number): string[] {
	if (strength >= 1) return [...lines];
	return lines.map(line => fadeLineTowards(line, groundHex, strength));
}

/**
 * How many rows of a block of `total` rows are shown at `progress`. `minimum`
 * is the smallest block worth showing — a bordered card's is 2, because one
 * border row alone reads as a stray rule rather than a card opening.
 */
export function revealedRows(total: number, progress: number, minimum = 0): number {
	if (total <= 0) return 0;
	const floor = Math.min(minimum, total);
	const shown = Math.min(total, Math.round(total * clamp01(progress)));
	return Math.max(floor, shown);
}
