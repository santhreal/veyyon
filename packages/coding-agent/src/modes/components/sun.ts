/**
 * The Veyyon sun — the brand signature, rendered in the terminal's own cells.
 *
 * veyyōn (வெய்யோன்) is Tamil for "the sun". This is the terminal port of
 * `website/sun.js`: a dense field of monospace glyphs shaded by distance from a
 * centre, coloured in stepped ember bands with per-cell ordered dither. It reads
 * as "tech meets sun" — sharp and cell-native, never a smooth gradient blob
 * (docs/internal/design.md). The ember accent leads *here* — the sun is the one
 * place it does; silver carries everything around it.
 *
 * This module is pure. `renderSunField(opts)` returns an array of ANSI rows.
 * Animation — the bloom on launch and the settle to a small resting mark — is
 * driven entirely by the caller varying `time`, `cx/cy`, and `radius`; the field
 * itself holds no state. Ripples (cursor/keypress flares) are passed in as data.
 */

import { padLineToWidth } from "@veyyon/tui";
import { clamp01 } from "@veyyon/utils";

/**
 * The Canvas ground (design.md "Canvas"): a surface that owns the whole
 * viewport paints pure black edge to edge. One owner for the escape so the
 * sun's under-glyph ground and the full-surface painter can never drift.
 */
export const CANVAS_BG_ESCAPE = "\x1b[48;2;0;0;0m";

/**
 * Paint a full-viewport surface's rows onto the pure-black Canvas ground.
 *
 * Each row is prefixed with the black background, padded (ANSI-aware) to the
 * full width so the ground reaches the right edge, and closed with a reset so
 * nothing leaks past the surface. A row's own `\x1b[0m` / `\x1b[49m` resets
 * would punch holes in the ground from that point on, so the ground is
 * re-armed immediately after every one. For full-viewport overlays ONLY
 * (setup wizard splash/scenes/outro); the inline transcript never paints
 * backgrounds.
 */
export function paintCanvasBlack(lines: readonly string[], width: number): string[] {
	return lines.map(line => {
		const rearmed = line.replaceAll("\x1b[0m", `\x1b[0m${CANVAS_BG_ESCAPE}`).replaceAll("\x1b[49m", CANVAS_BG_ESCAPE);
		return `${CANVAS_BG_ESCAPE}${padLineToWidth(rearmed, width)}\x1b[0m`;
	});
}

/**
 * Intensity → glyph. Eight stops, dark core of the void to a solid disc.
 * Exported so brand-conformance can pin website/sun-field.js to this exact
 * vocabulary: the web hero and the terminal splash must draw one glyph ramp.
 */
export const GLYPH = ["·", "·", ":", "░", "▒", "▒", "▓", "█"] as const;

/**
 * Ember band stops (dark rim → white-hot core), truecolor. Mirrors sun.js.
 * Bands 4/5 are the brand ember (website --sun / --sun-hi); brand-conformance
 * tests pin them to site.css so the two shipped suns cannot drift apart.
 */
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

/** xterm-256 ember approximation for non-truecolor terminals, same ordering. */
const EMBER_256 = [52, 88, 130, 166, 208, 214, 220, 223] as const;

/**
 * Terminal cells are about twice as tall as they are wide, so a geometric
 * circle in cell space looks like a tall ellipse. Counting each row-step as
 * this many column-steps of distance makes the sun render visually round.
 */
const CELL_ASPECT = 2.1;

const RESET = "\x1b[0m";

export interface Ripple {
	/** Centre in cells. */
	x: number;
	y: number;
	/** Seconds since this ripple was spawned (caller advances it). */
	age: number;
	/** Peak amplitude (cursor drift ~0.3, click/keypress flare ~1.0). */
	amp: number;
}

export interface SunFieldOptions {
	/** Field size in cells. */
	cols: number;
	rows: number;
	/** Sun centre, in cells (may be fractional). */
	cx: number;
	cy: number;
	/** Sun radius, in columns. */
	radius: number;
	/** Seconds — drives churn, dither animation, and core shimmer. */
	time: number;
	/** True to emit 24-bit colour; false uses the 256-colour ember ramp. */
	trueColor: boolean;
	/** Paint a pitch-black background behind every cell so the ground is #000 regardless of terminal theme. */
	paintBackground?: boolean;
	/** Active ripples that perturb the field (cursor drift, keypress flares). */
	ripples?: readonly Ripple[];
	/** 0..1 — scales every cell down the ember ramp (faded ghost marks). Omit for full fire. */
	intensity?: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
}

/** Stable per-cell hash in [0, 1) — the ordered-dither and corona source. */
function hash(x: number, y: number, s: number): number {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function fg(trueColor: boolean, band: number): string {
	if (trueColor) {
		const [r, g, b] = EMBER[band];
		return `\x1b[38;2;${r};${g};${b}m`;
	}
	return `\x1b[38;5;${EMBER_256[band]}m`;
}

/**
 * Render the sun as an array of `rows` strings, each `cols` cells wide. Cells
 * below the visibility threshold are spaces (black ground); everything else is
 * an ember glyph. The result is ready to drop into a component's line list.
 */
export function renderSunField(o: SunFieldOptions): string[] {
	const { cols, rows, cx, cy, radius, time, trueColor } = o;
	const ripples = o.ripples ?? [];
	const R = Math.max(1, radius);
	// Animation step for the dither so it shimmers without thrashing every frame.
	const step = Math.floor(time * 5);
	const bgPrefix = o.paintBackground ? CANVAS_BG_ESCAPE : "";
	const out: string[] = [];

	for (let y = 0; y < rows; y++) {
		let line = bgPrefix;
		let lastBand = -1;
		let open = false;
		for (let x = 0; x < cols; x++) {
			const dx = x - cx;
			const dy = (y - cy) * CELL_ASPECT;
			const d = Math.hypot(dx, dy) / R;

			// Core disc falls off between 0.72R and 1.02R; a faint corona lives just outside.
			const base = 1 - smoothstep(0.72, 1.02, d);
			const corona = d > 1.0 && d < 1.26 ? smoothstep(1.26, 1.0, d) * 0.5 : 0;

			// Ripples: damped ring wavelets, like a struck pond, cell-space distance.
			let rp = 0;
			for (const r of ripples) {
				if (r.age < 0 || r.age > 3.2) continue;
				const rd = Math.hypot((x - r.x) * 0.5, y - r.y);
				rp += Math.sin(rd * 0.9 - r.age * 7) * Math.exp(-r.age * 1.7) * Math.exp(-rd * 0.12) * r.amp;
			}

			// Low-frequency churn keeps the disc alive without a smooth gradient.
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
					line += RESET + bgPrefix;
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
		if (open || bgPrefix) line += RESET;
		out.push(line);
	}
	return out;
}

export interface SunMarkOptions {
	trueColor: boolean;
	/** 0 = a hot point, 1 = the fully bloomed resting disc. Omit to rest at full. */
	bloom?: number;
	/** 0 = fully below the field's bottom edge (the horizon), 1 = risen to centre. */
	rise?: number;
	/** Advance for live shimmer/churn; defaults to a fixed resting seed. */
	time?: number;
	ripples?: readonly Ripple[];
	/** Paint a pitch-black ground under the mark (guarantees #000 behind it). */
	paintBackground?: boolean;
}

/**
 * A centred sun mark sized for a logo slot — this is the tuned recipe behind the
 * launch signature so callers don't re-derive it. The radius is cell-aspect
 * correct for a round disc, and `bloom` (0→1) eases the disc open with
 * easeOutCubic. Drive `bloom` from 0 to 1 on launch for the rising sun, then
 * omit it (rests at full); flares go through `ripples`.
 */
export function sunMark(cols: number, rows: number, o: SunMarkOptions): string[] {
	const fullR = cols * 0.3;
	const p = o.bloom === undefined ? 1 : clamp01(o.bloom);
	const eased = 1 - (1 - p) ** 3; // easeOutCubic
	const radius = fullR * (0.12 + 0.88 * eased);
	// The sunrise: at rise 0 the disc rests fully below the field's bottom edge
	// (the horizon); at rise 1 it has risen to centre. Same easeOutCubic so the
	// rise and bloom stay in lockstep when driven by one clock.
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
		paintBackground: o.paintBackground,
	});
}

/*
 * The sunset — the ceremony's closing beat, mirroring the website's page
 * finale: a blood-orange dithered sky (true background pixels, not fg tints),
 * the sun's arc sinking below a hot horizon line, sparks rising off the glow.
 */

/** Sunset sky ramp: near-black zenith down to the ember band at the horizon. */
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

export interface SunsetFieldOptions {
	/** Field size in cells. */
	cols: number;
	rows: number;
	/** Seconds — drives sky dither and spark drift. */
	time: number;
	/** True to emit 24-bit colour; false uses the 256-colour ramps. */
	trueColor: boolean;
	/** Horizon row from the top; defaults to ~0.78 of the field. */
	horizonY?: number;
}

function skyBg(trueColor: boolean, band: number): string {
	const b = Math.min(SKY.length - 1, Math.max(0, band));
	if (trueColor) {
		const [r, g, bl] = SKY[b];
		return `\x1b[48;2;${r};${g};${bl}m`;
	}
	return `\x1b[48;5;${SKY_256[b]}m`;
}

/**
 * Render the sunset as `rows` strings of `cols` cells. Composed as a cell
 * matrix — sky band, sun arc, and sparks resolved per cell, then painted with
 * run-length colour runs. The sky is background pixels so the gradient is
 * continuous; the sun is the dithered ember disc clipped hard at the horizon.
 */
export function renderSunsetField(o: SunsetFieldOptions): string[] {
	const { cols, rows, time, trueColor } = o;
	const horizon = o.horizonY ?? Math.max(1, Math.round(rows * 0.78));
	const step = Math.floor(time * 3);
	const sunCx = cols / 2;
	const sunCy = horizon + 1.2; // the sun is mostly below the horizon — only its cap shows
	const sunR = Math.max(3, cols * 0.16);

	// Per-cell compose: "sky" carries a SKY band, "sun" an EMBER band.
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
			// Sky band: darker with altitude, squared easing so the blend out of
			// black never pops (the website's sunset lesson), ordered dither so
			// the ramp reads as texture, not stripes.
			const t = 1 - y / Math.max(1, horizon);
			const bandF = t * t * (SKY.length - 1);
			const dither = (hash(x, y, 7) - 0.5) * 1.6;
			rowCells.push({ kind: "sky", band: Math.min(SKY.length - 1, Math.max(0, Math.round(bandF + dither))) });
		}
		grid.push(rowCells);
	}

	// Sparks: nine embers drifting up off the sunset, fading with altitude.
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
			// The horizon: one hot line the sun melts into.
			out.push(
				trueColor
					? `\x1b[38;2;251;192;109m${"─".repeat(cols)}${RESET}`
					: `\x1b[38;5;220m${"─".repeat(cols)}${RESET}`,
			);
			continue;
		}
		if (y > horizon) {
			out.push("");
			continue;
		}
		let line = "";
		let lastKey = "";
		for (const cell of grid[y]) {
			if (cell.kind === "sky" && cell.band < 0) {
				if (lastKey !== "reset") {
					line += RESET;
					lastKey = "reset";
				}
				line += " ";
				continue;
			}
			const key = `${cell.kind}:${cell.band}`;
			if (key !== lastKey) {
				line += RESET + (cell.kind === "sky" ? skyBg(trueColor, cell.band) : fg(trueColor, cell.band));
				lastKey = key;
			}
			line += cell.kind === "sky" ? " " : GLYPH[cell.band];
		}
		out.push(line + RESET);
	}
	return out;
}

/** A position on the ember ramp as an fg escape — the sun heating from a low
 *  coal (0) toward white-hot (1). The cold end starts at band 2 so text stays
 *  legible; band 0 is near-black ground. */
export function emberBandEscape(ratio: number, trueColor: boolean): string {
	const t = Math.min(1, Math.max(0, ratio));
	const band = Math.min(7, 2 + Math.round(t * 5));
	return fg(trueColor, band);
}

/**
 * A rectangular patch of the sun's churn — dithered ember bands with no disc.
 * The texture the pause bars are cut from; `seed` offsets the dither so two
 * fields side by side don't churn in lockstep.
 */
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
		out.push(line + RESET);
	}
	return out;
}
