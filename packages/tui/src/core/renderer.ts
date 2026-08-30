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
import { $flag } from "@veyyon/utils/env";
import { normalizeTerminalOutput, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { isConPTYHosted } from "../terminal";
import { imagePlacementRowsAbove, TERMINAL } from "../terminal-capabilities";
import { type Component, CURSOR_MARKER } from "./component-types";
import type { Container } from "./container";

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

/** Depth-first identity search through `Container`-shaped children. */
export function subtreeContains(root: Component, target: Component): boolean {
	if (root === target) return true;
	const children = (root as Partial<Container>).children;
	if (!Array.isArray(children)) return false;
	for (let i = 0; i < children.length; i++) {
		if (subtreeContains(children[i]!, target)) return true;
	}
	return false;
}

export interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}

const SGR_SEQUENCE = sgrSequence("g");

// SGR coalescing. The renderer's component tree emits a styled span as
// `<set-color>text<reset>`, so adjacent spans produce runs of byte-adjacent
// SGR sequences (e.g. a `CSI 39 m` fg-reset immediately followed by the next
// span's `CSI 38;2;r;g;b m`). Two byte-adjacent SGR sequences are semantically
// identical to one SGR carrying both parameter lists (SGR params apply
// left-to-right), so merging the run into a single `CSI … m` is
// behavior-preserving: it drops the redundant `ESC[`/`m` framing and lets the
// terminal dispatch one SGR instead of several. On a real transcript ~40% of
// all SGR sequences are collapsible this way, which meaningfully cuts the
// per-frame byte volume and SGR-dispatch count a slow (xterm.js/WebGL) terminal
// must process. On by default; `VEYYON_NO_SGR_COALESCE=1` disables it.
const SGR_COALESCE_ENABLED = !$flag("VEYYON_NO_SGR_COALESCE");
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b; // [
const CC_M = 0x6d; // m
const CC_SEMI = 0x3b; // ;
const CC_COLON = 0x3a; // :
// Max parameter tokens per emitted merged SGR. Kept well under xterm.js's
// 32-param cap (and the tighter limits of some real terminals) so a long
// adjacent run is split into several valid CSIs instead of overflowing one.
const MERGE_TOKEN_CAP = 16;

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

// True when a parameter list ends mid extended-color spec in the ambiguous
// semicolon form: `38/48/58;2` with fewer than three channel values, or
// `38/48/58;5` with no palette index. Concatenating another list after such a
// run would let the next code be absorbed as the missing channel/index (e.g.
// `38;2;255;0` + `31` → `38;2;255;0;31`, where `31` becomes blue instead of a
// standalone fg-red), changing the rendered color. The self-delimiting colon
// form (`38:2::r:g:b`) is unambiguous — its tokens never equal a bare `38`, so
// the scan treats it as a complete unit and merging stays safe.
function endsWithIncompleteExtendedColor(params: string): boolean {
	const t = params.split(";");
	let i = 0;
	while (i < t.length) {
		const tok = t[i];
		if (tok === "38" || tok === "48" || tok === "58") {
			const mode = t[i + 1];
			if (mode === undefined) return true; // introducer with no mode
			if (mode === "2") {
				if (i + 4 >= t.length) return true; // missing r/g/b
				i += 5;
				continue;
			}
			if (mode === "5") {
				if (i + 2 >= t.length) return true; // missing index
				i += 3;
				continue;
			}
		}
		i += 1;
	}
	return false;
}

/**
 * Merge runs of byte-adjacent SGR sequences (`CSI [0-9;:]* m`) into one. Only
 * CSI-SGR sequences are touched; text, cursor moves, OSC, hyperlinks and image
 * payloads pass through verbatim. Returns the original reference when nothing
 * merges, so SGR-light lines incur only a single `indexOf` scan.
 */
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}
		// Scan a candidate SGR sequence: ESC [ <params> m.
		let j = i + 2;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) j++;
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			// Not an SGR (e.g. cursor move); leave it in the pending region.
			i = j;
			continue;
		}
		// Collect the run of adjacent SGR sequences starting here.
		const params: string[] = [line.slice(i + 2, j)];
		let k = j + 1;
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			let p = k + 2;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) p++;
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			params.push(line.slice(k + 2, p));
			k = p + 1;
		}
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);
			// Emit the merged run, but flush the current group before appending a
			// list when (a) the previous list ended mid extended-color, so the
			// next code cannot be absorbed as its missing channel/index, or (b)
			// the token count would exceed MERGE_TOKEN_CAP. SGR params apply
			// left-to-right regardless of how they are grouped across adjacent
			// CSIs, so a capped/guarded split stays behavior-preserving — while a
			// single unbounded merge would overflow a terminal's CSI parameter
			// buffer (xterm.js caps at 32 and silently truncates the rest,
			// corrupting colors). Empty params (`CSI m`) mean a full reset;
			// normalize to `0` so the merged list stays unambiguous.
			let group = "";
			let groupTokens = 0;
			let groupOpenSafe = true;
			for (let q = 0; q < params.length; q++) {
				const norm = params[q]!.length === 0 ? "0" : params[q]!;
				let tk = 1;
				for (let z = 0; z < norm.length; z++) {
					const cc = norm.charCodeAt(z);
					if (cc === CC_SEMI || cc === CC_COLON) tk++;
				}
				if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
					out += `\x1b[${group}m`;
					group = "";
					groupTokens = 0;
				}
				group += group.length === 0 ? norm : `;${norm}`;
				groupTokens += tk;
				groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
			}
			if (group.length > 0) out += `\x1b[${group}m`;
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}

/** Compare two rows ignoring SGR styling (theme restyles keep alignment). */
export function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

export function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
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
	if (frame.length >= hardEnd) {
		// 1. Hard scan: frozen snapshots whose source just became final. Full
		// scan, no tolerance — a finalized row that changed must re-anchor.
		let hardMismatch = false;
		for (let i = verified; i < hardEnd; i++) {
			if (!rowsEquivalent(frame[i]!, prefix[i]!)) {
				hardMismatch = true;
				break;
			}
		}
		if (!hardMismatch) {
			// 2. Tail sample over the verified zone (only when the hard scan is
			// clean): walk up from its end until LOOKBACK rows or SAMPLES
			// non-blank comparisons.
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
			// No signal (all-blank tail) or at most one edited row: aligned.
			if (samples === 0 || mismatches <= 1) return -1;
		}
	}
	// Misaligned (hard mismatch, tail-sample shift, or the frame no longer
	// covers the checked zones): re-anchor at the first row whose content
	// changed.
	const limit = Math.min(hardEnd, frame.length);
	for (let i = 0; i < limit; i++) {
		if (!rowsEquivalent(frame[i]!, prefix[i]!)) return i;
	}
	return limit < hardEnd ? limit : -1;
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
		const line = lines[row];
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) continue;
		const beforeMarker = line.slice(0, markerIndex);
		markers.push({ row, col: visibleWidth(beforeMarker) });
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		lines[row] = stripped;
	}
	return markers;
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
 * Withhold a direct-placement image whose origin sits above the viewport.
 *
 * The placement row moves the cursor up to the block's top before emitting
 * the graphic, and CUU stops at the top of the scroll region: from screen
 * row `screenRow` an origin `rowsAbove` rows higher is unreachable whenever
 * `rowsAbove > screenRow`, and the terminal stamps the whole picture at row
 * 1 over live text. The block keeps its rows; only the graphic waits.
 *
 * It does not wait long. A full paint and a seam rewrite both replay the
 * window after the history chunk, which leaves every window row addressed
 * from the bottom of the screen, so those rows carry `screenRow` at
 * `height - 1` and place every image the incremental path withheld.
 */
export function imageLine(line: string, screenRow: number): string {
	return imagePlacementRowsAbove(line) > screenRow ? "" : line;
}

export function terminalLine(line: string, screenRow: number): string {
	if (TERMINAL.isImageLine(line)) return imageLine(line, screenRow);
	const coalesced = coalesceAdjacentSgr(line);
	return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SGR_RESET);
}

/**
 * Persistent prepared frame, row-aligned with the composed frame. Entries hold
 * normalized, width-fitted content rows without the per-line terminator, which
 * is appended at write time so width checks stay on content, not reset bytes.
 *
 * `validRows` counts the leading rows known prepared against the CURRENT
 * composed frame: a compose lowers it to the stable prefix, a completed
 * `prepare()` raises it to the frame length, and an abandoned frame (ghostty
 * image defer) leaves it lowered so the next prepare revalidates the splice.
 */
export class PreparedFrameCache {
	#frame: string[] = [];
	#meta: PreparedLine[] = [];
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

	setRow(index: number, prepared: PreparedLine): void {
		this.#meta[index] = prepared;
		this.#frame[index] = prepared.line;
	}

	/**
	 * Prepare the composed frame for emission, in place. Rows below `validRows`
	 * are already prepared against the current frame; rows at/after it are
	 * revalidated positionally — a row whose raw content and width match its
	 * cached entry reuses the prepared line, anything else re-prepares.
	 */
	prepare(frame: readonly string[], width: number): string[] {
		const prepared = this.#frame;
		const meta = this.#meta;
		if (prepared.length > frame.length) {
			prepared.length = frame.length;
			meta.length = frame.length;
		}
		for (let i = Math.min(this.#validRows, prepared.length); i < frame.length; i++) {
			const raw = frame[i]!;
			const cached = meta[i];
			if (cached !== undefined && cached.raw === raw && cached.width === width) {
				prepared[i] = cached.line;
				continue;
			}
			const entry = prepareLine(raw, width);
			meta[i] = entry;
			prepared[i] = entry.line;
		}
		this.#validRows = frame.length;
		return prepared;
	}
}

/** Stateless variant for overlay-composited windows and alt-screen frames. */
export function prepareLinesArray(lines: readonly string[], width: number): string[] {
	const prepared: string[] = new Array(lines.length);
	for (let i = 0; i < lines.length; i++) {
		prepared[i] = prepareLine(lines[i]!, width).line;
	}
	return prepared;
}

export function prepareLine(raw: string, width: number): PreparedLine {
	if (TERMINAL.isImageLine(raw)) {
		return { raw, width, line: raw };
	}
	const source = lineFitSource(raw, width);
	const normalized = normalizeTerminalOutput(source);
	const asciiWidth = ansiAsciiLineWidth(normalized, width);
	if ((asciiWidth ?? visibleWidth(normalized)) <= width) {
		return { raw, width, line: normalized };
	}
	const line = truncateToWidth(normalized, width, Ellipsis.Omit);
	return { raw, width, line };
}

function lineFitSource(raw: string, width: number): string {
	const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
	const maxSourceLength = Math.min(
		LINE_FIT_MAX_SOURCE_CODE_UNITS,
		Math.max(LINE_FIT_MIN_SOURCE_CODE_UNITS, safeWidth * LINE_FIT_SOURCE_WIDTH_MULTIPLIER),
	);
	if (raw.length <= maxSourceLength) return raw;

	let output = "";
	let cells = 0;
	for (let i = 0; i < raw.length && cells < safeWidth; ) {
		if (raw.charCodeAt(i) === 0x1b) {
			const end = ansiSequenceEnd(raw, i);
			if (end < 0) break;
			if (ansiSequenceHasVisiblePayload(raw, i)) {
				const sequence = raw.slice(i, end);
				if (output.length + sequence.length <= maxSourceLength) {
					output += sequence;
					cells += visibleWidth(sequence);
				}
			}
			i = end;
			continue;
		}

		const code = raw.charCodeAt(i);
		const next = code >= 0xd800 && code <= 0xdbff && i + 1 < raw.length ? i + 2 : i + 1;
		const char = raw.slice(i, next);
		const charWidth = visibleWidth(char);
		if (charWidth > 0 && cells + charWidth > safeWidth) break;
		if (output.length + char.length > maxSourceLength) {
			if (charWidth > 0) break;
			i = next;
			continue;
		}
		if (charWidth === 0) {
			const remainingVisibleCells = safeWidth - cells;
			const reservedCodeUnits = remainingVisibleCells * 2;
			if (output.length + char.length > maxSourceLength - reservedCodeUnits) {
				i = next;
				continue;
			}
		}
		output += char;
		cells += charWidth;
		i = next;
	}

	return output + SGR_RESET;
}

function ansiSequenceEnd(line: string, start: number): number {
	const next = line.charCodeAt(start + 1);
	if (next === 0x5b) {
		let i = start + 2;
		while (i < line.length) {
			const final = line.charCodeAt(i);
			if (final >= 0x40 && final <= 0x7e) return i + 1;
			i++;
		}
		return -1;
	}
	if (next === 0x5d) {
		let i = start + 2;
		while (i < line.length) {
			const osc = line.charCodeAt(i);
			if (osc === 0x07) return i + 1;
			if (osc === 0x1b && line.charCodeAt(i + 1) === 0x5c) return i + 2;
			i++;
		}
		return -1;
	}
	return start + 2 <= line.length ? start + 2 : -1;
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

function ansiAsciiLineWidth(line: string, maxWidth: number): number | undefined {
	let col = 0;
	for (let i = 0; i < line.length; ) {
		const code = line.charCodeAt(i);
		if (code === 0x1b) {
			const next = line.charCodeAt(i + 1);
			if (next === 0x5b) {
				let j = i + 2;
				while (j < line.length) {
					const final = line.charCodeAt(j);
					if (final >= 0x40 && final <= 0x7e) break;
					j++;
				}
				if (j >= line.length) return undefined;
				i = j + 1;
				continue;
			}
			if (next === 0x5d) {
				// OSC 66 text-sizing spans carry visible payload inside the OSC.
				// Fall back to visibleWidth() so scaled cells stay exact.
				if (line.charCodeAt(i + 2) === 0x36 && line.charCodeAt(i + 3) === 0x36 && line.charCodeAt(i + 4) === 0x3b) {
					return undefined;
				}
				let j = i + 2;
				while (j < line.length) {
					const osc = line.charCodeAt(j);
					if (osc === 0x07) {
						i = j + 1;
						break;
					}
					if (osc === 0x1b && line.charCodeAt(j + 1) === 0x5c) {
						i = j + 2;
						break;
					}
					j++;
				}
				if (j >= line.length) return undefined;
				continue;
			}
			return undefined;
		}
		if (code < 0x20 || code > 0x7e) return undefined;
		col++;
		if (col > maxWidth) return col;
		i++;
	}
	return col;
}

export function lineRewriteSequence(line: string, width: number, screenRow: number): string {
	if (TERMINAL.isImageLine(line)) return ERASE_LINE + imageLine(line, screenRow);
	const written = terminalLine(line, screenRow);
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
