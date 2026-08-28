import { SGR_RESET } from "@veyyon/tui/ansi";
import { clamp01 } from "@veyyon/utils";

export const FALLOFF = {
	innerEdge: 0.72,
	outerEdge: 1.02,
	limbStrength: 0.34,
	limbExponent: 1.5,
} as const;

export const GLYPH = ["·", "·", ":", "░", "▒", "▒", "▓", "█"] as const;

export const EMBER: ReadonlyArray<readonly [number, number, number]> = [
	[0x4a, 0x27, 0x14],
	[0x6e, 0x34, 0x18],
	[0x96, 0x43, 0x1b],
	[0xc2, 0x5a, 0x24],
	[0xf0, 0x86, 0x2e],
	[0xfb, 0x9e, 0x44],
	[0xfb, 0xc0, 0x6d],
	[0xff, 0xe3, 0xad],
];

const EMBER_256 = [52, 88, 130, 166, 208, 214, 220, 223] as const;
export const EMBER_FG_TRUECOLOR: readonly string[] = EMBER.map(([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`);
const EMBER_FG_256: readonly string[] = EMBER_256.map(n => `\x1b[38;5;${n}m`);

const CELL_ASPECT = 2.1;

export interface Ripple {
	x: number;
	y: number;
	age: number;
	amp: number;
}

export interface SunFieldOptions {
	cols: number;
	rows: number;
	cx: number;
	cy: number;
	radius: number;
	time: number;
	trueColor: boolean;
	ripples?: readonly Ripple[];
	intensity?: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

function hash(x: number, y: number, s: number): number {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function fg(trueColor: boolean, band: number): string {
	return trueColor ? EMBER_FG_TRUECOLOR[band]! : EMBER_FG_256[band]!;
}

export function renderSunField(o: SunFieldOptions): string[] {
	const { cols, rows, cx, cy, radius, time, trueColor } = o;
	const ripples = o.ripples ?? [];
	const R = Math.max(1, radius);
	const step = Math.floor(time * 5);
	const out: string[] = [];

	for (let y = 0; y < rows; y++) {
		let line = "";
		let lastBand = -1;
		let open = false;
		for (let x = 0; x < cols; x++) {
			const dx = x - cx;
			const dy = (y - cy) * CELL_ASPECT;
			const d = Math.hypot(dx, dy) / R;

			const base =
				(1 - smoothstep(FALLOFF.innerEdge, FALLOFF.outerEdge, d)) *
				(1 - FALLOFF.limbStrength * d ** FALLOFF.limbExponent);
			const corona = d > 1.0 && d < 1.26 ? smoothstep(1.26, 1.0, d) * 0.5 : 0;

			let rp = 0;
			for (let ri = 0; ri < ripples.length; ri++) {
				const r = ripples[ri]!;
				if (r.age < 0 || r.age > 3.2) continue;
				const rd = Math.hypot((x - r.x) * 0.5, y - r.y);
				rp += Math.sin(rd * 0.9 - r.age * 7) * Math.exp(-r.age * 1.7) * Math.exp(-rd * 0.12) * r.amp;
			}

			const churn =
				(Math.sin(x * 0.34 + time * 0.9) * Math.sin(y * 0.42 - time * 0.75) +
					Math.sin(x * 0.13 - y * 0.17 + time * 0.5)) *
				0.045;

			let val = base * 0.9 + rp * 0.55 + churn * base;
			if (base > 0.02) {
				val += (hash(x, y, step) - 0.5) * 0.2 * Math.min(1, base + 0.25);
			} else if (corona > 0 && hash(x, y, step + 5) < corona * 0.5) {
				val = corona * (0.5 + hash(x, y, 9) * 0.5);
			}
			if (base > 0.8) val += Math.sin(time * 1.3) * 0.04; // core shimmer
			if (o.intensity !== undefined) val *= o.intensity;

			if (val <= 0.12) {
				if (open) {
					line += SGR_RESET;
					open = false;
					lastBand = -1;
				}
				line += " ";
				continue;
			}
			const band = Math.min(7, Math.max(0, Math.floor(val * 8)));
			if (band !== lastBand) {
				line += fg(trueColor, band);
				lastBand = band;
				open = true;
			}
			line += GLYPH[band];
		}
		if (open) line += SGR_RESET;
		out.push(line);
	}
	return out;
}

export interface SunMarkOptions {
	trueColor: boolean;
	bloom?: number;
	rise?: number;
	time?: number;
	ripples?: readonly Ripple[];
}

export function sunMark(cols: number, rows: number, o: SunMarkOptions): string[] {
	const fullR = cols * 0.3;
	const p = o.bloom === undefined ? 1 : clamp01(o.bloom);
	const eased = 1 - (1 - p) ** 3; // easeOutCubic
	const radius = fullR * (0.12 + 0.88 * eased);
	const rise = o.rise === undefined ? 1 : 1 - (1 - clamp01(o.rise)) ** 3;
	const cy = (rows - 1) / 2 + (1 - rise) * (rows * 0.5 + radius + 1);
	return renderSunField({
		cols,
		rows,
		cx: cols / 2,
		cy,
		radius,
		time: o.time ?? 0.6,
		trueColor: o.trueColor,
		ripples: o.ripples,
	});
}

const SKY: ReadonlyArray<readonly [number, number, number]> = [
	[0x05, 0x04, 0x06],
	[0x0a, 0x06, 0x08],
	[0x12, 0x09, 0x0b],
	[0x1c, 0x0d, 0x0e],
	[0x28, 0x12, 0x10],
	[0x36, 0x18, 0x12],
	[0x46, 0x20, 0x14],
	[0x58, 0x29, 0x16],
	[0x6e, 0x34, 0x18],
	[0x84, 0x3f, 0x1a],
	[0x9a, 0x4b, 0x1c],
	[0xae, 0x58, 0x1f],
	[0xc0, 0x66, 0x22],
	[0xd2, 0x76, 0x26],
	[0xe2, 0x88, 0x2c],
	[0xf0, 0x9a, 0x34],
];
const SKY_256 = [16, 16, 52, 52, 52, 88, 88, 88, 88, 130, 130, 130, 166, 166, 166, 166] as const;
const SKY_BG_TRUECOLOR: readonly string[] = SKY.map(([r, g, bl]) => `\x1b[48;2;${r};${g};${bl}m`);
const SKY_BG_256: readonly string[] = SKY_256.map(n => `\x1b[48;5;${n}m`);

export interface SunsetFieldOptions {
	cols: number;
	rows: number;
	time: number;
	trueColor: boolean;
	horizonY?: number;
}

function skyBg(trueColor: boolean, band: number): string {
	const b = Math.min(SKY_BG_TRUECOLOR.length - 1, Math.max(0, band));
	return trueColor ? SKY_BG_TRUECOLOR[b]! : SKY_BG_256[b]!;
}

export function renderSunsetField(o: SunsetFieldOptions): string[] {
	const { cols, rows, time, trueColor } = o;
	const horizon = o.horizonY ?? Math.max(1, Math.round(rows * 0.78));
	const step = Math.floor(time * 3);
	const sunCx = cols / 2;
	const sunCy = horizon + 1.2; // the sun is mostly below the horizon — only its cap shows
	const sunR = Math.max(3, cols * 0.16);

	type Cell = { kind: "sky"; band: number } | { kind: "sun"; band: number };
	const grid: Cell[][] = [];
	for (let y = 0; y < rows; y++) {
		const rowCells: Cell[] = [];
		for (let x = 0; x < cols; x++) {
			if (y >= horizon) {
				rowCells.push({ kind: "sky", band: -1 });
				continue;
			}
			const dx = x - sunCx;
			const dy = (y - sunCy) * CELL_ASPECT;
			const d = Math.hypot(dx, dy) / sunR;
			if (d < 1 && hash(x, y, step) < 1 - smoothstep(0.75, 1.0, d)) {
				rowCells.push({ kind: "sun", band: Math.min(7, Math.max(4, Math.floor((1 - d) * 8))) });
				continue;
			}
			const t = 1 - y / Math.max(1, horizon);
			const bandF = t * t * (SKY.length - 1);
			const dither = (hash(x, y, 7) - 0.5) * 1.6;
			rowCells.push({ kind: "sky", band: Math.min(SKY.length - 1, Math.max(0, Math.round(bandF + dither))) });
		}
		grid.push(rowCells);
	}

	for (let s = 0; s < 9; s++) {
		const sx = Math.floor(hash(s, 3, 11) * cols);
		const speed = 0.5 + hash(s, 5, 17) * 0.8;
		const travel = Math.floor(time * speed + hash(s, 9, 23) * horizon);
		const y = horizon - 1 - (travel % Math.max(1, horizon));
		if (y < 0 || y >= horizon) continue;
		const altitude = 1 - y / Math.max(1, horizon);
		if (hash(s, y, step) > 1 - altitude * 0.8) continue; // fade with height
		grid[y][sx] = { kind: "sun", band: 3 + Math.floor(hash(s, y, 31) * 4) };
	}

	const out: string[] = [];
	for (let y = 0; y < rows; y++) {
		if (y === horizon) {
			out.push(
				trueColor
					? `\x1b[38;2;251;192;109m${"─".repeat(cols)}${SGR_RESET}`
					: `\x1b[38;5;220m${"─".repeat(cols)}${SGR_RESET}`,
			);
			continue;
		}
		if (y > horizon) {
			out.push("");
			continue;
		}
		let line = "";
		let lastKey = "";
		const gridRow = grid[y]!;
		for (let ci = 0; ci < gridRow.length; ci++) {
			const cell = gridRow[ci]!;
			if (cell.kind === "sky" && cell.band < 0) {
				if (lastKey !== "reset") {
					line += SGR_RESET;
					lastKey = "reset";
				}
				line += " ";
				continue;
			}
			const key = `${cell.kind}:${cell.band}`;
			if (key !== lastKey) {
				line += SGR_RESET + (cell.kind === "sky" ? skyBg(trueColor, cell.band) : fg(trueColor, cell.band));
				lastKey = key;
			}
			line += cell.kind === "sky" ? " " : GLYPH[cell.band];
		}
		out.push(line + SGR_RESET);
	}
	return out;
}

export function emberBandEscape(ratio: number, trueColor: boolean): string {
	const t = Math.min(1, Math.max(0, ratio));
	const band = Math.min(7, 2 + Math.round(t * 5));
	return fg(trueColor, band);
}

export function renderEmberField(o: {
	cols: number;
	rows: number;
	time: number;
	trueColor: boolean;
	base?: number;
	seed?: number;
}): string[] {
	const { cols, rows, time, trueColor } = o;
	const base = o.base ?? 0.72;
	const seed = o.seed ?? 0;
	const step = Math.floor(time * 3);
	const out: string[] = [];
	for (let y = 0; y < rows; y++) {
		let line = "";
		let lastBand = -1;
		for (let x = 0; x < cols; x++) {
			const val = base + (hash(x + seed, y, step) - 0.5) * 0.45;
			const band = Math.min(7, Math.max(0, Math.floor(Math.min(1, Math.max(0, val)) * 8)));
			if (band !== lastBand) {
				line += fg(trueColor, band);
				lastBand = band;
			}
			line += GLYPH[band];
		}
		out.push(line + SGR_RESET);
	}
	return out;
}
