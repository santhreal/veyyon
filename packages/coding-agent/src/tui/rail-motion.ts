/**
 * Motion on the rail a tool block hangs its output from.
 *
 * `renderOutputBlock` paints the rail one flat colour: accent while the tool is
 * live, dim once its result lands. That is two static states and a hard cut
 * between them, so a command that runs for four seconds shows a line that never
 * moves, and the moment its output arrives the whole rail changes colour in one
 * frame — the block appears to jump rather than to fill.
 *
 * This module is the rail's motion, and the only owner of it:
 *
 *   - **idle**: while the block is live, a highlight travels down the rail and
 *     leaves a short tail behind it, so a waiting block reads as working.
 *   - **settle**: when the result lands, that highlight makes one pass down the
 *     new height and leaves the settled colour behind it, so the rail cools from
 *     the top instead of flipping all at once.
 *
 * It works on RENDERED rows rather than on `OutputBlockOptions`, because the
 * frame belongs to the driver ({@link ToolExecutionComponent}, which owns the
 * repaint interval) and the rows belong to twenty different renderers, each
 * building its block its own way. Repainting the rail cell of a finished row
 * reaches all of them from one place; threading a frame number through every
 * renderer would reach the same pixels through twenty copies of the same
 * argument.
 *
 * Two invariants make that safe. The row COUNT never changes — only the colour
 * of the first cell of a row that already carries a rail — so no frame of this
 * animation can open a blank band or move a line. And the last frame of a
 * settle is byte-identical to the row the renderer produced, so the bytes that
 * reach native scrollback are the block's own.
 *
 * What it does not cover: the settle pass is 14 frames of 45 ms, and a block
 * that scrolls out of the visible window inside that window commits the frame
 * it was on, which for the rows below the travelling head is the live colour
 * rather than the settled one. That is the exposure the todo board's entrance
 * already carries; it is bounded by the same envelope and converges to the
 * static bytes rather than to a half-drawn state.
 */

import { blendHex } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils/math";
import type { Theme } from "../modes/theme/theme";

/** Milliseconds between idle steps. One repaint of one block per step. */
export const RAIL_IDLE_STEP_MS = 60;
/** Rows the idle highlight travels per step, so the head moves at ~8 rows/s. */
export const RAIL_IDLE_ROWS_PER_STEP = 0.5;
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

export interface RailIdleMotion {
	kind: "idle";
	/** Rows travelled since the block went live. Fractional. */
	head: number;
}

export interface RailSettleMotion {
	kind: "settle";
	/** 1..{@link RAIL_SETTLE_FRAMES}. */
	frame: number;
}

export type RailMotion = RailIdleMotion | RailSettleMotion;

/** Head position for an idle step counter. */
export function railIdleHeadAt(step: number): number {
	return step * RAIL_IDLE_ROWS_PER_STEP;
}

/**
 * Rows the idle highlight travels before it repeats. Tied to the block's own
 * height so a three-row block sees a whole pass instead of a highlight parked
 * off its end, and clamped at the top so a hundred-row block shows a train of
 * them rather than one cell an operator has to hunt for.
 */
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

/**
 * Head position for a settle frame, in rail rows. Starts above the first row
 * and ends past the last one plus its tail, so frame 1 leaves every row on the
 * colour it had while the tool was running and the final frame leaves every row
 * on the colour the renderer gave it.
 */
export function railSettleHead(frame: number, railRows: number): number {
	const span = railRows + RAIL_SETTLE_TAIL_ROWS;
	return (frame / RAIL_SETTLE_FRAMES) * span - 1;
}

/** A `#rrggbb` string for one truecolor SGR's channels. */
function hexOf(r: number, g: number, b: number): string {
	const two = (c: number): string => (c < 16 ? `0${c.toString(16)}` : c.toString(16));
	return `#${two(r)}${two(g)}${two(b)}`;
}

interface RailCell {
	/** Index of the SGR that opens the rail glyph's colour. */
	start: number;
	/** Index just past that SGR. */
	end: number;
	/** The colour that SGR sets. */
	hex: string;
}

/**
 * The `#rrggbb` an xterm 256 index stands for: the 6×6×6 cube, the 24 greys, and
 * the 16 base colours the cube's own corners already describe.
 */
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

/** The `#rrggbb` an SGR parameter list sets as a foreground, if it sets one. */
function fgHexOf(params: string): string | undefined {
	const parts = params.split(";");
	if (parts[0] !== "38") return undefined;
	if (parts[1] === "5" && parts.length === 3) {
		const index = Number(parts[2]);
		return Number.isInteger(index) ? ansi256Hex(index) : undefined;
	}
	if (parts[1] !== "2" || parts.length !== 5) return undefined;
	const r = Number(parts[2]);
	const g = Number(parts[3]);
	const b = Number(parts[4]);
	if (!Number.isInteger(r) || !Number.isInteger(g) || !Number.isInteger(b)) return undefined;
	return hexOf(r, g, b);
}

/**
 * Locate the rail glyph's colour in a rendered row.
 *
 * A railed row is `<inset spaces><SGRs><rail glyph>…`: the block writes the rail
 * as `theme.fg(borderColor, rail)`, the transcript insets it by
 * `COMPOSER_INSET_COLS`, and a state background may open before the foreground.
 * So only spaces and SGRs may precede the glyph — that is what separates the
 * rail from a `▏` inside a tool's own output, which this must never repaint —
 * and the colour taken is the last foreground opened before it. Both spellings
 * the theme's colour modes produce are read, `38;2;r;g;b` and `38;5;n`, so a
 * 256-colour terminal animates too, in the steps its palette has.
 *
 * Returns `undefined` for a row that is not railed (a header, a blank, a sixel)
 * and for a rail drawn with no colour at all, where the honest frame is the row
 * the renderer produced.
 */
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
			const found = fgHexOf(line.slice(i + 2, m));
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

/** Whether any row in `lines` carries a rail this module can repaint. */
export function hasRailRow(lines: readonly string[], rail: string): boolean {
	for (const line of lines) {
		if (findRailCell(line, rail)) return true;
	}
	return false;
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

/**
 * The colour row `railIndex` should carry, or `undefined` to leave it exactly as
 * the renderer drew it.
 *
 * The idle rail moves between `cool` and `hot` rather than between the accent and
 * white: on a theme whose accent is already near-white — titanium's is
 * `#c6cbd4` — brightening it moves 20 of 255 levels and reads as nothing at all,
 * which is how an animation ends up technically present and invisible. Cooling
 * the rail between passes is what gives the pass something to be brighter than.
 */
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

/**
 * Repaint the rail cell of every railed row in `lines` for one frame of
 * `motion`. Returns `lines` itself when the frame changes nothing, so an
 * unchanged block keeps the array identity the render contract treats as proof
 * its bytes did not move.
 */
export function paintRailMotion(lines: readonly string[], motion: RailMotion, theme: Theme): readonly string[] {
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
		const hex = railMotionColor(motion, index, cells.length, {
			settled: cell.hex,
			live,
			cool: blendHex(cell.hex, dim, RAIL_IDLE_COOL),
			hot: blendHex(cell.hex === dim ? live : cell.hex, "#ffffff", RAIL_HOT),
		});
		if (hex === cell.hex) continue;
		const ansi = theme.fgHexAnsi(hex);
		if (!ansi) return lines;
		out ??= [...lines];
		const row = lines[line]!;
		out[line] = `${row.slice(0, cell.start)}${ansi}${row.slice(cell.end)}`;
	}
	return out ?? lines;
}
