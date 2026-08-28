import { blendHex, toHexColor } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils/math";
import type { Theme } from "../modes/theme/theme";

export const RAIL_IDLE_STEP_MS = 60;
export const RAIL_IDLE_ROWS_PER_STEP = 0.25;
export const RAIL_IDLE_TAIL_ROWS = 3.5;
export const RAIL_IDLE_LEAD_ROWS = 0.9;
export const RAIL_IDLE_COOL = 0.55;
export const RAIL_HOT = 0.75;
export const RAIL_IDLE_GAP_ROWS = 6;
export const RAIL_IDLE_CYCLE_MIN_ROWS = 9;
export const RAIL_IDLE_CYCLE_MAX_ROWS = 26;

export const RAIL_SETTLE_FRAMES = 14;
export const RAIL_SETTLE_FRAME_MS = 45;
export const RAIL_SETTLE_TAIL_ROWS = 3;

export const RAIL_IDLE_ROW_MS = RAIL_IDLE_STEP_MS / RAIL_IDLE_ROWS_PER_STEP;

export interface RailIdleMotion {
	kind: "idle";
	head: number;
}

export interface RailSettleMotion {
	kind: "settle";
	frame: number;
}

export type RailMotion = RailIdleMotion | RailSettleMotion;

export function railIdleHeadAt(step: number): number {
	return step * RAIL_IDLE_ROWS_PER_STEP;
}

export function railIdleHeadAtMs(nowMs: number): number {
	return nowMs / RAIL_IDLE_ROW_MS;
}

export function railClockMs(): number {
	return performance.now();
}

export function railStreamHeadAtRow(railRows: number): number {
	if (railRows <= 0) return 0;
	return (railRows - 1) % railIdleCycleRows(railRows);
}

export function railIdleCycleRows(railRows: number): number {
	const cycle = railRows + RAIL_IDLE_GAP_ROWS;
	if (cycle < RAIL_IDLE_CYCLE_MIN_ROWS) return RAIL_IDLE_CYCLE_MIN_ROWS;
	if (cycle > RAIL_IDLE_CYCLE_MAX_ROWS) return RAIL_IDLE_CYCLE_MAX_ROWS;
	return cycle;
}

export function railIdleIntensity(railIndex: number, railRows: number, head: number): number {
	const cycle = railIdleCycleRows(railRows);
	const wrapped = ((head % cycle) + cycle) % cycle;
	let d = railIndex - wrapped;
	d -= cycle * Math.round(d / cycle);
	if (d > RAIL_IDLE_LEAD_ROWS) return 0;
	if (d >= 0) return 1 - d / RAIL_IDLE_LEAD_ROWS;
	const t = -d / RAIL_IDLE_TAIL_ROWS;
	if (t >= 1) return 0;
	return (1 - t) ** 2;
}

export function railSettleHead(frame: number, railRows: number): number {
	const span = railRows + RAIL_SETTLE_TAIL_ROWS;
	return (frame / RAIL_SETTLE_FRAMES) * span - 1;
}

function hexOf(r: number, g: number, b: number): string {
	return toHexColor(r, g, b);
}

interface RailCell {
	start: number;
	end: number;
	hex: string;
}

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

function parseSgrInt(line: string, start: number, end: number): number {
	let n = 0;
	for (let i = start; i < end; i++) {
		const c = line.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return -1;
		n = n * 10 + (c - 0x30);
	}
	return n;
}

function fgHexOf(line: string, start: number, end: number): string | undefined {
	let pos = start;
	while (pos < end && line.charCodeAt(pos) !== 0x3b) pos++;
	if (pos - start !== 2 || line.charCodeAt(start) !== 0x33 || line.charCodeAt(start + 1) !== 0x38) return undefined;
	pos++; // skip ';'
	const modeStart = pos;
	while (pos < end && line.charCodeAt(pos) !== 0x3b) pos++;
	const modeLen = pos - modeStart;
	if (modeLen === 1 && line.charCodeAt(modeStart) === 0x35) {
		pos++; // skip ';'
		const idxStart = pos;
		while (pos < end && line.charCodeAt(pos) !== 0x3b) pos++;
		if (pos !== end) return undefined; // must be exactly 3 tokens
		const index = parseSgrInt(line, idxStart, end);
		return index >= 0 ? ansi256Hex(index) : undefined;
	}
	if (modeLen === 1 && line.charCodeAt(modeStart) === 0x32) {
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

export function railRowCount(lines: readonly string[], rail: string): number {
	let count = 0;
	for (const line of lines) {
		if (findRailCell(line, rail)) count++;
	}
	return count;
}

interface RailPalette {
	settled: string;
	live: string;
	cool: string;
	hot: string;
}

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
	return blendHex(palette.settled, palette.live, (1 - t) ** 2);
}

export interface RailMotionOptions {
	lit?: (index: number) => boolean;
}

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
