// What a card is MADE OF, as opposed to where its edges are.
//
// The product drew line art: a frame in one accent colour, text in one grey, on
// the terminal's own ground. Nothing was a surface, so nothing was in front of
// anything, and an animation over it had nothing to move except whole rows. That
// is the whole of "the animations are barely noticeable": a 220ms unfold over a
// grid whose smallest unit is one row has about five distinct frames, and four of
// them look like the fifth.
//
// A truecolor terminal can do better, and every part of it is per-cell colour:
//
//   elevation  a fill a few percent off the ground, lighter at the top edge than
//              the bottom, so the surface reads as lit from above and as being in
//              front of the page rather than drawn onto it.
//   hairline   the frame carrying the light instead of an accent: bright along the
//              top, barely there at the sides, a shadow line underneath.
//   sweep      one specular highlight crossing the surface as it arrives. This is
//              the part with 60 distinct frames instead of 5, because it moves
//              through colour rather than through rows.
//
// Everything here is a pure transform over lines a component already rendered, on
// the same reasoning as `motion-paint.ts`: the component stays ignorant, and every
// frame of the treatment is byte-assertable.

import { blendHex } from "./motion-paint";
import { type ColumnPainter, type ColumnWindow, paintBlockBackground } from "./paint-columns";

/** White, as a hex the blender can take. Lifting toward it is what "lit" means. */
const LIGHT = "#ffffff";
/** Black. Sinking toward it is what a shadow is. */
const DARK = "#000000";

export interface SurfaceSpec {
	/** The ground the surface sits on, `#rrggbb`. Everything is measured from it. */
	ground: string;
	/**
	 * How far the top of the surface stands off the ground, 0–1 as a fraction of
	 * the way to white. Small: 0.05 already reads as elevation at terminal scale,
	 * and 0.12 reads as a light-grey slab pasted onto a dark page.
	 */
	lift?: number;
	/**
	 * How far the BOTTOM of the surface sinks, as a fraction of the way to black.
	 * The gradient between the two is what makes the surface look lit rather than
	 * filled.
	 */
	fall?: number;
	/**
	 * The columns the surface occupies. Omitted, it is the whole row — right for a
	 * block that IS the row, wrong for a card centred in a wider area, whose
	 * leading and trailing padding belongs to the page behind it.
	 */
	columns?: ColumnWindow;
}

const DEFAULT_LIFT = 0.055;
const DEFAULT_FALL = 0.03;

/** The surface colour at a normalized height `t`, 0 at the top row, 1 at the bottom. */
export function surfaceColorAt(spec: SurfaceSpec, t: number): string {
	const top = blendHex(spec.ground, LIGHT, spec.lift ?? DEFAULT_LIFT);
	const bottom = blendHex(spec.ground, DARK, spec.fall ?? DEFAULT_FALL);
	return blendHex(top, bottom, Math.max(0, Math.min(1, t)));
}

/**
 * Fill a block's own rows with the surface gradient.
 *
 * A cell the component gave an explicit background — a selection band, a chip, a
 * swatch, a scrollbar thumb — keeps it: those are the component saying "this cell
 * is not the surface", and overpainting them is how a treatment eats the one row
 * the user is looking at. Everything else, including the columns past the end of
 * the text, becomes surface.
 *
 * `strength` scales the whole treatment, so an entrance can bring the surface in
 * with the rest of the card instead of having it snap on at full contrast on the
 * first frame.
 */
export function fillSurface(
	lines: readonly string[],
	width: number,
	spec: SurfaceSpec,
	strength = 1,
): string[] {
	if (strength <= 0 || lines.length === 0) return [...lines];
	const rows = Math.max(1, lines.length - 1);
	const clamped = Math.max(0, Math.min(1, strength));
	return paintBlockBackground(
		lines,
		width,
		row => {
			const surface = blendHex(spec.ground, surfaceColorAt(spec, row / rows), clamped);
			return ({ background }) => (background === undefined ? surface : undefined);
		},
		spec.columns,
	);
}

export interface SweepSpec {
	/** Where the highlight is, 0 just before the left edge, 1 just past the right. */
	phase: number;
	/** How far toward white the centre of the highlight lifts a cell. */
	strength?: number;
	/** Half-width of the highlight in columns. Narrow reads as light; wide reads as a wash. */
	halfWidth?: number;
	/**
	 * Columns the highlight leans right per row, so it crosses as a diagonal. A
	 * vertical band reads as a wipe, which is a transition; a diagonal reads as
	 * light moving over a plane, which is a material.
	 */
	skew?: number;
	/**
	 * The columns the highlight crosses. Omitted, it crosses the whole row; given a
	 * card's own columns, it enters at the card's left edge and leaves at its right,
	 * which is also the only way its travel time matches the card it is lighting.
	 */
	columns?: ColumnWindow;
}

const DEFAULT_SWEEP_STRENGTH = 0.2;
const DEFAULT_SWEEP_HALF_WIDTH = 7;
const DEFAULT_SWEEP_SKEW = 0.9;
/**
 * Quantization of the highlight's falloff. Sixteen steps across the band is below
 * the threshold where a ramp on a terminal cell reads as stepped, and it bounds
 * the cost: a new background sequence is written only where the step changes, so a
 * swept row carries about thirty sequences rather than one per column.
 */
const SWEEP_STEPS = 16;

/**
 * A specular highlight crossing a block, once.
 *
 * The falloff is a raised cosine, so the band has no edge — an edge is what makes
 * a highlight read as a rectangle sliding past. Cells keep whatever background
 * they had, lifted: the sweep crosses a selection band without erasing it, which
 * is exactly what light does.
 */
export function sweepSurface(
	lines: readonly string[],
	width: number,
	ground: string,
	sweep: SweepSpec,
): string[] {
	const strength = sweep.strength ?? DEFAULT_SWEEP_STRENGTH;
	if (strength <= 0 || lines.length === 0) return [...lines];
	const halfWidth = Math.max(1, sweep.halfWidth ?? DEFAULT_SWEEP_HALF_WIDTH);
	const skew = sweep.skew ?? DEFAULT_SWEEP_SKEW;
	// The centre travels from off the left edge to off the right, so the highlight
	// enters and leaves rather than appearing in place and vanishing.
	const first = sweep.columns === undefined ? 0 : sweep.columns.start;
	const last = sweep.columns === undefined ? width : Math.min(width, sweep.columns.end);
	const span = Math.max(1, last - first);
	const travel = span + halfWidth * 2;
	return paintBlockBackground(
		lines,
		width,
		row => {
			const centre = first - halfWidth + sweep.phase * travel + row * skew;
			if (centre + halfWidth < first || centre - halfWidth > last) return null;
			const painter: ColumnPainter = ({ col, background }) => {
				const distance = Math.abs(col - centre) / halfWidth;
				if (distance >= 1) return undefined;
				const raw = (Math.cos(distance * Math.PI) + 1) / 2;
				const step = Math.round(raw ** 1.4 * SWEEP_STEPS) / SWEEP_STEPS;
				if (step <= 0) return undefined;
				return blendHex(background ?? ground, LIGHT, step * strength);
			};
			return painter;
		},
		sweep.columns,
	);
}

/**
 * How much of an entrance a given row has played, when the rows arrive one after
 * another instead of all at once.
 *
 * This is the difference between an unfold and a cascade. With one strength for
 * the whole block, an animation has as many distinct frames as the block has rows.
 * With a per-row offset, every row is on its own continuous ramp, so a card of
 * fifteen rows has fifteen overlapping fades and the eye reads it as one smooth
 * motion — which is what a list on a phone is doing when it looks expensive.
 *
 * `stagger` is the fraction of the whole timeline between one row starting and the
 * next. The last row still lands exactly at progress 1: the ramp each row runs is
 * compressed to fit, rather than the animation being extended, so adding a
 * cascade does not make the card slower to arrive.
 */
export function cascadeStrength(row: number, rows: number, progress: number, stagger = 0.045): number {
	if (rows <= 1) return Math.max(0, Math.min(1, progress));
	const spread = Math.min(0.85, stagger * (rows - 1));
	const start = rows === 1 ? 0 : (row / (rows - 1)) * spread;
	const window = 1 - spread;
	if (window <= 0) return Math.max(0, Math.min(1, progress));
	return Math.max(0, Math.min(1, (progress - start) / window));
}
