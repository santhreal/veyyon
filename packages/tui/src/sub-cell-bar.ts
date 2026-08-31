// One owner for every horizontal bar the product draws.
//
// A bar built from `█` and `░` has exactly one step per column: a ten-column
// bar has ten states, so a value that moves by 3% does not move at all, and a
// value that crosses a column boundary jumps a whole cell. That is why the
// gauges read as flicking between positions rather than travelling: there is
// nothing between two positions to travel through.
//
// Unicode has the seven partial block glyphs `▏▎▍▌▋▊▉`, so one cell carries
// eight horizontal steps. The same ten columns become eighty states, at no cost
// in width and none in colour. A bar animated over a spring then has enough
// distinct frames for the motion to be visible, which whole cells cannot do.
//
// This returns GLYPHS AND NOTHING ELSE. Colour is the caller's: the three
// surfaces that draw a bar in the TUI paint it through the theme, and the three
// CLI surfaces paint it through chalk, so a bar that carried its own colour
// would have to know which. Width is the caller's too — `width` columns in,
// `width` columns out, always, because hit-testing and column layout elsewhere
// are computed from positions in the row.
//
// The ramp is an option rather than a constant because a terminal without the
// block glyphs must not be sent them. `@veyyon/tui` has no symbol presets, so
// the ramp arrives from whoever knows: in this product that is the theme's
// symbol preset (`unicode` / `nerd` / `ascii`), and an `ascii` ramp carries no
// partials at all, which degrades this function back to whole cells.

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

/**
 * How many eighths of a cell a bar glyph stands for, or `undefined` when the
 * glyph is not part of `ramp`.
 *
 * The inverse of what {@link subCellBar} writes, so a consumer reading a
 * rendered bar back — a test asserting the fill never goes backwards, a
 * renderer measuring one — resolves the value through the same ramp that drew
 * it rather than recomputing it from the input.
 */
export function barGlyphEighths(glyph: string, ramp: SubCellBarRamp = SUB_CELL_BAR_RAMP): number | undefined {
	if (glyph === ramp.full) return BAR_EIGHTHS_PER_CELL;
	if (glyph === ramp.track) return 0;
	const index = ramp.partials.indexOf(glyph);
	return index < 0 ? undefined : index + 1;
}

/**
 * `width` columns of bar for `ratio` of fill, at eight steps per column.
 *
 * `ratio` clamps to `[0, 1]`; anything that is not a number reads as 0. A
 * `width` at or below zero is an empty string, so a caller squeezed to nothing
 * prints nothing rather than a stray glyph.
 *
 * The fill is quantised ONCE, in eighths across the whole bar, and the cells
 * are derived from that count. A ratio landing on a cell boundary therefore has
 * no remainder to draw and emits no partial glyph — never `█▏` where `██` is
 * meant — and a ratio just under one keeps its `▉` instead of rounding up into
 * a cell it has not reached.
 */
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
