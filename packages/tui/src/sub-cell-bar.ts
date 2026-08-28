// Horizontal bar rendering with sub-cell resolution (eight steps per column).

/**
 * The seven partial block glyphs, 1/8 through 7/8 of a cell in rising order.
 *
 * Exported so a consumer can map a glyph back to the number of eighths it
 * stands for — `EIGHTH_BLOCKS.indexOf(glyph) + 1` — instead of restating the
 * sequence and drifting from it.
 */
export const EIGHTH_BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/** How many sub-steps one cell of a bar is divided into. */
export const BAR_EIGHTHS_PER_CELL = 8;

/** The three glyph roles a bar needs. */
export interface SubCellBarRamp {
	/** A wholly filled cell. */
	readonly full: string;
	/** One cell of unfilled track. */
	readonly track: string;
	/**
	 * Partial fills in rising order, shortest first. Eight steps per cell means
	 * seven of them; an empty list means the terminal has no sub-cell glyphs, so
	 * the bar falls back to whole cells and the fill rounds to the nearest one.
	 */
	readonly partials: readonly string[];
}

/** The full-resolution ramp: eight steps per cell. */
export const SUB_CELL_BAR_RAMP: SubCellBarRamp = {
	full: "█",
	track: "░",
	partials: EIGHTH_BLOCKS,
};

export interface SubCellBarOptions {
	/** Glyphs to draw with. Defaults to {@link SUB_CELL_BAR_RAMP}. */
	ramp?: SubCellBarRamp;
}

/** Resolve number of eighths of a cell represented by a bar glyph. */
export function barGlyphEighths(glyph: string, ramp: SubCellBarRamp = SUB_CELL_BAR_RAMP): number | undefined {
	if (glyph === ramp.full) return BAR_EIGHTHS_PER_CELL;
	if (glyph === ramp.track) return 0;
	const index = ramp.partials.indexOf(glyph);
	return index < 0 ? undefined : index + 1;
}

/** Render `width` columns of bar for `ratio` fill at eight steps per column. */
export function subCellBar(ratio: number, width: number, options: SubCellBarOptions = {}): string {
	const cells = Number.isFinite(width) ? Math.floor(width) : 0;
	if (cells <= 0) return "";
	const ramp = options.ramp ?? SUB_CELL_BAR_RAMP;
	// A ramp with no partials is a whole-cell bar, and its fill must round to the
	// nearest whole cell rather than truncating: an ASCII terminal showing 0 for
	// everything under one cell is a worse bar than the one this replaced.
	const steps = ramp.partials.length + 1;
	const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
	const filled = Math.round(clamped * cells * steps);
	const fullCells = Math.min(cells, Math.floor(filled / steps));
	const remainder = filled - fullCells * steps;
	const partial = remainder > 0 && fullCells < cells ? (ramp.partials[remainder - 1] ?? "") : "";
	const track = cells - fullCells - (partial ? 1 : 0);
	return ramp.full.repeat(fullCells) + partial + ramp.track.repeat(Math.max(0, track));
}
