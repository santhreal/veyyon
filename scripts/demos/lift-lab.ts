/**
 * A bench for the LOOK, not for a component.
 *
 * The animations were called barely noticeable and the surfaces boring, and both
 * complaints are about the same thing: the product draws line art and text on one
 * flat ground. A terminal with truecolour can do surfaces — a filled panel with a
 * vertical gradient, a hairline lighter at the top edge than the bottom, a shadow
 * under the thing that is in front, a selection that is a filled band rather than
 * a coloured word, and a specular sweep that crosses a surface as it arrives.
 * Every one of those is a per-cell colour, which means it can be judged from a
 * PNG before any of it is wired into the app.
 *
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-settings-tab.ts |
 *       bun scripts/demos/lift-lab.ts --out /tmp/lift/settings --scale 3
 *
 * It writes `<out>-now-{grey,black}.png` (the bytes as they are today) and
 * `<out>-lift-{grey,black}.png` (the same cells with the surface treatment), so the
 * pair is a differential of the treatment alone: same component, same text, same
 * layout, only colour moved. `--sheen <0..1>` places the sweep; `--frames N` writes
 * N sheen positions so the sweep can be judged as motion rather than as one still.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type Cell, type Grid, type Rgb, ansiToGrid } from "./lib/ansi-grid";
import { BLACK_GROUND, GREY_GROUND, type Ground, rasterizeGrid } from "./lib/ansi-raster";
import { flag, hasFlag } from "./render-args";

const out = hasFlag("out") ? flag("out", "") : "";
if (!out) {
	console.error("usage: <renderer emitting ANSI> | bun scripts/demos/lift-lab.ts --out <prefix> [--scale N] [--sheen 0..1] [--frames N]");
	process.exit(2);
}
const scale = Number.parseInt(flag("scale", "3"), 10);
const frames = Number.parseInt(flag("frames", "1"), 10);
const sheenAt = Number.parseFloat(flag("sheen", "0.42"));

/** The page the surface sits on. Matches the grey proof ground. */
const PAGE: Rgb = [0x1e, 0x21, 0x27];
/** Top and bottom of the elevated surface: lit from above, so the top is lighter. */
const SURFACE_TOP: Rgb = [0x2b, 0x30, 0x39];
const SURFACE_BOTTOM: Rgb = [0x1f, 0x23, 0x2a];
/** The hairline at the very top edge of the surface, where the light lands. */
const HAIRLINE: Rgb = [0x3f, 0x47, 0x55];
/** The accent, used for exactly one thing per surface. */
const ACCENT: Rgb = [0xf0, 0x86, 0x2e];

const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
	Math.round(from[0] + (to[0] - from[0]) * t),
	Math.round(from[1] + (to[1] - from[1]) * t),
	Math.round(from[2] + (to[2] - from[2]) * t),
];
const lift = (color: Rgb, amount: number): Rgb => mix(color, [255, 255, 255], amount);
const sink = (color: Rgb, amount: number): Rgb => mix(color, [0, 0, 0], amount);

const BOX = new Set("─│┌┐└┘├┤┬┴┼╭╮╯╰━┃┏┓┗┛".split(""));

function cloneGrid(grid: Grid): Grid {
	return { width: grid.width, height: grid.height, rows: grid.rows.map(row => row.map(cell => ({ ...cell }))) };
}

/** The bounding box of the drawn frame: where the surface is. */
function cardBounds(grid: Grid): { top: number; bottom: number; left: number; right: number } | null {
	let top = Number.POSITIVE_INFINITY;
	let bottom = -1;
	let left = Number.POSITIVE_INFINITY;
	let right = -1;
	for (let y = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++) {
			if (!BOX.has(grid.rows[y][x].char)) continue;
			top = Math.min(top, y);
			bottom = Math.max(bottom, y);
			left = Math.min(left, x);
			right = Math.max(right, x);
		}
	}
	return bottom < 0 ? null : { top, bottom, left, right };
}

/**
 * Paint the surface treatment over already-rendered cells.
 *
 * Nothing here reads the component: it reads the cells the component produced. A
 * cell inside the frame gets the surface gradient behind whatever it already says,
 * the frame itself becomes a hairline that is lighter where the light is, the two
 * columns to the right and the row below fall into shadow, and the row that was
 * already carrying a filled selection keeps it as a gradient band with the accent
 * at its leading edge.
 */
function applyLift(grid: Grid, sheen: number | null): void {
	const bounds = cardBounds(grid);
	if (!bounds) return;
	const { top, bottom, left, right } = bounds;
	// The filled rows have to be found BEFORE the surface is painted: once every
	// cell inside the frame carries a background, "has a background" no longer
	// means "is selected", and the treatment floods the whole card with accent.
	const selectedRows = selectionSpans(grid, bounds);
	const height = bottom - top;

	// Everything outside the surface recedes: this is what makes the surface read
	// as being in front rather than as another block of text.
	for (let y = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++) {
			const inside = y >= top && y <= bottom && x >= left && x <= right;
			if (inside) continue;
			const cell = grid.rows[y][x];
			if (cell.fg) cell.fg = mix(cell.fg, PAGE, 0.6);
			if (cell.bg) cell.bg = mix(cell.bg, PAGE, 0.6);
		}
	}

	// The shadow the surface casts. Two columns and one row, falling off, so the
	// edge has a soft side rather than a drawn outline.
	for (let y = top + 1; y <= bottom + 1; y++) {
		for (let dx = 1; dx <= 2; dx++) {
			const x = right + dx;
			if (y >= grid.height || x >= grid.width) continue;
			const cell = grid.rows[y][x];
			cell.bg = sink(cell.bg ?? PAGE, dx === 1 ? 0.5 : 0.24);
		}
	}
	for (let x = left + 1; x <= right + 1; x++) {
		const y = bottom + 1;
		if (y >= grid.height || x >= grid.width) continue;
		const cell = grid.rows[y][x];
		cell.bg = sink(cell.bg ?? PAGE, 0.42);
	}

	// Apple's panels are made of two materials, not one: the sidebar sits a shade
	// deeper than the pane it selects into. One column of the frame's own divider
	// glyphs says where the split is, so this is read off the render rather than
	// configured.
	const divider = dividerColumn(grid, bounds);
	// A row that opens a group is the one thing on a settings pane a reader scans
	// for. The theme marks it with a bullet glyph; nothing else on the row says so.
	const headingRows = new Set<number>();
	for (let y = top; y <= bottom; y++) {
		if (grid.rows[y].some(cell => cell.char === "◆" || cell.char === "◇")) headingRows.add(y);
	}
	for (let y = top; y <= bottom; y++) {
		const t = height === 0 ? 0 : (y - top) / height;
		const surface = mix(SURFACE_TOP, SURFACE_BOTTOM, t);
		const span = selectedRows.get(y);
		for (let x = left; x <= right; x++) {
			const cell = grid.rows[y][x];
			if (!span || x < span.first || x > span.last) cell.bg = surface;
			if (divider !== null && x < divider && (!span || x < span.first || x > span.last)) {
				cell.bg = sink(surface, 0.34);
			}

			if (BOX.has(cell.char)) {
				// A hairline, not a drawn box: the top edge takes the light, the
				// sides are barely there, the bottom is a shadow line. The amber
				// frame was the loudest thing on screen and said nothing.
				const edgeLight = y === top ? 1 : y === bottom ? 0.15 : 0.45;
				cell.fg = mix(surface, HAIRLINE, edgeLight);
				cell.bold = false;
			} else if (cell.fg) {
				// Contrast expansion. A single mid-grey for labels, values, headings
				// and hints is most of why this reads as boring: everything is equally
				// important, so nothing is. What was already bright goes brighter, a
				// heading row goes brighter still, and what was quiet recedes into the
				// surface instead of competing with it.
				const luma = (cell.fg[0] * 0.299 + cell.fg[1] * 0.587 + cell.fg[2] * 0.114) / 255;
				const heading = headingRows.has(y) && (divider === null || x > divider);
				if (heading) {
					cell.fg = lift(cell.fg, 0.45);
					cell.bold = true;
				} else if (luma > 0.62) cell.fg = lift(cell.fg, 0.3);
				else cell.fg = mix(cell.fg, surface, 0.3);
			}
		}
	}

	if (sheen !== null) applySheen(grid, bounds, sheen);
	applyBand(grid, bounds, selectedRows);
}

/**
 * Where each filled row starts and ends, read off the cells as the theme wrote
 * them: an explicit background that is neither the page nor black.
 */
function selectionSpans(
	grid: Grid,
	bounds: { top: number; bottom: number; left: number; right: number },
): Map<number, { first: number; last: number }> {
	const spans = new Map<number, { first: number; last: number }>();
	for (let y = bounds.top; y <= bounds.bottom; y++) {
		let first = -1;
		let last = -1;
		for (let x = bounds.left; x <= bounds.right; x++) {
			const bg = grid.rows[y][x].bg;
			if (!bg) continue;
			const isPage = bg[0] === PAGE[0] && bg[1] === PAGE[1] && bg[2] === PAGE[2];
			if (isPage || bg[0] + bg[1] + bg[2] === 0) continue;
			if (first < 0) first = x;
			last = x;
		}
		// A single filled cell is a swatch or a scrollbar thumb, not a row band.
		if (first >= 0 && last - first >= 4) spans.set(y, { first, last });
	}
	return spans;
}

/**
 * The column the frame's own inner divider sits in, or null when the surface has
 * no second material. A divider is a column of vertical rule glyphs running most
 * of the surface's height; a stray `│` in a value does not qualify.
 */
function dividerColumn(grid: Grid, bounds: { top: number; bottom: number; left: number; right: number }): number | null {
	const span = bounds.bottom - bounds.top;
	if (span < 4) return null;
	for (let x = bounds.left + 2; x < bounds.right - 2; x++) {
		let run = 0;
		for (let y = bounds.top + 1; y < bounds.bottom; y++) {
			const char = grid.rows[y][x].char;
			if (char === "│" || char === "┃" || char === "┆") run++;
		}
		if (run >= span * 0.6) return x;
	}
	return null;
}

/**
 * The specular sweep. A band of raised luminance crossing the surface once, with a
 * cosine falloff so it has no edge, and a slight diagonal so it reads as light
 * moving over a plane instead of a wipe.
 */
function applySheen(grid: Grid, bounds: { top: number; bottom: number; left: number; right: number }, phase: number): void {
	const { top, bottom, left, right } = bounds;
	const span = right - left;
	// Narrow and strong. A wide soft band at low strength is not a highlight, it is
	// a lighter rectangle: the first pass covered a fifth of the surface at 10% and
	// read as the pane simply being brighter than the sidebar.
	const width = Math.max(4, Math.round(span * 0.09));
	const rows = Math.max(1, bottom - top);
	for (let y = top; y <= bottom; y++) {
		// Skewed by a fixed fraction of the surface, so the leading edge is the same
		// diagonal on a tall card as on a short one.
		const skew = ((y - top) / rows) * width * 2.2;
		const centre = left - width + phase * (span + width * 2) + skew;
		for (let x = left; x <= right; x++) {
			const d = Math.abs(x - centre) / width;
			if (d >= 1) continue;
			const strength = ((Math.cos(d * Math.PI) + 1) / 2) ** 1.4;
			const cell = grid.rows[y][x];
			cell.bg = lift(cell.bg ?? PAGE, strength * 0.26);
			if (cell.fg) cell.fg = lift(cell.fg, strength * 0.3);
		}
	}
}

/** The selected row, as a band that has a direction: accent at the leading edge. */
function applyBand(
	grid: Grid,
	bounds: { top: number; bottom: number; left: number; right: number },
	spans: Map<number, { first: number; last: number }>,
): void {
	for (const [y, { first, last }] of spans) {
		const row = grid.rows[y];
		const width = Math.max(1, last - first);
		for (let x = first; x <= last; x++) {
			const t = (x - first) / width;
			const cell = row[x];
			// Strong at the leading edge, gone by the trailing one: a band with a
			// direction reads as a thing the cursor is sitting on, where a flat slab
			// reads as a rectangle somebody drew.
			cell.bg = mix(mix(ACCENT, PAGE, 0.55), mix(ACCENT, PAGE, 0.94), t ** 0.55);
			if (cell.fg) cell.fg = lift(cell.fg, 0.4 * (1 - t * 0.6));
		}
		const edge = row[Math.max(bounds.left, first - 1)];
		edge.char = "▎";
		edge.fg = ACCENT;
		edge.bold = true;
	}
}

const text = await Bun.stdin.text();
const lines = text.replace(/\n$/, "").split("\n");
const measured = Math.max(1, ...lines.map(line => line.replace(/\x1b\[[0-9;]*[@-~]/g, "").length));
const base = ansiToGrid(lines, measured);

await fs.mkdir(path.dirname(out), { recursive: true });
const written: string[] = [];

async function writePair(grid: Grid, label: string): Promise<void> {
	for (const ground of [GREY_GROUND, BLACK_GROUND] as Ground[]) {
		const result = rasterizeGrid(grid, ground, { scale });
		const file = `${out}-${label}-${ground.name}.png`;
		await fs.writeFile(file, result.png);
		written.push(file);
	}
}

await writePair(base, "now");

if (frames > 1) {
	for (let i = 0; i < frames; i++) {
		const grid = cloneGrid(base);
		applyLift(grid, i / (frames - 1));
		await writePair(grid, `lift-f${String(i).padStart(2, "0")}`);
	}
} else {
	const grid = cloneGrid(base);
	applyLift(grid, Number.isFinite(sheenAt) ? sheenAt : null);
	await writePair(grid, "lift");
}

for (const file of written) console.error(`wrote ${file}`);
