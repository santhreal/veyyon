/** Motion on the rail a tool block hangs its output from. `renderOutputBlock` paints the rail one flat colour: accent while the tool is */

import { blendHex, toHexColor } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils/math";
import type { Theme } from "../modes/theme/theme";

/** Milliseconds between idle steps. One repaint of one block per step. */
export const RAIL_IDLE_STEP_MS = 60;
/** Rows the idle highlight travels per step, so the head moves at ~4 rows/s. */
export const RAIL_IDLE_ROWS_PER_STEP = 0.25;
/** Rows of afterglow above the head. */
export const RAIL_IDLE_TAIL_ROWS = 3.5;
/** Rows of lead-in below the head, which is the highlight's sharp edge. */
export const RAIL_IDLE_LEAD_ROWS = 0.9;
/** How far toward the block's dim the rail cools between passes. */
export const RAIL_IDLE_COOL = 0.55;
/** How far toward white the head of a pass goes, idle or settling. */
export const RAIL_HOT = 0.75;
/** Dark rows between two passes, so a short block still sees one go by. */
export const RAIL_IDLE_GAP_ROWS = 6;
/** Shortest idle cycle: a one-row block still gets a rise and a fall. */
export const RAIL_IDLE_CYCLE_MIN_ROWS = 9;
/** Longest idle cycle: a tall block carries a train instead of one lost cell. */
export const RAIL_IDLE_CYCLE_MAX_ROWS = 26;

/** Frames in the settle pass. */
export const RAIL_SETTLE_FRAMES = 14;
/** Milliseconds per settle frame — 630 ms for the whole pass at any height. */
export const RAIL_SETTLE_FRAME_MS = 45;
/** Rows of glow the settling head trails behind it. */
export const RAIL_SETTLE_TAIL_ROWS = 3;

/** Milliseconds the idle head takes to travel one rail row. */
export const RAIL_IDLE_ROW_MS = RAIL_IDLE_STEP_MS / RAIL_IDLE_ROWS_PER_STEP;

export interface RailIdleMotion {
	kind: "idle";
	/** Rows travelled, fractional. */
	head: number;
}

export interface RailSettleMotion {
	kind: "settle";
	/** 1..{@link RAIL_SETTLE_FRAMES}. */
	frame: number;
}

export type RailMotion = RailIdleMotion | RailSettleMotion;

/** Head position for an idle step counter, for a frame-indexed proof or a demo. */
export function railIdleHeadAt(step: number): number {
	return step * RAIL_IDLE_ROWS_PER_STEP;
}

/** The idle head every live rail in the product is on, from one monotonic clock. Counting repaint ticks instead made the head's SPEED the punctuality of a */
export function railIdleHeadAtMs(nowMs: number): number {
	return nowMs / RAIL_IDLE_ROW_MS;
}

/** The monotonic clock the rails run on. */
export function railClockMs(): number {
	return performance.now();
}

/** The head that parks on the newest row of a block whose rows are still being written — an edit or a write whose diff grows as the arguments stream. */
export function railStreamHeadAtRow(railRows: number): number {
	if (railRows <= 0) return 0;
	return (railRows - 1) % railIdleCycleRows(railRows);
}

/** Rows the idle highlight travels before it repeats. Tied to the block's own height so a three-row block sees a whole pass instead of a highlight parked */
export function railIdleCycleRows(railRows: number): number {
	const cycle = railRows + RAIL_IDLE_GAP_ROWS;
	if (cycle < RAIL_IDLE_CYCLE_MIN_ROWS) return RAIL_IDLE_CYCLE_MIN_ROWS;
	if (cycle > RAIL_IDLE_CYCLE_MAX_ROWS) return RAIL_IDLE_CYCLE_MAX_ROWS;
	return cycle;
}

/** How lit row `railIndex` is, 0..1, for an idle head at `head`. */
export function railIdleIntensity(railIndex: number, railRows: number, head: number): number {
	const cycle = railIdleCycleRows(railRows);
	const wrapped = ((head % cycle) + cycle) % cycle;
	// Distance to the nearest pass of the head, so the tail of one pass and the
	// lead of the next are both visible on a rail taller than the cycle.
	let d = railIndex - wrapped;
	d -= cycle * Math.round(d / cycle);
	if (d > RAIL_IDLE_LEAD_ROWS) return 0;
	if (d >= 0) return 1 - d / RAIL_IDLE_LEAD_ROWS;
	const t = -d / RAIL_IDLE_TAIL_ROWS;
	if (t >= 1) return 0;
	return (1 - t) ** 2;
}

/** Head position for a settle frame, in rail rows. Starts above the first row and ends past the last one plus its tail, so frame 1 leaves every row on the */
export function railSettleHead(frame: number, railRows: number): number {
	const span = railRows + RAIL_SETTLE_TAIL_ROWS;
	return (frame / RAIL_SETTLE_FRAMES) * span - 1;
}

/** A `#rrggbb` string for one truecolor SGR's channels. */
function hexOf(r: number, g: number, b: number): string {
	return toHexColor(r, g, b);
}

interface RailCell {
	/** Index of the SGR that opens the rail glyph's colour. */
	start: number;
	/** Index just past that SGR. */
	end: number;
	/** The colour that SGR sets. */
	hex: string;
}

/** The `#rrggbb` an xterm 256 index stands for: the 6×6×6 cube, the 24 greys, and the 16 base colours the cube's own corners already describe. */
function ansi256Hex(index: number): string | undefined {
	if (index < 0 || index > 255) return undefined;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return hexOf(level, level, level);
	}
	if (index >= 16) {
		const CUBE = [0, 95, 135, 175, 215, 255];
		const n = index - 16;
		return hexOf(CUBE[Math.floor(n / 36)]!, CUBE[Math.floor(n / 6) % 6]!, CUBE[n % 6]!);
	}
	const BASE = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	return BASE[index];
}

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

/** The `#rrggbb` an SGR parameter list sets as a foreground, if it sets one. */
function fgHexOf(line: string, start: number, end: number): string | undefined {
	// Scan first token: must be "38".
	let pos = start;
	while (pos < end && line.charCodeAt(pos) !== 0x3b) pos++;
	if (pos - start !== 2 || line.charCodeAt(start) !== 0x33 || line.charCodeAt(start + 1) !== 0x38) return undefined;
	// Second token: mode ("5" or "2").
	pos++; // skip ';'
	const modeStart = pos;
	while (pos < end && line.charCodeAt(pos) !== 0x3b) pos++;
	const modeLen = pos - modeStart;
	if (modeLen === 1 && line.charCodeAt(modeStart) === 0x35) {
		// 256-color: one more token (index).
		pos++; // skip ';'
		const idxStart = pos;
		while (pos < end && line.charCodeAt(pos) !== 0x3b) pos++;
		if (pos !== end) return undefined; // must be exactly 3 tokens
		const index = parseSgrInt(line, idxStart, end);
		return index >= 0 ? ansi256Hex(index) : undefined;
	}
	if (modeLen === 1 && line.charCodeAt(modeStart) === 0x32) {
		// Truecolor: three more tokens (r;g;b).
		const rStart = pos + 1;
		let rEnd = rStart;
		while (rEnd < end && line.charCodeAt(rEnd) !== 0x3b) rEnd++;
		const gStart = rEnd + 1;
		let gEnd = gStart;
		while (gEnd < end && line.charCodeAt(gEnd) !== 0x3b) gEnd++;
		const bStart = gEnd + 1;
		if (bStart >= end) return undefined;
		const r = parseSgrInt(line, rStart, rEnd);
		const g = parseSgrInt(line, gStart, gEnd);
		const b = parseSgrInt(line, bStart, end);
		if (r < 0 || g < 0 || b < 0) return undefined;
		return hexOf(r, g, b);
	}
	return undefined;
}

/** Locate the rail glyph's colour in a rendered row. A railed row is `<inset spaces><SGRs><rail glyph>…`: the block writes the rail */
export function findRailCell(line: string, rail: string): RailCell | undefined {
	let i = 0;
	let fgStart = -1;
	let fgEnd = -1;
	let hex: string | undefined;
	while (i < line.length) {
		if (line.startsWith(rail, i)) {
			if (hex === undefined) return undefined;
			return { start: fgStart, end: fgEnd, hex };
		}
		if (line.startsWith("\x1b[", i)) {
			const m = line.indexOf("m", i + 2);
			if (m === -1) return undefined;
			const found = fgHexOf(line, i + 2, m);
			if (found !== undefined) {
				fgStart = i;
				fgEnd = m + 1;
				hex = found;
			}
			i = m + 1;
			continue;
		}
		if (line[i] !== " ") return undefined;
		i++;
	}
	return undefined;
}

/** How many rows in `lines` carry a rail this module can repaint. */
export function railRowCount(lines: readonly string[], rail: string): number {
	let count = 0;
	for (const line of lines) {
		if (findRailCell(line, rail)) count++;
	}
	return count;
}

/** The four colours one frame of rail motion mixes between. */
interface RailPalette {
	/** The colour the renderer drew this row in. */
	settled: string;
	/** The colour the rail carries while the tool is running. */
	live: string;
	/** The idle rail between passes: cooled, so a pass over it is visible. */
	cool: string;
	/** The head of a pass. */
	hot: string;
}

/** The colour row `railIndex` should carry, or `undefined` to leave it exactly as the renderer drew it. */
function railMotionColor(motion: RailMotion, railIndex: number, railRows: number, palette: RailPalette): string {
	if (motion.kind === "idle") {
		const lit = clamp01(railIdleIntensity(railIndex, railRows, motion.head));
		return blendHex(palette.cool, palette.hot, lit);
	}
	const d = railIndex - railSettleHead(motion.frame, railRows);
	if (d > 0.5) return palette.live;
	if (d >= -0.5) return palette.hot;
	const t = -d / RAIL_SETTLE_TAIL_ROWS;
	if (t >= 1) return palette.settled;
	// Behind the head the rail is already the colour it settles on; the tail only
	// carries the heat back toward it, so the pass reads as one moving edge.
	return blendHex(palette.settled, palette.live, (1 - t) ** 2);
}

/** Per-block adjustments to one frame of rail motion. */
export interface RailMotionOptions {
	/** Whether the head may light the railed row at `index`, counted over the railed rows only. A row this refuses keeps the colour its renderer gave it */
	lit?: (index: number) => boolean;
}

/** Repaint the rail cell of every railed row in `lines` for one frame of `motion`. Returns `lines` itself when the frame changes nothing, so an */
export function paintRailMotion(
	lines: readonly string[],
	motion: RailMotion,
	theme: Theme,
	options: RailMotionOptions = {},
): readonly string[] {
	const rail = theme.symbol("block.rail");
	const cells: Array<{ line: number; cell: RailCell }> = [];
	for (let i = 0; i < lines.length; i++) {
		const cell = findRailCell(lines[i]!, rail);
		if (cell) cells.push({ line: i, cell });
	}
	if (cells.length === 0) return lines;
	const live = theme.getColorHex("accent");
	const dim = theme.getColorHex("dim");
	let out: string[] | undefined;
	for (let index = 0; index < cells.length; index++) {
		const { line, cell } = cells[index]!;
		if (options.lit?.(index) === false) continue;
		const hex = railMotionColor(motion, index, cells.length, {
			settled: cell.hex,
			live,
			cool: blendHex(cell.hex, dim, RAIL_IDLE_COOL),
			hot: blendHex(cell.hex === dim ? live : cell.hex, "#ffffff", RAIL_HOT),
		});
		if (hex === cell.hex) continue;
		const ansi = theme.fgHexAnsi(hex);
		if (!ansi) return lines;
		out ??= lines.slice();
		const row = lines[line]!;
		out[line] = `${row.slice(0, cell.start)}${ansi}${row.slice(cell.end)}`;
	}
	return out ?? lines;
}
