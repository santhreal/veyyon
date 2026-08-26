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

import { clamp01 } from "@veyyon/utils/math";
import { blendHex } from "./motion-paint";
import { type ColumnWindow, paintBlockBackground } from "./paint-columns";
import { parseHexColor } from "./paint-ground";

/** White, as a hex the blender can take. Lifting toward it is what "lit" means. */
const LIGHT = "#ffffff";
/** Black. On a light terminal this is the direction a surface has to move to be seen. */
const DARK = "#000000";

/**
 * The direction "off the page" points on this ground.
 *
 * A surface is only a surface if it differs from what is behind it, and on a
 * white terminal a lift toward white differs from nothing. BT.601 luminance,
 * the same weighting the terminal uses to decide light or dark (terminal.ts
 * `#handleOsc11Response`), so a card cannot disagree with the theme about which
 * kind of terminal it is on.
 */
function liftTarget(ground: string): string {
	const rgb = parseHexColor(ground);
	if (rgb === null) return LIGHT;
	return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 < 0.5 ? LIGHT : DARK;
}

/** A colour `amount` of the way off `ground`, in whichever direction is visible on it. */
export function liftHex(ground: string, amount: number): string {
	return blendHex(ground, liftTarget(ground), clamp01(amount));
}

/**
 * A run of rows that is a DIFFERENT material from the surface around it.
 *
 * A card is not one plate. A header tray at the top and a footer tray at the
 * foot, each flat and each at its own elevation, is what makes the body between
 * them read as the thing in front: three plates give the eye an edge to catch,
 * where one wash gives it nothing and reads as the page with a border on it. Row
 * indices are relative to the block, `end` exclusive.
 */
export interface SurfaceBand {
	start: number;
	end: number;
	/** Flat elevation across the band, in the same units as {@link SurfaceSpec.lift}. */
	lift: number;
}

export interface SurfaceSpec {
	/** The ground the surface sits on, `#rrggbb`. Everything is measured from it. */
	ground: string;
	/**
	 * How far the top row of the surface stands off the ground, 0–1 of the way to
	 * the visible direction (white on a dark terminal, black on a light one).
	 *
	 * The old default was 0.055, and a real terminal measured that as twelve of
	 * 255 at the top row and four at the bottom, on a page of 28 — an elevation
	 * the eye cannot find, which is most of what "the card looks the same" was.
	 * A tenth reads as a plate at terminal scale; a fifth reads as a light-grey
	 * slab pasted onto the page.
	 */
	lift?: number;
	/**
	 * Elevation at the BOTTOM row. Lower than {@link lift} — a surface lit from
	 * above is brighter at its top edge — but still off the ground: a card whose
	 * foot sinks BELOW the page (which is what a fall toward black gave it) is a
	 * card that fades into the page over its lower half.
	 */
	bottomLift?: number;
	/** Rows at their own flat elevation. Later bands win where they overlap. */
	bands?: readonly SurfaceBand[];
	/**
	 * The columns the surface occupies. Omitted, it is the whole row — right for a
	 * block that IS the row, wrong for a card centred in a wider area, whose
	 * leading and trailing padding belongs to the page behind it.
	 */
	columns?: ColumnWindow;
}

const DEFAULT_LIFT = 0.1;
const DEFAULT_BOTTOM_LIFT = 0.055;

/** The surface colour at a normalized height `t`, 0 at the top row, 1 at the bottom. */
export function surfaceColorAt(spec: SurfaceSpec, t: number): string {
	const top = spec.lift ?? DEFAULT_LIFT;
	const bottom = spec.bottomLift ?? DEFAULT_BOTTOM_LIFT;
	const k = clamp01(t);
	return liftHex(spec.ground, top + (bottom - top) * k);
}

/** The surface colour of one row, bands included. */
export function surfaceRowColor(spec: SurfaceSpec, row: number, rows: number): string {
	for (let i = (spec.bands?.length ?? 0) - 1; i >= 0; i--) {
		const band = spec.bands![i]!;
		if (row >= band.start && row < band.end) return liftHex(spec.ground, band.lift);
	}
	return surfaceColorAt(spec, rows <= 0 ? 0 : row / rows);
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
export function fillSurface(lines: readonly string[], width: number, spec: SurfaceSpec, strength = 1): string[] {
	if (strength <= 0 || lines.length === 0) return lines as string[];
	const rows = Math.max(1, lines.length - 1);
	const clamped = clamp01(strength);
	return paintBlockBackground(
		lines,
		width,
		row => {
			const surface = blendHex(spec.ground, surfaceRowColor(spec, row, rows), clamped);
			return ({ background }) => (background === undefined ? surface : undefined);
		},
		spec.columns,
	);
}
