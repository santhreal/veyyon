/** DECCARA rectangular-SGR background-fill optimizer. */

import { SGR_RESET } from "./ansi";
import { visibleWidth } from "./utils";

/** Reset every attribute (SGR 0). Mirrors `tui.ts`'s per-line terminator. */

/** DECSACE — select the rectangle change extent so DECCARA fills a rectangle. */
export const DECSACE_RECT = "\x1b[2*x";
/** DECSACE — restore the default (stream) change extent. */
export const DECSACE_DEFAULT = "\x1b[*x";

/** Byte cost of the per-frame DECSACE wrapper. */
const DECSACE_WRAPPER_BYTES = DECSACE_RECT.length + DECSACE_DEFAULT.length;

/**
 * Encode a single DECCARA rectangle. `top`/`bottom` are 1-based inclusive screen
 * rows, `left`/`right` 1-based inclusive columns, `sgr` the raw SGR parameter
 * list to apply (e.g. `48;2;10;20;30`, `48;5;4`, `41`).
 */
export function encodeDeccara(top: number, left: number, bottom: number, right: number, sgr: string): string {
	return `\x1b[${top};${left};${bottom};${right};${sgr}$r`;
}

/** Sentinel for a background form this optimizer refuses to reason about. */
const BAIL = Symbol("deccara-bail");
type BgState = string | null;

/** Parse a non-negative integer from `line[start..end)` via charCodeAt. Returns -1 if any byte is not a digit. */
function parseSgrInt(line: string, start: number, end: number): number {
	let n = 0;
	for (let i = start; i < end; i++) {
		const c = line.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return -1;
		n = n * 10 + (c - 0x30);
	}
	return n;
}

/** Fold an SGR parameter list into the active background-color parameter string. */
function nextBackground(bg: BgState, line: string, start: number, end: number): BgState | typeof BAIL {
	// CSI m with no parameters is SGR 0 (reset everything).
	if (end <= start) return null;
	let result: BgState = bg;
	let pos = start;
	while (pos <= end) {
		// Find the next ';' or end of params.
		let semi = pos;
		while (semi < end && line.charCodeAt(semi) !== 0x3b) semi++;
		const tokenLen = semi - pos;
		// An empty parameter defaults to 0 (reset), matching terminal behavior.
		const n = tokenLen === 0 ? 0 : parseSgrInt(line, pos, semi);
		if (tokenLen > 0 && n < 0) return BAIL;
		if (n === 0 || n === 49) {
			result = null;
			pos = semi + 1;
			continue;
		}
		if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
			result = line.slice(pos, semi);
			pos = semi + 1;
			continue;
		}
		if (n === 48) {
			// Read the next token (mode).
			pos = semi + 1;
			let semi2 = pos;
			while (semi2 < end && line.charCodeAt(semi2) !== 0x3b) semi2++;
			const modeLen = semi2 - pos;
			if (modeLen === 1 && line.charCodeAt(pos) === 0x35) {
				// Mode "5": indexed color. Read idx token.
				pos = semi2 + 1;
				let semi3 = pos;
				while (semi3 < end && line.charCodeAt(semi3) !== 0x3b) semi3++;
				if (semi3 > end) return BAIL;
				result = `48;5;${line.slice(pos, semi3)}`;
				pos = semi3 + 1;
				continue;
			}
			if (modeLen === 1 && line.charCodeAt(pos) === 0x32) {
				// Mode "2": truecolor. Read r;g;b tokens.
				const rStart = semi2 + 1;
				let rEnd = rStart;
				while (rEnd < end && line.charCodeAt(rEnd) !== 0x3b) rEnd++;
				const gStart = rEnd + 1;
				let gEnd = gStart;
				while (gEnd < end && line.charCodeAt(gEnd) !== 0x3b) gEnd++;
				const bStart = gEnd + 1;
				let bEnd = bStart;
				while (bEnd < end && line.charCodeAt(bEnd) !== 0x3b) bEnd++;
				if (rEnd > end || gEnd > end || bEnd > end) return BAIL;
				result = `48;2;${line.slice(rStart, rEnd)};${line.slice(gStart, gEnd)};${line.slice(bStart, bEnd)}`;
				pos = bEnd + 1;
				continue;
			}
			// Colon-form (`48:2:...`) collapses to a single non-integer token and is
			// rejected above; anything else following 48 is unexpected — bail.
			return BAIL;
		}
		if (n === 38) {
			// Foreground extended color: skip its sub-parameters, leave bg alone.
			pos = semi + 1;
			let semi2 = pos;
			while (semi2 < end && line.charCodeAt(semi2) !== 0x3b) semi2++;
			const modeLen = semi2 - pos;
			if (modeLen === 1 && line.charCodeAt(pos) === 0x35) {
				pos = semi2 + 1;
				// Skip the idx token.
				while (pos <= end && line.charCodeAt(pos) !== 0x3b) pos++;
				pos++;
				continue;
			}
			if (modeLen === 1 && line.charCodeAt(pos) === 0x32) {
				// Skip r;g;b tokens.
				pos = semi2 + 1;
				for (let skip = 0; skip < 3; skip++) {
					while (pos <= end && line.charCodeAt(pos) !== 0x3b) pos++;
					pos++;
				}
				continue;
			}
			return BAIL;
		}
		// Every other parameter (foreground 30-39/90-97, styles) leaves bg alone.
		pos = semi + 1;
	}
	return result;
}

/** Where to cut a fillable line and the background to paint over the remainder. */
export interface BgFillAnalysis {
	/** Byte index where droppable trailing background padding begins (0 = whole line). */
	cut: number;
	/** 0-based column where the trailing padding begins (DECCARA left = leftCol + 1). */
	leftCol: number;
	/** SGR parameter list of the background covering the trailing region. */
	bg: string;
}

/** Determine if a line's trailing background padding can be replaced by DECCARA. */
export function analyzeBgFillLine(line: string, width: number): BgFillAnalysis | null {
	if (width <= 0 || line.length === 0) return null;
	let i = 0;
	let col = 0;
	let bg: BgState = null;
	// Byte index / column immediately after the last non-space printable glyph.
	let nonSpaceEndByte = 0;
	let nonSpaceEndCol = 0;
	// Background covering the current trailing run of spaces, and whether that
	// trailing run has started. `null` is a real "default background" value, so
	// it cannot double as the uninitialized sentinel.
	let trailBg: BgState = null;
	let trailStarted = false;
	let trailConsistent = true;

	while (i < line.length) {
		if (line.charCodeAt(i) === 0x1b) {
			// Only CSI SGR (`\x1b[ ... m`) is tolerated. OSC, APC, and any other
			// CSI mean styled hyperlinks/images/cursor markers — refuse to touch.
			if (line.charCodeAt(i + 1) !== 0x5b) return null;
			let j = i + 2;
			while (j < line.length) {
				const c = line.charCodeAt(j);
				if (c >= 0x40 && c <= 0x7e) break;
				j++;
			}
			if (j >= line.length) return null; // unterminated CSI
			if (line.charCodeAt(j) !== 0x6d) return null; // non-SGR CSI (final byte != 'm')
			const next = nextBackground(bg, line, i + 2, j);
			if (next === BAIL) return null;
			bg = next;
			i = j + 1;
			continue;
		}

		// Printable run up to the next escape.
		let j = i;
		while (j < line.length && line.charCodeAt(j) !== 0x1b) j++;
		// Fast path: scan the printable run in-place. For pure ASCII (no chars
		// outside 0x20–0x7e), width equals byte length and no slice is needed.
		const runLen = j - i;
		let ascii = true;
		for (let k = i; k < j; k++) {
			const c = line.charCodeAt(k);
			if (c < 0x20 || c > 0x7e) {
				ascii = false;
				break;
			}
		}
		let nonSpaceLen = runLen;
		let totalWidth: number;
		if (ascii) {
			while (nonSpaceLen > 0 && line.charCodeAt(i + nonSpaceLen - 1) === 0x20) nonSpaceLen--;
			totalWidth = runLen;
		} else {
			const text = line.slice(i, j);
			nonSpaceLen = text.length;
			while (nonSpaceLen > 0 && text.charCodeAt(nonSpaceLen - 1) === 0x20) nonSpaceLen--;
			totalWidth = visibleWidth(text);
		}
		if (nonSpaceLen > 0) {
			// Run carries a non-space glyph: the trailing region restarts after it.
			// Trailing chars are all 0x20 (1 cell each), so nonSpaceWidth is total minus them.
			const nonSpaceWidth = totalWidth - (runLen - nonSpaceLen);
			nonSpaceEndByte = i + nonSpaceLen;
			nonSpaceEndCol = col + nonSpaceWidth;
			// Spaces after the last non-space glyph in this same printable run sit
			// under the current bg. If there are none, the trailing region has not
			// started yet; a later SGR can still begin a uniform fill safely.
			if (nonSpaceLen < runLen) {
				trailBg = bg;
				trailStarted = true;
			} else {
				trailBg = null;
				trailStarted = false;
			}
			trailConsistent = true;
		} else if (runLen > 0) {
			// Whole run is spaces: it extends the trailing region. Track bg drift.
			if (!trailStarted) {
				trailBg = bg;
				trailStarted = true;
			} else if (bg !== trailBg) {
				trailConsistent = false;
			}
		}
		col += totalWidth;
		i = j;
	}

	if (col !== width) return null; // not a full-width fill
	if (nonSpaceEndCol >= width) return null; // no trailing padding to drop
	if (!trailStarted || trailBg === null || !trailConsistent) return null; // default/mixed bg — nothing safe to paint
	return { cut: nonSpaceEndByte, leftCol: nonSpaceEndCol, bg: trailBg };
}

interface FillCandidate {
	left: number;
	right: number;
	bg: string;
	short: string;
	origLen: number;
}

/** Per-frame plan: the (possibly shortened) row strings and the DECCARA batch. */
export interface DeccaraPlan {
	/** Row strings to write, parallel to the input. Optimized rows are shortened. */
	texts: string[];
	/** DECSACE-wrapped rectangle batch to emit after the rows, or `""` if none. */
	sequence: string;
}

/** Plan DECCARA rectangles for a contiguous block of visible rows. */
export function planDeccaraFills(lines: string[], width: number, firstScreenRow = 0): DeccaraPlan {
	const n = lines.length;
	const texts: string[] = new Array(n);
	const candidates: (FillCandidate | null)[] = new Array(n);

	for (let k = 0; k < n; k++) {
		const line = lines[k];
		texts[k] = line;
		const analysis = analyzeBgFillLine(line, width);
		if (!analysis) {
			candidates[k] = null;
			continue;
		}
		// Cut at the last non-space glyph and re-close attributes. An all-space row
		// (cut 0) needs no styled text at all — the caller's erase plus the
		// rectangle paint it. A content row keeps its prefix and a fresh reset so
		// the inline background never bleeds past the row.
		const short = analysis.cut === 0 ? "" : line.slice(0, analysis.cut) + SGR_RESET;
		candidates[k] = { left: analysis.leftCol + 1, right: width, bg: analysis.bg, short, origLen: line.length };
	}

	// Collect coalesced groups whose rectangle at least pays for its own bytes.
	// The DECSACE wrapper is a single per-frame cost, so it is charged once below
	// rather than amortized into each group (which would over-reject lone rows).
	interface Group {
		start: number;
		end: number;
		rect: string;
	}
	const groups: Group[] = [];
	let removedTotal = 0;
	let rectBytesTotal = 0;
	let k = 0;
	while (k < n) {
		const head = candidates[k];
		if (!head) {
			k++;
			continue;
		}
		// Extend the group over adjacent rows sharing the same fill span.
		let end = k;
		while (end + 1 < n) {
			const next = candidates[end + 1];
			if (!next || next.left !== head.left || next.right !== head.right || next.bg !== head.bg) break;
			end++;
		}
		const rect = encodeDeccara(firstScreenRow + k + 1, head.left, firstScreenRow + end + 1, head.right, head.bg);
		let removed = 0;
		for (let r = k; r <= end; r++) {
			const c = candidates[r];
			if (c) removed += c.origLen - c.short.length;
		}
		if (removed > rect.length) {
			groups.push({ start: k, end, rect });
			removedTotal += removed;
			rectBytesTotal += rect.length;
		}
		k = end + 1;
	}

	// Emit nothing unless the batch beats the original by more than the wrapper.
	if (groups.length === 0 || removedTotal - rectBytesTotal <= DECSACE_WRAPPER_BYTES) {
		return { texts, sequence: "" };
	}
	let sequence = DECSACE_RECT;
	for (let gi = 0; gi < groups.length; gi++) {
		const group = groups[gi]!;
		for (let r = group.start; r <= group.end; r++) {
			const c = candidates[r];
			if (c) texts[r] = c.short;
		}
		sequence += group.rect;
	}
	sequence += DECSACE_DEFAULT;
	return { texts, sequence };
}
