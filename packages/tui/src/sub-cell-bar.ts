export const EIGHTH_BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

export const BAR_EIGHTHS_PER_CELL = 8;

export interface SubCellBarRamp {
	readonly full: string;
	readonly track: string;
	readonly partials: readonly string[];
}

export const SUB_CELL_BAR_RAMP: SubCellBarRamp = {
	full: "█",
	track: "░",
	partials: EIGHTH_BLOCKS,
};

export interface SubCellBarOptions {
	ramp?: SubCellBarRamp;
}

export function barGlyphEighths(glyph: string, ramp: SubCellBarRamp = SUB_CELL_BAR_RAMP): number | undefined {
	if (glyph === ramp.full) return BAR_EIGHTHS_PER_CELL;
	if (glyph === ramp.track) return 0;
	const index = ramp.partials.indexOf(glyph);
	return index < 0 ? undefined : index + 1;
}

export function subCellBar(ratio: number, width: number, options: SubCellBarOptions = {}): string {
	const cells = Number.isFinite(width) ? Math.floor(width) : 0;
	if (cells <= 0) return "";
	const ramp = options.ramp ?? SUB_CELL_BAR_RAMP;
	const steps = ramp.partials.length + 1;
	const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
	const filled = Math.round(clamped * cells * steps);
	const fullCells = Math.min(cells, Math.floor(filled / steps));
	const remainder = filled - fullCells * steps;
	const partial = remainder > 0 && fullCells < cells ? (ramp.partials[remainder - 1] ?? "") : "";
	const track = cells - fullCells - (partial ? 1 : 0);
	return ramp.full.repeat(fullCells) + partial + ramp.track.repeat(Math.max(0, track));
}
