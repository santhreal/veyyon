/**
 * The bytes of each paint shape the engine writes. `TUI` selects the shape for a frame and holds
 * every piece of state a paint changes; these functions turn the rows and positions it passes in
 * into the escape sequence for that shape and read nothing else.
 *
 * Each sequence begins with `lead`, the caller's synchronized-output bracket followed by any
 * alt-screen exit and image purge, and leaves the hardware cursor on the row its documentation
 * states, so the caller's cursor placement continues from a known row.
 */
import { type DeccaraPlan, planDeccaraFills } from "@veyyon/utils/deccara";
import { clampLow } from "@veyyon/utils/math";
import { isConPTYHosted } from "../terminal";
import { TERMINAL } from "../terminal-capabilities";
import { relativeMoveY } from "./cursor";
import {
	type DirectImagePlacementLookup,
	lineRewriteSequence,
	terminalLine,
	truncateLargeConptyFrame,
} from "./renderer";

/**
 * Whether the rows a scroll-append commits, `frame[chunkFrom, chunkFrom + chunkLength)`,
 * are the rows the previous window painted at its top, unchanged since.
 */
export function chunkStillPainted(
	previousWindow: readonly string[],
	frame: readonly string[],
	chunkFrom: number,
	chunkLength: number,
	height: number,
): boolean {
	if (previousWindow.length !== height) return false;
	for (let i = 0; i < chunkLength; i++) {
		if (previousWindow[i] !== frame[chunkFrom + i]) return false;
	}
	return true;
}

/** First row in `[0, end)` of `window` that differs from `previous[row + offset]`, or -1 when none does. */
export function firstChangedRow(
	window: readonly string[],
	previous: readonly string[],
	offset: number,
	end: number,
): number {
	for (let r = 0; r < end; r++) {
		if ((window[r] ?? "") !== (previous[r + offset] ?? "")) return r;
	}
	return -1;
}

/** Last row in `[0, end)` of `window` that differs from `previous[row + offset]`, or -1 when none does. */
export function lastChangedRow(
	window: readonly string[],
	previous: readonly string[],
	offset: number,
	end: number,
): number {
	for (let r = end - 1; r >= 0; r--) {
		if ((window[r] ?? "") !== (previous[r + offset] ?? "")) return r;
	}
	return -1;
}

/**
 * Scroll-append: park on the bottom row, CRLF the new bottom rows in so the committed chunk
 * scrolls off into history, then rewrite the rows `[firstChanged, lastChanged]` of the shifted
 * window (none when `firstChanged` is -1).
 */
export function scrollAppendSequence(
	lead: string,
	window: readonly string[],
	width: number,
	height: number,
	scroll: number,
	currentScreenRow: number,
	firstChanged: number,
	lastChanged: number,
	budget: DirectImagePlacementLookup,
): string {
	let buffer = lead;
	const moveToBottom = height - 1 - currentScreenRow;
	if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
	for (let r = height - scroll; r < height; r++) {
		buffer += `\r\n${lineRewriteSequence(window[r] ?? "", width, r, budget)}`;
	}
	// Rewrite any remaining changed rows after the shift.
	if (firstChanged !== -1) {
		const up = height - 1 - firstChanged;
		if (up > 0) buffer += `\x1b[${up}A`;
		buffer += "\r";
		for (let r = firstChanged; r <= lastChanged; r++) {
			if (r > firstChanged) buffer += "\r\n";
			buffer += lineRewriteSequence(window[r] ?? "", width, r, budget);
		}
	}
	return buffer;
}

/**
 * In-window diff: move to the first changed row (or clamp to the viewport top for an in-place
 * rewrite) and rewrite rows `[firstChanged, lastChanged]`, leaving the cursor on the last of them.
 * With `deccara` the contiguous rewritten range is written as shortened rows plus DECCARA fill
 * rectangles, which address absolute screen rows and so cover visible rows only.
 */
export function windowDiffSequence(
	lead: string,
	window: readonly string[],
	width: number,
	height: number,
	firstChanged: number,
	lastChanged: number,
	inPlaceRewrite: boolean,
	currentScreenRow: number,
	deccara: boolean,
	budget: DirectImagePlacementLookup,
): string {
	let buffer = lead;
	if (inPlaceRewrite) {
		// The cursor tracker can be stale after overlay-only frames, and
		// meaningless after an uncommitted slide. A large CUU clamps at the
		// viewport top without using absolute cursor home, so the following
		// full-window rewrite cannot overflow the bottom.
		if (height > 1) buffer += `\x1b[${height - 1}A`;
	} else {
		buffer += relativeMoveY(firstChanged - currentScreenRow);
	}
	buffer += "\r";
	let fillTexts: string[] | null = null;
	let fillSequence = "";
	if (deccara) {
		const slice: string[] = new Array(lastChanged - firstChanged + 1);
		for (let r = firstChanged; r <= lastChanged; r++) slice[r - firstChanged] = window[r] ?? "";
		const plan = planDeccaraFills(slice, width, firstChanged);
		fillTexts = plan.texts;
		fillSequence = plan.sequence;
	}
	for (let r = firstChanged; r <= lastChanged; r++) {
		if (r > firstChanged) buffer += "\r\n";
		buffer += lineRewriteSequence(fillTexts ? fillTexts[r - firstChanged] : (window[r] ?? ""), width, r, budget);
	}
	return buffer + fillSequence;
}

/**
 * Seam rewrite. The cursor moves to the window top with a relative move; the chunk rows
 * `frame[chunkFrom, chunkTo)` pass through the screen and scroll off as the window rows are
 * written below them, so the rows entering scrollback are exactly the chunk.
 */
export function seamRewriteSequence(
	lead: string,
	frame: readonly string[],
	window: readonly string[],
	width: number,
	height: number,
	chunkFrom: number,
	chunkTo: number,
	currentScreenRow: number,
	budget: DirectImagePlacementLookup,
): string {
	let buffer = lead;
	if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
	buffer += "\r";
	let wroteLine = false;
	for (let i = chunkFrom; i < chunkTo; i++) {
		if (wroteLine) buffer += "\r\n";
		buffer += lineRewriteSequence(frame[i] ?? "", width);
		wroteLine = true;
	}
	for (let screenRow = 0; screenRow < height; screenRow++) {
		if (wroteLine) buffer += "\r\n";
		buffer += lineRewriteSequence(window[screenRow] ?? "", width, screenRow, budget);
		wroteLine = true;
	}
	return buffer;
}

/** Rewrite screen rows `[0, height)` from the home position, row `r` from `rows[r]`. */
export function homeRewriteSequence(
	lead: string,
	rows: readonly string[],
	width: number,
	height: number,
	budget: DirectImagePlacementLookup,
): string {
	let buffer = `${lead}\x1b[H`;
	for (let r = 0; r < height; r++) {
		if (r > 0) buffer += "\r\n";
		buffer += lineRewriteSequence(rows[r] ?? "", width, r, budget);
	}
	return buffer;
}

/**
 * Whether an alt-buffer paint of `rows` with the caret at `cursor` shows what the previous one
 * showed. A caret move alone is a change: the rows can be identical while the composer's cursor
 * moved along one of them.
 */
export function sameAltPaint(
	previousRows: readonly string[],
	previousCursor: { row: number; col: number } | undefined,
	rows: readonly string[],
	cursor: { row: number; col: number } | undefined,
): boolean {
	if (previousRows.length !== rows.length) return false;
	if (cursor === undefined || previousCursor === undefined) {
		if (cursor !== previousCursor) return false;
	} else if (previousCursor.row !== cursor.row || previousCursor.col !== cursor.col) {
		return false;
	}
	for (let r = 0; r < rows.length; r++) {
		if (rows[r] !== previousRows[r]) return false;
	}
	return true;
}

/**
 * Full alt-buffer rewrite: every row from home, then the caret placed with CUP (absolute, so the
 * row tracker is re-based rather than nudged) when `cursor` is set.
 */
export function altScreenSequence(
	lead: string,
	rows: readonly string[],
	width: number,
	height: number,
	cursor: { row: number; col: number } | undefined,
	budget: DirectImagePlacementLookup,
): string {
	const buffer = homeRewriteSequence(lead, rows, width, height, budget);
	if (cursor === undefined) return buffer;
	// Rows/cols are 0-based internally and 1-based on the wire.
	const row = clampLow(cursor.row + 1, 1, Math.max(1, height));
	const col = clampLow(cursor.col + 1, 1, Math.max(1, width));
	return `${buffer}\x1b[${row};${col}H`;
}

/** What {@link fullPaintReplay} writes from. */
export interface FullPaintInput {
	readonly lead: string;
	readonly frame: readonly string[];
	/** The viewport rows, overlays composited. */
	readonly window: string[];
	readonly width: number;
	readonly height: number;
	/** Frame-space caret; null when none is visible. */
	readonly cursorPos: { row: number; col: number } | null;
	/** End of the committed prefix `frame[0, chunkTo)` replayed above the window. */
	readonly chunkTo: number;
	/** Frame row the window starts at. */
	readonly windowTop: number;
	/** Erase native scrollback (ED3) rather than push the old screen into it and clear the viewport. */
	readonly clearScrollback: boolean;
	/** Image data transmits, written after the clear and before the first row. */
	readonly imageTransmits: string;
	/** DECCARA fill rectangles are enabled. */
	readonly deccara: boolean;
	readonly budget: DirectImagePlacementLookup;
}

/** A full paint's bytes up to the caret placement, and the paint space the caret is placed in. */
export interface FullPaintReplay {
	/** The lead, the clear, the image transmits, the replayed rows, and the park above padding rows. */
	readonly sequence: string;
	/** The caret mapped into paint space; null when it is hidden behind an overlay gap. */
	readonly cursorPos: { row: number; col: number } | null;
	/** Rows the replay wrote. */
	readonly lineCount: number;
	/** Paint row of the last content row, where the cursor is parked. */
	readonly contentBottomRow: number;
	/** Frame row of the last content row. */
	readonly frameContentBottomRow: number;
}

/**
 * Map a frame-space caret into paint space: committed-prefix rows keep their index, visible-window
 * rows land after the prefix, and a caret in neither region (hidden behind the overlay gap) hides.
 */
function paintSpaceCursor(
	cursorPos: { row: number; col: number } | null,
	chunkTo: number,
	windowTop: number,
	height: number,
): { row: number; col: number } | null {
	if (cursorPos === null) return null;
	if (cursorPos.row < chunkTo) return cursorPos;
	if (cursorPos.row >= windowTop && cursorPos.row < windowTop + height) {
		return { row: chunkTo + cursorPos.row - windowTop, col: cursorPos.col };
	}
	return null;
}

/** The replay rows and paint-space caret; `lines` is null unless ConPTY truncation rewrote the replay. */
interface BoundedReplay {
	readonly lines: string[] | null;
	readonly cursorPos: { row: number; col: number } | null;
}

/**
 * ConPTY hosts bound the replay: merge prefix + window into one array so truncateLargeConptyFrame
 * can measure the payload and retain only the tail. Gated on the host check — everywhere else the
 * merge would copy a pointer per committed row (a 50k-row session = 50k-entry array per resize
 * step / theme change / session replace) just to be returned unchanged.
 */
function boundConptyReplay(input: FullPaintInput, cursorPos: { row: number; col: number } | null): BoundedReplay {
	if (!isConPTYHosted()) return { lines: null, cursorPos };
	const { frame, window, width, height, chunkTo } = input;
	const merged = new Array<string>(chunkTo + height);
	for (let i = 0; i < chunkTo; i++) merged[i] = frame[i] ?? "";
	for (let screenRow = 0; screenRow < height; screenRow++) {
		merged[chunkTo + screenRow] = window[screenRow] ?? "";
	}
	const paint = truncateLargeConptyFrame(merged, width, height, cursorPos);
	return paint.lines === merged ? { lines: null, cursorPos } : { lines: paint.lines, cursorPos: paint.cursorPos };
}

/**
 * The clear a full paint writes after its lead. With `clearScrollback`, clear native history
 * without blanking the live viewport first: the replay rewrites every visible row from home,
 * including blanks, so terminals without DEC 2026 never expose an ED2-cleared frame. Otherwise,
 * best-effort, push the pre-paint screen into scrollback on terminals that implement kitty's ED 22
 * (copy-screen-to-scrollback-then-erase), and always follow with ED 2 so the viewport is cleared
 * regardless; on real kitty, ED 2 over the now-blank screen is a no-op and does not push a second
 * copy.
 */
function fullPaintClear(clearScrollback: boolean): string {
	if (clearScrollback) return "\x1b[H\x1b[3J";
	return TERMINAL.supportsScreenToScrollback ? "\x1b[22J\x1b[2J\x1b[H" : "\x1b[2J\x1b[H";
}

/**
 * DECCARA fills for the rows that stay visible, `[visibleStart, lineCount)`; null when DECCARA is
 * off or no row stays visible. History-bound rows are written as full styled strings: their
 * background must survive in scrollback, which DECCARA cannot reach.
 */
function planVisibleFills(
	input: FullPaintInput,
	paintLines: string[] | null,
	lineCount: number,
	visibleStart: number,
): DeccaraPlan | null {
	if (!input.deccara || visibleStart >= lineCount) return null;
	// Untruncated, the visible slice is exactly the caller's window (visibleStart === chunkTo) —
	// reuse it rather than copying; planDeccaraFills fills its own `texts` and never mutates input.
	let visible = input.window;
	if (paintLines !== null) {
		visible = new Array<string>(lineCount - visibleStart);
		for (let k = 0; k < visible.length; k++) visible[k] = paintLines[visibleStart + k] ?? "";
	}
	return planDeccaraFills(visible, input.width);
}

/** One replayed row; a destructive history clear rewrites the whole row, since it avoids ED2. */
function replayLine(input: FullPaintInput, line: string, screenRow?: number): string {
	return input.clearScrollback
		? lineRewriteSequence(line, input.width, screenRow, input.budget)
		: terminalLine(line, screenRow, input.budget);
}

/**
 * The committed prefix then the window, emitted straight from the source arrays (the pre-merge
 * two-loop form); byte-identical to replaying the merged array.
 */
function replaySourceRows(input: FullPaintInput, visibleTexts: string[] | null): string {
	const { frame, window, height, chunkTo } = input;
	let buffer = "";
	for (let i = 0; i < chunkTo; i++) {
		if (i > 0) buffer += "\r\n";
		buffer += replayLine(input, frame[i] ?? "");
	}
	for (let screenRow = 0; screenRow < height; screenRow++) {
		if (chunkTo + screenRow > 0) buffer += "\r\n";
		const line = visibleTexts ? (visibleTexts[screenRow] ?? "") : (window[screenRow] ?? "");
		buffer += replayLine(input, line, screenRow);
	}
	return buffer;
}

/** The ConPTY-truncated replay; rows from `visibleStart` on are screen rows. */
function replayTruncatedRows(
	input: FullPaintInput,
	paintLines: string[],
	visibleTexts: string[] | null,
	visibleStart: number,
): string {
	let buffer = "";
	for (let i = 0; i < paintLines.length; i++) {
		if (i > 0) buffer += "\r\n";
		const line = visibleTexts && i >= visibleStart ? visibleTexts[i - visibleStart] : (paintLines[i] ?? "");
		buffer += replayLine(input, line, i >= visibleStart ? i - visibleStart : undefined);
	}
	return buffer;
}

/**
 * Replay the frame from home: the committed prefix `[0, chunkTo)` followed by the visible window.
 * ED3 (`CSI 3 J`) is written here and only here, when `clearScrollback` asks for it; otherwise the
 * old screen goes to scrollback where the terminal supports kitty's ED 22 and the viewport clears.
 * The cursor is parked on the last content row rather than the padded window bottom, so a later
 * height shrink cannot scroll live rows into scrollback.
 */
export function fullPaintReplay(input: FullPaintInput): FullPaintReplay {
	const { frame, height, chunkTo, windowTop } = input;
	const bounded = boundConptyReplay(input, paintSpaceCursor(input.cursorPos, chunkTo, windowTop, height));
	const paintLines = bounded.lines;
	const paintLineCount = paintLines === null ? chunkTo + height : paintLines.length;
	let buffer = input.lead + fullPaintClear(input.clearScrollback);
	if (input.imageTransmits.length > 0) buffer += input.imageTransmits;
	const visibleStart = Math.max(0, paintLineCount - height);
	const fills = planVisibleFills(input, paintLines, paintLineCount, visibleStart);
	const visibleTexts = fills?.texts ?? null;
	buffer +=
		paintLines === null
			? replaySourceRows(input, visibleTexts)
			: replayTruncatedRows(input, paintLines, visibleTexts, visibleStart);
	if (fills) buffer += fills.sequence;
	const contentRows = clampLow(frame.length - windowTop, 1, height);
	const parkUp = height - contentRows;
	if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
	return {
		sequence: buffer,
		cursorPos: bounded.cursorPos,
		lineCount: paintLineCount,
		contentBottomRow: Math.max(0, paintLineCount - 1 - parkUp),
		frameContentBottomRow: windowTop + contentRows - 1,
	};
}
