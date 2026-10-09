/**
 * Frame preparation and the byte-level line primitives the paint pipeline
 * writes. Everything here is positional and stateless apart from
 * `PreparedFrameCache`, which holds the row-aligned prepared frame between
 * paints so an unchanged row is fit and normalized once.
 *
 * Split out of `tui.ts`; see `docs/internal/tui-core-renderer.md` for the
 * append-only render contract these primitives serve.
 */
import { Ellipsis } from "@veyyon/natives";
import { SGR_RESET, sgrSequence } from "@veyyon/utils/ansi";
import { normalizeTerminalOutput, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { isConPTYHosted } from "../terminal";
import { encodeKittyClippedPlacementLine, type KittyDirectPlacement, TERMINAL } from "../terminal-capabilities";
import { type Component, CURSOR_MARKER } from "./component-types";
import type { Container } from "./container";
import { coalesceAdjacentSgr } from "./sgr-coalesce";

/** Geometry lookup required when a direct image placement is clipped. */
export interface DirectImagePlacementLookup {
	directPlacement(line: string): KittyDirectPlacement | undefined;
}

/**
 * Per-line terminator written after every non-image content row. It closes both
 * SGR state and any in-flight OSC 8 hyperlink so styles/links cannot bleed
 * across lines in scrollback. Kept out of the diff/width cache because reset
 * bytes are deterministic write framing, not content.
 */
export const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
const ERASE_LINE = "\x1b[2K";
const ERASE_TO_END_OF_LINE = "\x1b[K";
// Keep the common short-row path out of native width/truncation. Longer rows
// are fit by visible cells, not source code units, so zero-width-heavy prefixes
// cannot hide visible suffix text that still belongs in the viewport.
const LINE_FIT_MIN_SOURCE_CODE_UNITS = 4096;
const LINE_FIT_MAX_SOURCE_CODE_UNITS = 65536;
const LINE_FIT_SOURCE_WIDTH_MULTIPLIER = 64;

// ConPTY collapses a very large single write, so an oversized frame is
// truncated to a recent tail before it is painted on Windows.
const CONPTY_FRAME_TRUNCATE_THRESHOLD_BYTES = 512 * 1024;
const CONPTY_FRAME_RETAIN_BYTES = 64 * 1024;

/**
 * The chain of components from `root` down to `target`, both included, or null when
 * `target` is not in `root`'s `Container`-shaped subtree.
 *
 * Children are searched newest first. The component asking for a scoped frame is
 * nearly always a spinner or a streaming block at the tail of a transcript, and an
 * oldest-first search visited every block of a long session's history to reach it:
 * a 58,000-turn transcript spent 94% of an idle process's CPU here, once per
 * animation frame.
 */
export function pathToDescendant(root: Component, target: Component): Component[] | null {
	if (root === target) return [root];
	const children = (root as Partial<Container>).children;
	if (!Array.isArray(children)) return null;
	for (let i = children.length - 1; i >= 0; i--) {
		const path = pathToDescendant(children[i]!, target);
		if (path !== null) {
			path.unshift(root);
			return path;
		}
	}
	return null;
}

/**
 * Whether every link of a chain from {@link pathToDescendant} still holds: each
 * component is still a child of the one before it. Exact under any mutation of a
 * `children` array, including a direct one that bypasses `Container` methods, and it
 * costs one membership scan per link instead of a walk of the whole subtree.
 */
export function isPathIntact(path: readonly Component[]): boolean {
	for (let i = 1; i < path.length; i++) {
		const children = (path[i - 1] as Partial<Container>).children;
		if (!Array.isArray(children) || children.lastIndexOf(path[i]!) === -1) return false;
	}
	return true;
}

const SGR_SEQUENCE = sgrSequence("g");

/** Compare two rows ignoring SGR styling (theme restyles keep alignment). */
export function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

export function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

/** Find the first index in [from, limit) where rows are not equivalent. Returns -1 if none. */
export function firstRowDivergence(a: readonly string[], b: readonly string[], limit: number, from = 0): number {
	for (let i = from; i < limit; i++) {
		if (!rowsEquivalent(a[i]!, b[i]!)) return i;
	}
	return -1;
}

// Tail-alignment sampling bounds: look back through up to LOOKBACK rows of
// the committed prefix to collect SAMPLES non-blank comparisons.
const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

/**
 * Decide whether `frame` still aligns with the committed prefix, and where to
 * re-anchor the commit index when it does not. Returns the resync row index,
 * or -1 when no resync is needed.
 *
 * Zones (verifiedTo ≤ finalTo ≤ prefix.length):
 *   [0, verifiedTo)         VERIFIED exact rows — sampled with tolerance.
 *   [verifiedTo, finalTo)   NEWLY-FINAL rows — frozen visual snapshots whose
 *       source just became declared-final (the block finalized / a barrier
 *       cleared). Hard-scanned in FULL with no tolerance: any content change
 *       (a pending header settling, a preview replaced by its result, a tail
 *       shifting up after a barrier removal) re-anchors so the engine can
 *       erase-and-replay history with the final content exactly once (or, on
 *       ED3-unsafe multiplexers, recommit it below the frozen snapshot —
 *       duplication, never loss) instead of committing it nowhere and
 *       painting it nowhere.
 *   [finalTo, prefix.length) FROZEN visual snapshots of still-live rows —
 *       exempt: their drift is expected (a collapsing preview, a ticking
 *       progress tree) and must never spray re-anchors mid-run.
 *
 * The verified zone's sampled check exploits the asymmetry between the two
 * mutation classes: an in-place edit/restyle disturbs only the touched rows
 * (alignment below stays intact; the stale copy in history is the accepted
 * artifact), while an insertion/deletion shifts EVERY row below it. Up to 8
 * non-blank rows within the last 24 verified rows are compared SGR-stripped
 * (theme changes stay quiet), tolerating a SINGLE mismatch. The tolerance is
 * load-bearing for roots that report NO seam: an animated row already in
 * history would otherwise re-anchor on every glyph tick.
 *
 * Highly repetitive tails (identical filler rows) can mask a shift in the tail
 * sample, in which case the skipped rows are content-identical to the committed
 * ones — observationally harmless. Exported for the render-stress harness, whose
 * shadow commit ledger must mirror the engine's law exactly.
 */
export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	verifiedTo: number = prefix.length,
	finalTo: number = verifiedTo,
): number {
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	const hardEnd = Math.min(prefix.length, Math.max(verified, Math.trunc(finalTo)));
	if (hardEnd === 0) return -1;
	// 1. Hard scan: frozen snapshots whose source just became final. Full
	// scan, no tolerance — a finalized row that changed must re-anchor.
	// 2. Tail sample over the verified zone, only when the hard scan is clean.
	if (
		frame.length >= hardEnd &&
		firstRowDivergence(frame, prefix, hardEnd, verified) === -1 &&
		tailSampleAligned(frame, prefix, verified)
	) {
		return -1;
	}
	// Misaligned (hard mismatch, tail-sample shift, or the frame no longer
	// covers the checked zones): re-anchor at the first row whose content
	// changed.
	const limit = Math.min(hardEnd, frame.length);
	const diverged = firstRowDivergence(frame, prefix, limit);
	return diverged >= 0 ? diverged : limit < hardEnd ? limit : -1;
}

/**
 * The tail sample over the verified zone `[0, verified)`: walk up from its end until LOOKBACK rows or SAMPLES
 * non-blank comparisons. Aligned when the sample has no signal (an all-blank tail) or at most one edited row.
 */
function tailSampleAligned(frame: readonly string[], prefix: readonly string[], verified: number): boolean {
	let samples = 0;
	let mismatches = 0;
	for (let j = 1; j <= verified && j <= RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
		const idx = verified - j;
		const row = frame[idx]!;
		const old = prefix[idx]!;
		if (row === old) {
			if (!isBlankRow(row)) samples++;
			continue;
		}
		if (isBlankRow(row) && isBlankRow(old)) continue;
		samples++;
		if (!rowsEquivalent(row, old)) mismatches++;
	}
	return samples === 0 || mismatches <= 1;
}

/**
 * Audit committed source alignment and accept tolerated verified-row changes.
 * Frozen rows retain their original snapshots until strict finalization.
 * The physical history remains in ScrollTape; this prefix tracks alignment.
 */
export function auditCommittedPrefix(
	frame: readonly string[],
	prefix: string[],
	verifiedTo: number,
	finalTo: number,
): number {
	const resyncTo = findCommittedPrefixResync(frame, prefix, verifiedTo, finalTo);
	if (resyncTo >= 0) return resyncTo;
	const verified = Math.min(prefix.length, Math.max(0, Math.trunc(verifiedTo)));
	for (let i = Math.max(0, verified - RESYNC_TAIL_LOOKBACK); i < verified; i++) {
		prefix[i] = frame[i]!;
	}
	return -1;
}

/**
 * Append the first marker's position and strip every marker from the line.
 */
export function extractLineCursorMarker(line: string, row: number, markers: { row: number; col: number }[]): string {
	let markerIndex = line.indexOf(CURSOR_MARKER);
	if (markerIndex === -1) return line;
	markers.push({ row, col: visibleWidth(line.slice(0, markerIndex)) });
	let stripped = line;
	while (markerIndex !== -1) {
		stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
		markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
	}
	return stripped;
}

/**
 * Strip every CURSOR_MARKER from the rendered lines (markers are internal
 * sentinels and must never reach the terminal, the committed prefix, or
 * the resync audit) and return the positions of the stripped markers,
 * bottom-most first. Callers pick the visible one once the window top is
 * known.
 */
export function extractCursorMarkers(lines: string[]): { row: number; col: number }[] {
	const markers: { row: number; col: number }[] = [];
	for (let row = lines.length - 1; row >= 0; row--) {
		const line = lines[row]!;
		const stripped = extractLineCursorMarker(line, row, markers);
		if (stripped !== line) lines[row] = stripped;
	}
	return markers;
}

/**
 * Pick the visible cursor marker: the bottom-most marker at or below `windowTop`.
 * Expects `markers` in ascending order by frame row.
 */
export function findVisibleCursorMarker(
	markers: readonly { readonly row: number; readonly col: number }[],
	windowTop: number,
): { row: number; col: number } | null {
	for (let i = markers.length - 1; i >= 0; i--) {
		const marker = markers[i]!;
		if (marker.row >= windowTop) return marker;
	}
	return null;
}

export function truncateLargeConptyFrame(
	lines: string[],
	width: number,
	height: number,
	cursorPos: { row: number; col: number } | null,
): { lines: string[]; cursorPos: { row: number; col: number } | null } {
	if (!isConPTYHosted()) return { lines, cursorPos };

	let totalBytes = 0;
	let exceedsThreshold = false;
	for (const line of lines) {
		totalBytes += Buffer.byteLength(line, "utf8") + 8;
		if (totalBytes > CONPTY_FRAME_TRUNCATE_THRESHOLD_BYTES) {
			exceedsThreshold = true;
			break;
		}
	}
	if (!exceedsThreshold) return { lines, cursorPos };

	let retainedBytes = 0;
	let retainedStart = lines.length;
	while (retainedStart > 0 && (retainedBytes < CONPTY_FRAME_RETAIN_BYTES || lines.length - retainedStart < height)) {
		retainedStart -= 1;
		retainedBytes += Buffer.byteLength(lines[retainedStart] ?? "", "utf8") + 8;
	}
	if (retainedStart <= 0) return { lines, cursorPos };

	const marker = truncateToWidth(
		`[${retainedStart} older lines hidden to keep Windows console resume responsive]`,
		width,
		Ellipsis.Omit,
	);
	const truncated = new Array<string>(lines.length - retainedStart + 1);
	truncated[0] = marker;
	for (let i = retainedStart; i < lines.length; i++) {
		truncated[i - retainedStart + 1] = lines[i] ?? "";
	}

	if (cursorPos === null || cursorPos.row < retainedStart) {
		return { lines: truncated, cursorPos: null };
	}
	return {
		lines: truncated,
		cursorPos: { row: cursorPos.row - retainedStart + 1, col: cursorPos.col },
	};
}

/**
 * The bytes for an image line written at viewport row `screenRow`. A direct
 * placement is the LAST row of its block and climbs `rows-1` to the origin;
 * written at a row above that origin (its first rows already scrolled into
 * native scrollback, or an alt-screen frame that starts inside the block),
 * the climb clamps at row 0 and the picture lands over the text below it.
 * Such a line is re-derived from the geometry the budget holds: it climbs to
 * row 0 and shows only the rows that fit. Sequential replays (history rows)
 * pass no row and keep the line, since the block's own rows precede it.
 */
export function imageLineAt(line: string, screenRow: number | undefined, budget?: DirectImagePlacementLookup): string {
	if (screenRow === undefined || budget === undefined) return line;
	const placement = budget.directPlacement(line);
	if (placement === undefined || placement.rows - 1 <= screenRow) return line;
	return encodeKittyClippedPlacementLine(placement, screenRow);
}

/**
 * A line as the terminal receives it. `screenRow` is the viewport row the
 * line is written at, when the caller knows it; an image line rewritten
 * there is clipped to the rows it has above it, see {@link imageLineAt}.
 */
export function terminalLine(line: string, screenRow?: number, budget?: DirectImagePlacementLookup): string {
	if (TERMINAL.isImageLine(line)) return imageLineAt(line, screenRow, budget);
	const coalesced = coalesceAdjacentSgr(line);
	return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SGR_RESET);
}
/**
 * Persistent prepared frame, row-aligned with the composed frame. Entries hold
 * normalized, width-fitted content rows without the per-line terminator, which
 * is appended at write time so width checks stay on content, not reset bytes.
 *
 * `#raw[i]` is the composed row `#frame[i]` was prepared from, and every entry
 * was prepared at `#width`. Two parallel arrays rather than a record per row: a
 * long transcript's frame holds tens of thousands of rows for the whole session,
 * and a record per row cost more than the two pointers it held. A width change
 * retires every entry at once, which is also what a per-row width comparison
 * did, since the whole frame is always prepared at one width.
 *
 * `validRows` counts the leading rows known prepared against the CURRENT
 * composed frame: a compose lowers it to the stable prefix, a completed
 * `prepare()` raises it to the frame length, and an abandoned frame (ghostty
 * image defer) leaves it lowered so the next prepare revalidates the splice.
 */
export class PreparedFrameCache {
	#frame: string[] = [];
	#raw: string[] = [];
	#width = -1;
	#validRows = 0;

	get validRows(): number {
		return this.#validRows;
	}

	/** A compose lowered the stable prefix: rows at/after `rows` need revalidation. */
	lowerValidRows(rows: number): void {
		this.#validRows = Math.min(this.#validRows, rows);
	}

	/** A segment rewrite prepared rows ahead of the frame walk. */
	raiseValidRows(rows: number): void {
		this.#validRows = Math.max(this.#validRows, rows);
	}

	rowAt(index: number): string | undefined {
		return this.#frame[index];
	}

	/**
	 * Prepare composed row `index` ahead of the frame walk (a segment rewrite)
	 * and return the prepared line. A row prepared at a width other than the
	 * cache's leaves the cache without a width, so the next {@link prepare}
	 * re-prepares every row rather than trusting rows fitted to the old one.
	 */
	setRow(index: number, raw: string, width: number): string {
		const line = prepareLine(raw, width);
		this.#frame[index] = line;
		if (width === this.#width) this.#raw[index] = raw;
		else this.#width = -1;
		return line;
	}

	/**
	 * Prepare the composed frame for emission, in place. Rows below `validRows`
	 * are already prepared against the current frame; rows at/after it are
	 * revalidated positionally — a row whose raw content matches its cached
	 * entry at the cache's width reuses the prepared line, anything else
	 * re-prepares.
	 */
	prepare(frame: readonly string[], width: number): string[] {
		const prepared = this.#frame;
		const raws = this.#raw;
		if (width !== this.#width) {
			// Every entry was fitted to another width. Truncating the sources
			// makes every row miss below, and the rebuild writes them back in
			// row order, so the array never holds a hole.
			this.#width = width;
			this.#validRows = 0;
			raws.length = 0;
		}
		if (prepared.length > frame.length) {
			prepared.length = frame.length;
			raws.length = Math.min(raws.length, frame.length);
		}
		for (let i = Math.min(this.#validRows, prepared.length); i < frame.length; i++) {
			const raw = frame[i]!;
			if (raws[i] === raw) continue;
			raws[i] = raw;
			prepared[i] = prepareLine(raw, width);
		}
		this.#validRows = frame.length;
		return prepared;
	}
}

/** Stateless variant for overlay-composited windows and alt-screen frames. */
export function prepareLinesArray(lines: readonly string[], width: number): string[] {
	const prepared: string[] = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		prepared[i] = prepareLine(lines[i]!, width);
	}
	return prepared;
}

/** A composed row as the terminal receives it: normalized and fitted to `width` cells, without the line terminator. */
export function prepareLine(raw: string, width: number): string {
	if (TERMINAL.isImageLine(raw)) return raw;
	const source = lineFitSource(raw, width);
	const normalized = normalizeTerminalOutput(source);
	const asciiWidth = ansiAsciiLineWidth(normalized, width);
	if ((asciiWidth ?? visibleWidth(normalized)) <= width) return normalized;
	return truncateToWidth(normalized, width, Ellipsis.Omit);
}

/**
 * An oversized row's source fitted to its visible cells: the escapes and characters kept within the code-unit budget,
 * and the cells they fill.
 */
class LineFit {
	output = "";
	cells = 0;
	#width: number;
	#maxLength: number;

	constructor(width: number, maxLength: number) {
		this.#width = width;
		this.#maxLength = maxLength;
	}

	/** Keep the escape sequence at `start` when it fits; returns the index after it, or -1 when it is unterminated. */
	escape(raw: string, start: number): number {
		const end = ansiSequenceEnd(raw, start);
		if (end < 0) return -1;
		const sequence = raw.slice(start, end);
		const visible = ansiSequenceHasVisiblePayload(raw, start);
		// A zero-width sequence (SGR styling) must leave room for the visible
		// cells still to come, or a flood of escapes crowds out the text itself.
		const budget = visible ? this.#maxLength : this.#maxLength - (this.#width - this.cells) * 2;
		if (this.output.length + sequence.length <= budget) {
			this.output += sequence;
			if (visible) {
				this.cells += visibleWidth(sequence);
			}
		}
		return end;
	}

	/** Keep the character at `start` when it fits; returns the index after it, or -1 when the row is full. */
	char(raw: string, start: number): number {
		const code = raw.charCodeAt(start);
		const next = code >= 0xd800 && code <= 0xdbff && start + 1 < raw.length ? start + 2 : start + 1;
		const char = raw.slice(start, next);
		const charWidth = visibleWidth(char);
		if (charWidth > 0 && this.cells + charWidth > this.#width) return -1;
		const length = this.output.length + char.length;
		if (length > this.#maxLength) return charWidth > 0 ? -1 : next;
		// A zero-width character must leave two code units for each visible cell still to come.
		if (charWidth === 0 && length > this.#maxLength - (this.#width - this.cells) * 2) return next;
		this.output += char;
		this.cells += charWidth;
		return next;
	}
}

function lineFitSource(raw: string, width: number): string {
	const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
	const maxSourceLength = Math.min(
		LINE_FIT_MAX_SOURCE_CODE_UNITS,
		Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
	);
	if (raw.length <= maxSourceLength) return raw;

	const fit = new LineFit(safeWidth, maxSourceLength);
	for (let i = 0; i < raw.length && fit.cells < safeWidth; ) {
		i = raw.charCodeAt(i) === 0x1b ? fit.escape(raw, i) : fit.char(raw, i);
		if (i < 0) break;
	}
	return fit.output + SGR_RESET;
}

function ansiSequenceEnd(line: string, start: number): number {
	const next = line.charCodeAt(start + 1);
	if (next === 0x5b) return csiEnd(line, start + 2);
	if (next === 0x5d) return oscEnd(line, start + 2);
	return start + 2 <= line.length ? start + 2 : -1;
}

/** The index after the CSI whose parameters start at `from`: past its final byte in 0x40-0x7E, or -1 when unterminated. */
function csiEnd(line: string, from: number): number {
	for (let i = from; i < line.length; i++) {
		const final = line.charCodeAt(i);
		if (final >= 0x40 && final <= 0x7e) return i + 1;
	}
	return -1;
}

/** The index after the OSC whose payload starts at `from`: past its BEL or ST (ESC \), or -1 when unterminated. */
function oscEnd(line: string, from: number): number {
	for (let i = from; i < line.length; i++) {
		const osc = line.charCodeAt(i);
		if (osc === 0x07) return i + 1;
		if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return -1;
}

function ansiSequenceHasVisiblePayload(line: string, start: number): boolean {
	// OSC 66 (`\x1b]66;META;TEXT\x1b\\`) carries visible cells inside the payload.
	return (
		line.charCodeAt(start + 1) === 0x5d &&
		line.charCodeAt(start + 2) === 0x36 &&
		line.charCodeAt(start + 3) === 0x36 &&
		line.charCodeAt(start + 4) === 0x3b
	);
}

/** The index after the zero-width CSI or OSC at `start`, or -1 for any other escape and for an unterminated one. */
function invisibleEscapeEnd(line: string, start: number): number {
	if (ansiSequenceHasVisiblePayload(line, start)) return -1;
	const next = line.charCodeAt(start + 1);
	if (next !== 0x5b && next !== 0x5d) return -1;
	return ansiSequenceEnd(line, start);
}

function ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
	let col = 0;
	for (let i = 0; i < line.length; ) {
		const code = line.charCodeAt(i);
		if (code === 0x1b) {
			const end = invisibleEscapeEnd(line, i);
			if (end < 0) return undefined;
			i = end;
			continue;
		}
		if (code < 0x20 || code > 0x7e) return undefined;
		col++;
		if (col > maxWidth) return col;
		i++;
	}
	return col;
}

export function lineRewriteSequence(
	line: string,
	width: number,
	screenRow?: number,
	budget?: DirectImagePlacementLookup,
): string {
	if (TERMINAL.isImageLine(line)) return ERASE_LINE + imageLineAt(line, screenRow, budget);
	const written = terminalLine(line, screenRow, budget);
	const asciiWidth = ansiAsciiLineWidth(line, width);
	if (asciiWidth !== undefined) {
		// Exact width model: skip the erase only when the row truly fills
		// the line (an EL there would eat the last cell via pending-wrap).
		return asciiWidth >= width ? written : written + ERASE_TO_END_OF_LINE;
	}
	// Non-ASCII rows: the native measure can over-count combining-heavy
	// scripts, so a row it calls "full" may render short and leave stale
	// cells from the previous occupant — which would then scroll into
	// history baked into the committed row. Erase the line first instead
	// (rewrites always start at column 1, so EL-to-end clears the whole
	// row); the leading reset keeps BCE on the default background.
	return SGR_RESET + ERASE_TO_END_OF_LINE + written;
}
