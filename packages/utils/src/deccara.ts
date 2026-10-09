/**
 * DECCARA rectangular-SGR background-fill optimizer.
 *
 * Kitty extends VT510 DECCARA ("Change Attributes in Rectangular Area") to all
 * SGR attributes, including background color, so a solid background panel can be
 * painted as a single rectangle escape instead of a full-width run of
 * background-styled spaces on every row (see kitty `docs/deccara.rst`):
 *
 *   <ESC>[2*x                 DECSACE: select rectangle change extent
 *   <ESC>[Pt;Pl;Pb;Pr;<sgr>$r DECCARA: apply <sgr> to rows Pt..Pb, cols Pl..Pr
 *   <ESC>[*x                  DECSACE: restore default extent
 *
 * Coordinates are 1-based and inclusive. This module is a pure, renderer-level
 * planner: it consumes the *final* ANSI strings the renderer would otherwise
 * write, strips the trailing background-padded spaces it can prove are safe to
 * drop, and returns the rectangles to emit in their place. It never mutates
 * component output and never decides which rows are scrollback-bound — those
 * concerns belong to the caller in `tui.ts`.
 */

import { SGR_RESET } from "./ansi";
import { visibleWidth } from "./width";

/** Reset every attribute (SGR 0). Mirrors `tui.ts`'s per-line terminator. */

/** DECSACE — select the rectangle change extent so DECCARA fills a rectangle. */
export const DECSACE_RECT = "\x1b[2*x";
/** DECSACE — restore the default (stream) change extent. */
export const DECSACE_DEFAULT = "\x1b[*x";

/**
 * Byte cost of the per-frame DECSACE wrapper ({@link DECSACE_RECT} +
 * {@link DECSACE_DEFAULT}) that brackets every rectangle batch. Charged once per
 * frame: a plan is emitted only when the trailing-space bytes it removes exceed
 * the rectangles' own bytes by more than this, so the optimizer never inflates.
 */
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

/**
 * Fold one SGR parameter list into the active background-color parameter string.
 * Returns the new background (`null` = default/no background) or {@link BAIL}
 * when the sequence contains a background form this optimizer will not reason
 * about (colon-form extended color, malformed params). Foreground and style
 * parameters are skipped; only background state is tracked.
 */
function nextBackground(bg: BgState, params: string): BgState | typeof BAIL {
	// CSI m with no parameters is SGR 0 (reset everything).
	if (params.length === 0) return null;
	const tokens = params.split(";");
	let result: BgState = bg;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		// An empty parameter defaults to 0 (reset), matching terminal behavior.
		const n = token.length === 0 ? 0 : Number(token);
		const extended = n === 38 || n === 48;
		const next = extended ? extendedBackground(n, tokens, i, result) : plainBackground(n, token, result);
		if (next === BAIL) return BAIL;
		result = next;
		// The sub-parameters extendedBackground accepted are consumed with their color.
		if (extended) i += tokens[i + 1] === "5" ? 2 : 4;
	}
	return result;
}

/**
 * The background after the plain parameter `n`, spelled `token`: none after a reset, the basic or
 * bright color it sets, or `bg` for any other parameter; BAIL for a non-integer.
 */
function plainBackground(n: number, token: string, bg: BgState): BgState | typeof BAIL {
	if (!Number.isInteger(n)) return BAIL;
	if (n === 0 || n === 49) return null;
	if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) return token;
	// Every other parameter (foreground 30-39/90-97, styles) leaves bg alone.
	return bg;
}

/**
 * The background after the extended color `n` (`38` or `48`) at `tokens[at]`: `bg` for a foreground,
 * else the `48;5;<index>` or `48;2;<r>;<g>;<b>` it sets. BAIL for a mode other than `5` or `2`, and for
 * a background whose sub-parameters run past the list. Colon-form (`48:2:...`) never reaches here: it
 * is one non-integer token.
 */
function extendedBackground(n: number, tokens: readonly string[], at: number, bg: BgState): BgState | typeof BAIL {
	const mode = tokens[at + 1];
	if (mode !== "5" && mode !== "2") return BAIL;
	// A foreground color changes no background, whatever sub-parameters follow it.
	if (n === 38) return bg;
	if (mode === "5") return at + 2 < tokens.length ? `48;5;${tokens[at + 2]}` : BAIL;
	return at + 4 < tokens.length ? `48;2;${tokens[at + 2]};${tokens[at + 3]};${tokens[at + 4]}` : BAIL;
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

/**
 * Decide whether `line` (a final, width-fit, reset-terminated ANSI string) is a
 * full-width background fill whose trailing padding can be replaced by a DECCARA
 * rectangle. Returns `null` unless it can *prove* the dropped bytes are literal
 * trailing spaces under a single, constant, non-default background span (or the
 * entire row is background-styled spaces).
 *
 * Conservative by construction: any OSC sequence (hyperlinks/images), any
 * non-SGR CSI, a partial row, an inconsistent or default trailing background, or
 * a malformed escape all yield `null` so the caller keeps the exact original.
 */
export function analyzeBgFillLine(line: string, width: number): BgFillAnalysis | null {
	if (width <= 0 || line.length === 0) return null;
	return new BgFillScanner(line).analyze(width);
}

/** Background under the trailing padding: `undefined` before any padding, BAIL once it changes. */
type TrailBg = BgState | typeof BAIL | undefined;

/** One left-to-right pass of {@link analyzeBgFillLine} over a line. */
class BgFillScanner {
	readonly #line: string;
	#bg: BgState = null;
	/** Visible columns scanned so far. */
	#col = 0;
	/** Byte index and column immediately after the last non-space printable glyph. */
	#contentEnd = 0;
	#contentEndCol = 0;
	/** `null` is a real "default background" value, so it cannot double as the not-started state. */
	#trail: TrailBg = undefined;

	constructor(line: string) {
		this.#line = line;
	}

	analyze(width: number): BgFillAnalysis | null {
		const line = this.#line;
		let i = 0;
		while (i < line.length) {
			i = line.charCodeAt(i) === 0x1b ? this.#escape(i) : this.#run(i);
			if (i < 0) return null;
		}
		// Not a full-width fill, or no trailing padding to drop.
		if (this.#col !== width || this.#contentEndCol >= width) return null;
		const trail = this.#trail;
		// A default or mixed background under the padding leaves nothing safe to paint.
		if (trail === undefined || trail === null || trail === BAIL) return null;
		return { cut: this.#contentEnd, leftCol: this.#contentEndCol, bg: trail };
	}

	/** Folds the escape at `i` into the background: the index past it, or -1 for anything but SGR. */
	#escape(i: number): number {
		// Only CSI SGR (`\x1b[ ... m`) is tolerated. OSC, APC, and any other
		// CSI mean styled hyperlinks/images/cursor markers — refuse to touch.
		const line = this.#line;
		if (line.charCodeAt(i + 1) !== 0x5b) return -1;
		let end = i + 2;
		while (end < line.length) {
			const c = line.charCodeAt(end);
			if (c >= 0x40 && c <= 0x7e) break;
			end++;
		}
		// An unterminated CSI reads NaN past the end; a non-SGR CSI has a final byte other than `m`.
		if (line.charCodeAt(end) !== 0x6d) return -1;
		const next = nextBackground(this.#bg, line.slice(i + 2, end));
		if (next === BAIL) return -1;
		this.#bg = next;
		return end + 1;
	}

	/** Measures the printable run at `i`, which ends at the next escape: the index past it. */
	#run(i: number): number {
		const line = this.#line;
		let end = line.indexOf("\x1b", i);
		if (end < 0) end = line.length;
		const text = line.slice(i, end);
		let contentLength = text.length;
		while (contentLength > 0 && text.charCodeAt(contentLength - 1) === 0x20) contentLength--;
		if (contentLength === 0) {
			// The whole run is spaces: it extends the trailing padding, whose background must not drift.
			this.#trail = this.#trail === undefined || this.#trail === this.#bg ? this.#bg : BAIL;
			this.#col += visibleWidth(text);
			return end;
		}
		// A run with a glyph restarts the padding after it. Spaces after the glyph sit under the current
		// background; with none, the padding has not started and a later SGR can still begin a uniform fill.
		const contentWidth = visibleWidth(text.slice(0, contentLength));
		this.#contentEnd = i + contentLength;
		this.#contentEndCol = this.#col + contentWidth;
		this.#trail = contentLength < text.length ? this.#bg : undefined;
		this.#col += contentLength === text.length ? contentWidth : visibleWidth(text);
		return end;
	}
}

/** A fillable row: its rectangle's 1-based left column and background, the row it shortens to, and the bytes that drops. */
interface FillCandidate {
	left: number;
	bg: string;
	short: string;
	removed: number;
}

/** Per-frame plan: the (possibly shortened) row strings and the DECCARA batch. */
export interface DeccaraPlan {
	/** Row strings to write, parallel to the input. Optimized rows are shortened. */
	texts: string[];
	/** DECSACE-wrapped rectangle batch to emit after the rows, or `""` if none. */
	sequence: string;
}

/**
 * Plan DECCARA rectangles for a contiguous block of visible rows.
 *
 * `lines[k]` is the final ANSI string for screen row `firstScreenRow + k`
 * (0-based). For each fillable row the trailing background padding is removed
 * (the row's cells are cleared/erased by the caller, then repainted by the
 * rectangle), and vertically adjacent rows with an identical left/right/bg span
 * coalesce into one rectangle. Rectangles are emitted only when they save more
 * bytes than they cost, so the result never exceeds the original byte count.
 */
export function planDeccaraFills(lines: string[], width: number, firstScreenRow = 0): DeccaraPlan {
	const n = lines.length;
	const texts: string[] = new Array(n);
	const candidates: (FillCandidate | null)[] = new Array(n);
	for (let k = 0; k < n; k++) {
		texts[k] = lines[k];
		candidates[k] = fillCandidate(lines[k], width);
	}

	// Collect coalesced groups whose rectangle at least pays for its own bytes.
	// The DECSACE wrapper is a single per-frame cost, so it is charged once below
	// rather than amortized into each group (which would over-reject lone rows).
	const groups: FillGroup[] = [];
	let saved = 0;
	for (let k = 0; k < n; k++) {
		const head = candidates[k];
		if (!head) continue;
		const end = groupEnd(candidates, k, head);
		const rect = encodeDeccara(firstScreenRow + k + 1, head.left, firstScreenRow + end + 1, width, head.bg);
		const removed = removedBytes(candidates, k, end);
		if (removed > rect.length) {
			groups.push({ start: k, end, rect });
			saved += removed - rect.length;
		}
		k = end;
	}

	// Emit nothing unless the batch beats the original by more than the wrapper.
	if (groups.length === 0 || saved <= DECSACE_WRAPPER_BYTES) return { texts, sequence: "" };
	let sequence = DECSACE_RECT;
	for (const group of groups) {
		for (let r = group.start; r <= group.end; r++) {
			const c = candidates[r];
			if (c) texts[r] = c.short;
		}
		sequence += group.rect;
	}
	return { texts, sequence: sequence + DECSACE_DEFAULT };
}

/** Rows `start` through `end` of a frame, coalesced under the one rectangle `rect`. */
interface FillGroup {
	start: number;
	end: number;
	rect: string;
}

/** The {@link FillCandidate} for `line`, or `null` when it is not a fillable row. */
function fillCandidate(line: string, width: number): FillCandidate | null {
	const analysis = analyzeBgFillLine(line, width);
	if (!analysis) return null;
	// Cut at the last non-space glyph and re-close attributes. An all-space row
	// (cut 0) needs no styled text at all — the caller's erase plus the
	// rectangle paint it. A content row keeps its prefix and a fresh reset so
	// the inline background never bleeds past the row.
	const short = analysis.cut === 0 ? "" : line.slice(0, analysis.cut) + SGR_RESET;
	return { left: analysis.leftCol + 1, bg: analysis.bg, short, removed: line.length - short.length };
}

/** The last row from `start` that shares `head`'s fill span, so one rectangle covers them all. */
function groupEnd(candidates: readonly (FillCandidate | null)[], start: number, head: FillCandidate): number {
	let end = start;
	while (end + 1 < candidates.length) {
		const next = candidates[end + 1];
		if (!next || next.left !== head.left || next.bg !== head.bg) break;
		end++;
	}
	return end;
}

/** Bytes that rows `start` through `end` drop when shortened. */
function removedBytes(candidates: readonly (FillCandidate | null)[], start: number, end: number): number {
	let removed = 0;
	for (let r = start; r <= end; r++) removed += candidates[r]?.removed ?? 0;
	return removed;
}
