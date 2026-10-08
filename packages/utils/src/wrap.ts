/**
 * Line wrapping and tab expansion over text that may carry ANSI styling.
 *
 * The wrap itself is the native `wrapTextWithAnsi` binding; this module owns the
 * input normalization it needs and the tab expansion every renderer applies before
 * measuring. No terminal I/O.
 */

import { visibleWidth as nativeVisibleWidth, wrapTextWithAnsi as nativeWrapTextWithAnsi } from "@veyyon/natives";
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
 * Blocks whose every character is a grapheme cluster of its own, whatever stands beside it (Unicode
 * grapheme break property Other): Latin-1 but its soft hyphen, General Punctuation but its spaces,
 * joiners, separators and controls, arrows, mathematical operators, technical symbols, box drawing,
 * block elements, geometric shapes and dingbats. The native wrapper measures a row by cluster, so a
 * unit from these blocks adds the cells it measures alone to any row it is in.
 */
const ONE_CLUSTER_BLOCKS: readonly (readonly [number, number])[] = [
	[0x00a0, 0x00ac],
	[0x00ae, 0x00ff],
	[0x2010, 0x2027],
	[0x2030, 0x205e],
	[0x2190, 0x23ff],
	[0x2500, 0x25ff],
	[0x2700, 0x27bf],
];

/** The last unit {@link ONE_CLUSTER_BLOCKS} holds. */
const ONE_CLUSTER_END = 0x27bf;

/**
 * The verdict on each unit up to {@link ONE_CLUSTER_END}, filled the first time a row holds it:
 * 0 = not yet classified, 1 = one cell in any row, 2 = anything else.
 */
let oneCellVerdicts: Uint8Array | undefined;

/** Whether the native wrapper counts `code` as one cell in any row it is in. */
function isOneCellCluster(code: number): boolean {
	if (code > ONE_CLUSTER_END) return false;
	oneCellVerdicts ??= new Uint8Array(ONE_CLUSTER_END + 1);
	const known = oneCellVerdicts[code];
	if (known !== 0) return known === 1;
	const oneCell =
		ONE_CLUSTER_BLOCKS.some(([first, last]) => code >= first && code <= last) &&
		nativeVisibleWidth(String.fromCharCode(code), DEFAULT_TAB_WIDTH) === 1;
	oneCellVerdicts[code] = oneCell ? 1 : 2;
	return oneCell;
}

/**
 * The fewest cells of text the native hanging indent leaves a row: an indent that leaves fewer is
 * not hung. The native wrapper's `HANGING_INDENT_MIN_TEXT`.
 */
const HANGING_INDENT_MIN_TEXT = 4;

/**
 * The one row the native wrapper returns for `text` at `width` cells, when `text` fits in one row,
 * else `undefined`.
 *
 * Only printable ASCII, SGR sequences (`ESC [` digits, `;` or `:`, then `m`) and the units of
 * {@link isOneCellCluster} are counted: every other character needs the native width tables and
 * every other escape the native parser. A line that fits comes back as it is, except where its
 * leading indent puts a space after an SGR sequence and leaves {@link HANGING_INDENT_MIN_TEXT}
 * cells: the native hanging indent writes the indent's spaces first, then its sequences in order.
 */
function fittingRow(text: string, width: number): string | undefined {
	let cells = 0;
	let indent = 0;
	let contentAt = -1;
	let escapeInIndent = false;
	let reordered = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 0x1b) {
			if (text.charCodeAt(i + 1) !== 0x5b) return undefined;
			let end = i + 2;
			for (; end < text.length; end++) {
				const param = text.charCodeAt(end);
				if (param < 0x30 || param > 0x3b) break;
			}
			if (text.charCodeAt(end) !== 0x6d) return undefined;
			if (contentAt === -1) escapeInIndent = true;
			i = end;
			continue;
		}
		if ((code < 0x20 || code > 0x7e) && !isOneCellCluster(code)) return undefined;
		if (++cells > width) return undefined;
		if (contentAt !== -1) continue;
		if (code !== 0x20) contentAt = i;
		else {
			indent++;
			if (escapeInIndent) reordered = true;
		}
	}
	if (!reordered || contentAt === -1 || indent + HANGING_INDENT_MIN_TEXT > width) return text;
	let row = " ".repeat(indent);
	for (let i = 0; i < contentAt; i++) {
		if (text.charCodeAt(i) === 0x20) continue;
		const end = text.indexOf("m", i) + 1;
		row += text.slice(i, end);
		i = end - 1;
	}
	return row + text.slice(contentAt);
}

/**
 * `text` broken into rows of at most `width` cells, with the SGR state carried across each break.
 *
 * A line that already fits, in printable ASCII, SGR and one-cell punctuation and chrome, is returned
 * as the one row the native wrapper would return for it, without crossing into the native binding:
 * a rebuilt 659k-row transcript made 1.83M wrap calls, 87% of them for such a line, and returning
 * those here took the calls from 1.69 s to 0.93 s. `width` is read as the native binding reads it,
 * as an unsigned 32-bit integer.
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	const row = fittingRow(text, width >>> 0);
	if (row !== undefined) return [row];
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
