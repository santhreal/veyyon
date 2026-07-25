/**
 * Draw styled terminal output as an image, on a ground you choose.
 *
 * This is the admissible form of evidence for a visual change. A terminal capture
 * is not: it renders on the capturing terminal's own ground (usually pure black),
 * strips or mangles styling, and drops trailing styled cells, which is exactly the
 * information a fill, spacing or contrast change lives in. Rendering the component's
 * own bytes into pixels, twice, against two different grounds, shows what the change
 * did on a dark-grey terminal AND on a black one, and the pair can be compared.
 *
 * The two grounds matter because they are where the same bug reads differently: an
 * explicit dark fill is invisible against black and reads as a slab against grey,
 * and a component that leans on the terminal's default background looks fine on one
 * and wrong on the other. Neither image alone answers the question.
 *
 * Nothing here consults the environment. The same lines and the same ground produce
 * the same bytes on every machine and in CI, so a proof can be committed, diffed,
 * and re-generated years later.
 */
import { ansiToGrid, type Cell, type Grid, type Rgb } from "./ansi-grid";
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphRows, MISSING_GLYPH } from "./glyphs";
import { BYTES_PER_PIXEL, encodePng } from "./png";

/**
 * A named ground to draw against.
 *
 * `grey` is the #1e2127-class background a real terminal profile uses, and it is the
 * one that exposes a component filling its own background. `black` is the terminal
 * default that hides exactly that. Both are always produced, because a change judged
 * on one of them is a change that has been half checked.
 */
export interface Ground {
	name: string;
	background: Rgb;
	/** What the terminal's default foreground resolves to on this ground. */
	foreground: Rgb;
}

export const GREY_GROUND: Ground = { name: "grey", background: [0x1e, 0x21, 0x27], foreground: [0xd8, 0xdc, 0xe4] };
export const BLACK_GROUND: Ground = { name: "black", background: [0x00, 0x00, 0x00], foreground: [0xe6, 0xe6, 0xe6] };

/** Both grounds, in the order a reviewer should look at them. */
export const GROUNDS: readonly Ground[] = [GREY_GROUND, BLACK_GROUND];

export interface RasterOptions {
	/** Pixels per glyph pixel. 2 keeps a 200-column render legible without bloat. */
	scale?: number;
	/** Blank pixels between cells horizontally, scaled. Keeps glyphs from touching. */
	cellPaddingX?: number;
	/** Blank pixels between rows, scaled. Terminal line spacing. */
	cellPaddingY?: number;
	/** Pixels of ground around the whole render, so edge fills are visible as fills. */
	margin?: number;
}

export interface RasterResult {
	png: Uint8Array;
	width: number;
	height: number;
	/**
	 * Characters drawn as the missing-glyph box, deduplicated.
	 *
	 * Surfaced so a caller can say so out loud. A proof peppered with boxes nobody
	 * mentioned reads as a bug in the component being proved, which is the most
	 * expensive kind of wrong a proof can be.
	 */
	unmapped: string[];
}

const DEFAULTS = { scale: 2, cellPaddingX: 1, cellPaddingY: 2, margin: 8 } as const;

/** Halve a colour's distance to the ground, which is what a terminal's dim does. */
function dimmed(color: Rgb, ground: Rgb): Rgb {
	return [
		Math.round(ground[0] + (color[0] - ground[0]) * 0.55),
		Math.round(ground[1] + (color[1] - ground[1]) * 0.55),
		Math.round(ground[2] + (color[2] - ground[2]) * 0.55),
	];
}

/** Push a colour away from the ground, standing in for a bold face. */
function brightened(color: Rgb): Rgb {
	return [
		Math.min(255, Math.round(color[0] * 1.25 + 12)),
		Math.min(255, Math.round(color[1] * 1.25 + 12)),
		Math.min(255, Math.round(color[2] * 1.25 + 12)),
	];
}

/** The colours a cell actually paints, with reverse, dim and bold resolved. */
export function resolveCellColors(cell: Cell, ground: Ground): { fg: Rgb; bg: Rgb } {
	let fg = cell.fg ?? ground.foreground;
	let bg = cell.bg ?? ground.background;
	if (cell.reverse) {
		const swapped = fg;
		fg = bg;
		bg = swapped;
	}
	if (cell.bold) fg = brightened(fg);
	if (cell.dim) fg = dimmed(fg, bg);
	return { fg, bg };
}

/**
 * Rasterize a decoded grid.
 *
 * Every cell paints its background across the FULL cell, padding included, so a
 * one-column gap in a fill shows up as a one-column stripe of ground rather than
 * being swallowed by the spacing. That is deliberate: the bugs this tool exists to
 * catch are gaps and edges in fills.
 */
export function rasterizeGrid(grid: Grid, ground: Ground, options: RasterOptions = {}): RasterResult {
	const scale = options.scale ?? DEFAULTS.scale;
	const padX = options.cellPaddingX ?? DEFAULTS.cellPaddingX;
	const padY = options.cellPaddingY ?? DEFAULTS.cellPaddingY;
	const margin = options.margin ?? DEFAULTS.margin;

	const cellW = (GLYPH_WIDTH + padX) * scale;
	const cellH = (GLYPH_HEIGHT + padY) * scale;
	const width = grid.width * cellW + margin * 2;
	const height = grid.height * cellH + margin * 2;
	const pixels = new Uint8Array(width * height * BYTES_PER_PIXEL);

	const put = (x: number, y: number, color: Rgb): void => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const offset = (y * width + x) * BYTES_PER_PIXEL;
		pixels[offset] = color[0];
		pixels[offset + 1] = color[1];
		pixels[offset + 2] = color[2];
	};
	const fillRect = (x0: number, y0: number, w: number, h: number, color: Rgb): void => {
		for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, color);
	};

	// The margin is ground, so an edge-to-edge fill is visibly edge-to-edge.
	fillRect(0, 0, width, height, ground.background);

	const unmapped = new Set<string>();
	for (let row = 0; row < grid.height; row++) {
		for (let col = 0; col < grid.width; col++) {
			const cell = grid.rows[row][col];
			const { fg, bg } = resolveCellColors(cell, ground);
			const originX = margin + col * cellW;
			const originY = margin + row * cellH;
			fillRect(originX, originY, cellW, cellH, bg);
			if (cell.continuation || cell.char === " ") {
				if (cell.underline) fillRect(originX, originY + cellH - scale, cellW, scale, fg);
				continue;
			}
			// A grapheme cluster draws from its base character; the marks it carries
			// have no 5x7 form and adding boxes for them would bury the text.
			const base = [...cell.char][0] ?? " ";
			const rows = glyphRows(base);
			if (!rows) unmapped.add(base);
			const bitmap = rows ?? MISSING_GLYPH.split("/");
			for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
				const line = bitmap[gy] ?? "";
				for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
					if (line[gx] !== "#") continue;
					// Italic leans the glyph, one pixel per two rows, as a terminal does.
					const slant = cell.italic ? Math.floor((GLYPH_HEIGHT - 1 - gy) / 2) : 0;
					fillRect(originX + (gx + slant) * scale, originY + gy * scale, scale, scale, fg);
				}
			}
			if (cell.underline) fillRect(originX, originY + cellH - scale, cellW, scale, fg);
		}
	}

	return { png: encodePng(width, height, pixels), width, height, unmapped: [...unmapped].sort() };
}

/**
 * The whole path in one call: styled lines in, a PNG per ground out.
 *
 * `width` is the column count the lines were rendered at, and it is required rather
 * than inferred from the longest line: a component that ends a line early is exactly
 * what a proof needs to show, and measuring the widest line would quietly crop the
 * empty right edge that carries that information.
 */
export function proofsForLines(
	lines: string[],
	width: number,
	options: RasterOptions = {},
): Array<{ ground: Ground } & RasterResult> {
	const grid = ansiToGrid(lines, width);
	return GROUNDS.map(ground => ({ ground, ...rasterizeGrid(grid, ground, options) }));
}
