/**
 * The texture a permission surface is drawn from: smooth noise, glyph ramps ordered by ink, a
 * seeded random, and grey scales quantised so a row of moving glyphs paints as a few colour runs.
 */
import { blendHex } from "@veyyon/utils/motion";

// ── noise ────────────────────────────────────────────────────────────────────────────────────

/** Ken Perlin's improved-noise permutation, doubled so lookups never wrap. */
const PERM = (() => {
	const random = seeded(0x5eed);
	const base = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[base[i], base[j]] = [base[j]!, base[i]!];
	}
	const table = new Uint8Array(512);
	for (let i = 0; i < 512; i++) table[i] = base[i & 255]!;
	return table;
})();

function fade(t: number): number {
	return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function grad(hash: number, x: number, y: number, z: number): number {
	const h = hash & 15;
	const u = h < 8 ? x : y;
	const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
	return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Gradient noise in about [-1, 1], smooth in every axis. */
export function noise3(x: number, y: number, z: number): number {
	const fx = Math.floor(x);
	const fy = Math.floor(y);
	const fz = Math.floor(z);
	const X = fx & 255;
	const Y = fy & 255;
	const Z = fz & 255;
	x -= fx;
	y -= fy;
	z -= fz;
	const u = fade(x);
	const v = fade(y);
	const w = fade(z);
	const A = PERM[X]! + Y;
	const AA = PERM[A]! + Z;
	const AB = PERM[A + 1]! + Z;
	const B = PERM[X + 1]! + Y;
	const BA = PERM[B]! + Z;
	const BB = PERM[B + 1]! + Z;
	return lerp(
		lerp(
			lerp(grad(PERM[AA]!, x, y, z), grad(PERM[BA]!, x - 1, y, z), u),
			lerp(grad(PERM[AB]!, x, y - 1, z), grad(PERM[BB]!, x - 1, y - 1, z), u),
			v,
		),
		lerp(
			lerp(grad(PERM[AA + 1]!, x, y, z - 1), grad(PERM[BA + 1]!, x - 1, y, z - 1), u),
			lerp(grad(PERM[AB + 1]!, x, y - 1, z - 1), grad(PERM[BB + 1]!, x - 1, y - 1, z - 1), u),
			v,
		),
		w,
	);
}

/** Noise summed over `octaves`, each at twice the frequency and half the weight, in about [-1, 1]. */
export function fbm3(x: number, y: number, z: number, octaves = 2): number {
	let sum = 0;
	let weight = 1;
	let total = 0;
	for (let o = 0; o < octaves; o++) {
		sum += noise3(x, y, z) * weight;
		total += weight;
		weight *= 0.5;
		x *= 2.03;
		y *= 2.03;
		z *= 2.03;
	}
	return sum / total;
}

/** A deterministic random in [0, 1) from `seed`: mulberry32. */
export function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A deterministic value in [0, 1) for the integer pair `(a, b)`: per-cell jitter that holds still between frames. */
export function hash2(a: number, b: number): number {
	let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ── braille ──────────────────────────────────────────────────────────────────────────────────

/** Braille dot bits by dot row within a cell, then dot column. */
const DOT_BITS: readonly (readonly [number, number])[] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

/** A 4x4 ordered-dither matrix, as thresholds in (0, 1). */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(n => (n + 0.5) / 16);

/**
 * A canvas of braille dots, two across and four down a cell, for lines finer than a cell. Each
 * cell also keeps the brightest level plotted into it, which a surface maps to a colour.
 */
export class DotCanvas {
	readonly cols: number;
	readonly rows: number;
	readonly #bits: Uint8Array;
	readonly #level: Float32Array;

	constructor(cols: number, rows: number) {
		this.cols = Math.max(0, cols);
		this.rows = Math.max(0, rows);
		this.#bits = new Uint8Array(this.cols * this.rows);
		this.#level = new Float32Array(this.cols * this.rows);
	}

	/** Light dot `(x, y)`, in dots from the top left, at `level`. Dots off the canvas are dropped. */
	plot(x: number, y: number, level: number): void {
		if (x < 0 || y < 0 || x >= this.cols * 2 || y >= this.rows * 4) return;
		const cell = (y >> 2) * this.cols + (x >> 1);
		this.#bits[cell]! |= DOT_BITS[y & 3]![x & 1]!;
		if (level > this.#level[cell]!) this.#level[cell] = level;
	}

	/** Light every dot of column `x` from row `from` to row `to`, either order. */
	span(x: number, from: number, to: number, level: number): void {
		for (let y = Math.min(from, to); y <= Math.max(from, to); y++) this.plot(x, y, level);
	}

	/**
	 * Light dot `(x, y)` when coverage `v` in [0, 1] beats the dot's ordered-dither threshold, so a
	 * smooth field becomes an even stipple whose density follows it.
	 */
	shade(x: number, y: number, v: number, level: number): void {
		if (v > BAYER[(y & 3) * 4 + (x & 3)]!) this.plot(x, y, level);
	}

	/** The braille glyph of cell `(col, row)`, or a space when no dot in it is lit. */
	glyph(col: number, row: number): string {
		const bits = this.#bits[row * this.cols + col]!;
		return bits === 0 ? " " : String.fromCharCode(0x2800 + bits);
	}

	/** The brightest level plotted into cell `(col, row)`. */
	level(col: number, row: number): number {
		return this.#level[row * this.cols + col]!;
	}
}

// ── glyphs ───────────────────────────────────────────────────────────────────────────────────

/** Glyphs from no ink to the most a light texture uses: mist, smoke, a field. */
export const MIST = " .·:-=+*";
/** Glyphs from no ink to full, for a lit solid. */
export const SOLID = " .,:;-=+*#%@";

/** The glyph of `ramp` for coverage `v` in [0, 1]. */
export function glyphOf(ramp: string, v: number): string {
	const i = Math.min(ramp.length - 1, Math.max(0, Math.floor(v * ramp.length)));
	return ramp[i]!;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/**
 * How open each column of `row` is for a texture to show through: 0 on a cell with ink and
 * on the cell beside it, rising smoothly to 1 at `halo` cells clear of any, so text floats in
 * a clearing rather than being drawn over. A row with no ink is open everywhere.
 */
export function openness(row: readonly { ch: string }[], halo: number): Float32Array {
	const n = row.length;
	const distance = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
	let last = Number.NEGATIVE_INFINITY;
	for (let x = 0; x < n; x++) {
		if (row[x]!.ch !== " ") last = x;
		distance[x] = x - last;
	}
	last = Number.POSITIVE_INFINITY;
	for (let x = n - 1; x >= 0; x--) {
		if (row[x]!.ch !== " ") last = x;
		distance[x] = Math.min(distance[x]!, last - x);
	}
	for (let x = 0; x < n; x++) distance[x] = smoothstep(1, halo + 1, distance[x]!);
	return distance;
}

// ── colour ───────────────────────────────────────────────────────────────────────────────────

/**
 * `steps` colours from `from` to `to`. A glyph picks the nearest step instead of its exact blend,
 * so neighbouring glyphs share a colour and the row paints as runs rather than one escape a cell.
 */
export function scale(from: string, to: string, steps: number): string[] {
	return Array.from({ length: steps }, (_, i) => blendHex(from, to, steps === 1 ? 1 : i / (steps - 1)));
}

/** The step of `colours` for `v` in [0, 1]. */
export function stepOf(colours: readonly string[], v: number): string {
	const i = Math.min(colours.length - 1, Math.max(0, Math.round(v * (colours.length - 1))));
	return colours[i]!;
}
