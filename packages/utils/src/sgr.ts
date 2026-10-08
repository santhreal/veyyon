/**
 * Carrying an SGR styling run across a cut, and re-opening a background that the
 * content inside it reset.
 *
 * A renderer that slices a styled line has to replay the style state that was open
 * where it cut, or the remainder renders unstyled. These are the string rewrites
 * that state is carried by. No terminal I/O.
 */

import { ESC, SGR_BG_RESET, SGR_RESET, SGR_RESET_SHORT, sgrSequence } from "./ansi";
import { padding } from "./padding";
import { visibleWidth } from "./width";

const SGR_SEQUENCE_GLOBAL = sgrSequence("g");

/**
 * Everything before the last full SGR reset is dead state — drop it so a
 * re-played carry stays bounded by the live style run instead of the whole
 * code history.
 */
export function compactSgrCarry(carry: string): string {
	// Both spellings of the reset, and the cut is measured from each constant's own length
	// rather than from a literal 3 and 4. The lengths were inline next to inline bytes, so
	// changing either spelling meant remembering to change a number three lines away.
	const shortReset = carry.lastIndexOf(SGR_RESET_SHORT);
	const longReset = carry.lastIndexOf(SGR_RESET);
	const cut = Math.max(
		shortReset === -1 ? -1 : shortReset + SGR_RESET_SHORT.length,
		longReset === -1 ? -1 : longReset + SGR_RESET.length,
	);
	return cut === -1 ? carry : carry.slice(cut);
}

/**
 * Re-open `background` after every reset in `text`, so a painted ground survives its content.
 *
 * A component that paints a background behind a row cannot trust the row: an inner
 * `ESC [ 0 m` from a reverse-video cursor, a themed span, or a wrapped tool output clears the
 * background from that point on and punches a hole in the ground for the rest of the line. The
 * fix is to re-emit the background immediately after each reset, which is what every painter
 * here was already doing, separately.
 *
 * THREE COPIES, THREE DIFFERENT ANSWERS, which is why this is one function now.
 * `coding-agent/src/modes/terminal/draw/output-block.ts` handled `ESC [ 0 m` and `ESC [ 49 m`,
 * `tui/src/components/editor.ts` handled only `ESC [ 0 m`, and
 * `coding-agent/src/modes/terminal/components/chrome/sun.ts` handled both but DROPPED the `ESC [ 49 m` instead
 * of keeping it. None of the three handled `ESC [ m`, the parameterless reset, which means the
 * same hole for content that happens to spell its reset the short way. Each miss is a visible
 * defect in one surface and not in the others, which is the shape a reader has no way to
 * notice from any single site.
 *
 * All three resets are KEPT and the background re-emitted after them. Keeping the reset matters
 * for `ESC [ 0 m`, which the content emitted to clear its foreground as well; for `ESC [ 49 m`
 * it makes no visible difference, because the background that follows overrides it either way,
 * and one rule is easier to read than two.
 *
 * One left-to-right read inserts the background once after each reset in `text`; a background
 * that is itself a reset is never read as another one. A row with no reset is returned as is.
 */
export function reopenBackgroundAfterResets(text: string, background: string): string {
	if (!text.includes(SGR_RESET) && !text.includes(SGR_RESET_SHORT) && !text.includes(SGR_BG_RESET)) return text;
	let out = "";
	let copied = 0;
	for (let esc = text.indexOf(ESC); esc !== -1; esc = text.indexOf(ESC, esc + 1)) {
		const end = sgrResetEnd(text, esc);
		if (end === -1) continue;
		out += text.slice(copied, end) + background;
		copied = end;
	}
	return out + text.slice(copied);
}

/**
 * End of the reset starting at the `ESC` at `esc` (`SGR_RESET_SHORT`, `SGR_RESET` or `SGR_BG_RESET`),
 * or -1. Compares code units rather than calling `startsWith` three times per escape, which a styled
 * row holds dozens of.
 */
function sgrResetEnd(text: string, esc: number): number {
	if (text.charCodeAt(esc + 1) !== 0x5b) return -1;
	const first = text.charCodeAt(esc + 2);
	if (first === 0x6d) return esc + 3;
	if (first === 0x30) return text.charCodeAt(esc + 3) === 0x6d ? esc + 4 : -1;
	if (first === 0x34 && text.charCodeAt(esc + 3) === 0x39) return text.charCodeAt(esc + 4) === 0x6d ? esc + 5 : -1;
	return -1;
}

/**
 * Advance an SGR carry across `text`: the returned string, replayed at the
 * start of whatever follows `text`, restores the styling state open at its
 * end. Compacts at every step so the carry never grows past the live run.
 */
export function sgrCarryAfter(carry: string, text: string): string {
	return compactSgrCarry(carry + (text.match(SGR_SEQUENCE_GLOBAL)?.join("") ?? ""));
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	// Apply background to content + padding
	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}
