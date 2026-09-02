/**
 * How this terminal replays a row another program drew.
 *
 * A tool that watches a pty-backed process reports the screen that process wrote, verbatim, on a span
 * marked `captured`. Deciding what to do with those bytes is the host's, and this is the terminal's
 * answer: keep the styles a terminal can reproduce safely, drop everything else, and draw the row
 * over the body colour the theme uses for tool output.
 *
 * Only the visual subset survives. Cursor moves, screen clears, scroll regions, mode switches and
 * OSC sequences are the program addressing a terminal it does not have here -- the row is one line of
 * a card, not a screen it owns -- so they are stripped rather than replayed. A colour the program
 * chose is data and is kept; a colour it could not have meant (a truecolor channel above 255) is not.
 */

import { sanitizeText } from "@veyyon/utils";
import { SGR_RESET, sgrSequence } from "@veyyon/utils/ansi";

const SGR = sgrSequence("g");

/** `;` and `:` both separate SGR parameters; see the split in {@link styleTerminalRow}. */
const SGR_PARAMETER_SEPARATOR = /[;:]/;

/**
 * Whether every code in one SGR sequence is a style this terminal reproduces.
 *
 * Read as a stream rather than a set, because a colour code consumes the parameters after it: `38`
 * takes a mode and then either one palette index or three channels, and a sequence that runs out
 * mid-colour is malformed rather than partly usable.
 */
function isSafeStyle(codes: readonly number[]): boolean {
	let index = 0;
	while (index < codes.length) {
		const code = codes[index++];
		if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7 || code === 9 || code === 53) continue;
		if (code !== 38 && code !== 48) return false;
		const mode = codes[index++];
		if (mode === 5) {
			const color = codes[index++];
			if (color === undefined || color < 0 || color > 255) return false;
			continue;
		}
		if (mode !== 2) return false;
		for (let channel = 0; channel < 3; channel++) {
			const color = codes[index++];
			if (color === undefined || color < 0 || color > 255) return false;
		}
	}
	return true;
}

/** Applies the active tool-output color while preserving safe styles from a virtual terminal row. */
export function styleTerminalRow(row: string, baseForeground: string): string {
	let output = baseForeground;
	let offset = 0;
	let hasText = false;
	for (const match of row.matchAll(SGR)) {
		const index = match.index ?? 0;
		const text = sanitizeText(row.slice(offset, index));
		output += text;
		hasText ||= text.length > 0;

		// Split on BOTH separators. A truecolor SGR is written either `38;2;r;g;b` or
		// `38:2:r:g:b`, and libvte and several test runners emit the colon form. Splitting on
		// `;` alone made the whole thing one non-numeric token, so `isSafeStyle` rejected a
		// colour it fully understands and the row came back unstyled. The sequence is replayed
		// verbatim once validated, so the caller's terminal still receives whichever form the
		// program originally wrote.
		const codes = match[1].split(SGR_PARAMETER_SEPARATOR).map(Number);
		if (match[1] === "0") output += `${SGR_RESET}${baseForeground}`;
		else if (codes.length > 0 && codes.every(Number.isInteger) && isSafeStyle(codes)) output += match[0];
		offset = index + match[0].length;
	}
	const text = sanitizeText(row.slice(offset));
	output += text;
	hasText ||= text.length > 0;
	return hasText ? `${output}${SGR_RESET}` : "";
}
