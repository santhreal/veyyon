/**
 * Line wrapping and tab expansion over text that may carry ANSI styling.
 *
 * The wrap itself is the native `wrapTextWithAnsi` binding; this module owns the
 * input normalization it needs and the tab expansion every renderer applies before
 * measuring. No terminal I/O.
 */

import { wrapTextWithAnsi as nativeWrapTextWithAnsi } from "@veyyon/natives";
import { collapseWhitespace } from "./collapse-whitespace";
import { DEFAULT_TAB_WIDTH, replaceTabs } from "./tab-width";

// `replaceTabs` is `./tab-width`'s; it stays on this subpath because callers pinned at earlier
// commits (the historical renderer oracles the differential suites load from Git) import it here.
export { replaceTabs } from "./tab-width";

/**
 * Normalize CR and CRLF to LF for wrapping. The native wrapper breaks only
 * on LF, so a `\r\n` source leaves a trailing `\r` on the wrapped row and a
 * bare `\r` stays embedded — either one moves the terminal cursor to column 0
 * and corrupts the line. Universal-newline normalization (`\r\n` and bare `\r`
 * both become `\n`) keeps every produced row a single clean line. Guarded on
 * `includes` so the overwhelmingly common CR-free text pays one scan rather
 * than a regex rewrite. Exported so callers that index into the text they
 * pass to {@link wrapTextWithAnsi} can align their offsets with what the
 * wrapper actually wraps.
 */
export function normalizeWrapInput(text: string): string {
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/**
 * The cells `text` fills when the native wrapper would return it unchanged as one row, else -1.
 *
 * Only printable ASCII and SGR sequences (`ESC [` digits, `;` or `:`, then `m`) are counted: every
 * other character needs the native width tables and every other escape the native parser. A line
 * whose leading indent puts a space after an SGR sequence is refused too, because the native hanging
 * indent writes an indent's spaces ahead of its sequences and so returns such a line reordered.
 */
function unchangedRowCells(text: string): number {
	let cells = 0;
	let inIndent = true;
	let indentEscape = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x1b) {
			if (text.charCodeAt(i + 1) !== 0x5b) return -1;
			let end = i + 2;
			for (; end < text.length; end++) {
				const param = text.charCodeAt(end);
				if (param < 0x30 || param > 0x3b) break;
			}
			if (text.charCodeAt(end) !== 0x6d) return -1;
			if (inIndent) indentEscape = true;
			i = end;
			continue;
		}
		if (code < 0x20 || code > 0x7e) return -1;
		if (inIndent) {
			if (code !== 0x20) inIndent = false;
			else if (indentEscape) return -1;
		}
		cells++;
	}
	return cells;
}

/**
 * `text` broken into rows of at most `width` cells, with the SGR state carried across each break.
 *
 * A line that already fits, in printable ASCII and SGR, is returned as the one row the native wrapper
 * would return for it, without crossing into the native binding: a rebuilt 659k-row transcript made
 * 1.83M wrap calls, 87% of them for such a line, and returning those here took the calls from 1.69 s
 * to 0.93 s. `width` is read as the native binding reads it, as an unsigned 32-bit integer.
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	const cells = unchangedRowCells(text);
	if (cells !== -1 && cells <= width >>> 0) return [text];
	return nativeWrapTextWithAnsi(normalizeWrapInput(text), width, DEFAULT_TAB_WIDTH);
}

/**
 * Flatten text to a single trimmed line: expand tabs (`replaceTabs` in `./tab-width`), collapse
 * every run of whitespace (including newlines) to one space. Used by list components that
 * render one row per item and must never let an embedded newline break the row.
 *
 * The collapse itself belongs to `collapseWhitespace` in `@veyyon/utils`, the
 * repo-wide owner of that idiom; this is the tab-expanding wrapper over it, not a
 * second implementation. It used to inline the regexes (`[\r\n]+` then `\s+`,
 * the first of which the second already covers), which is the kind of copy that
 * drifts: `ask-dialog.ts` and `transcript-render-helpers.ts` were already calling
 * `collapseWhitespace(replaceTabs(...))` by hand for the same effect, so the
 * repository had two answers to one question.
 */
export function sanitizeSingleLine(text: string): string {
	return collapseWhitespace(replaceTabs(text));
}
