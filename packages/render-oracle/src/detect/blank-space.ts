/**
 * Blank space that the frame never accounts for.
 *
 * Two defect classes share this module because both are decided the same way:
 * by comparing where paint stopped against where the frame said it would stop.
 * Neither takes a size threshold. A run of blank rows is a defect because of
 * what surrounds it, not because it grew past a number, and a constant would
 * decide the verdict for every caller instead of the frame deciding it.
 */

/** A blank run with painted rows on both sides of it. */
export interface ViewportHole {
	startRow: number;
	endRow: number;
	rowCount: number;
	paintedRowAbove: { row: number; text: string };
	paintedRowBelow: { row: number; text: string };
}

/** Chrome with painted rows below it. */
export interface StrandedChrome {
	chromeRow: number;
	viewportRows: number;
	chromeText: string;
	paintedRowBelow: { row: number; text: string };
}

function isBlank(viewport: readonly string[], row: number): boolean {
	return (viewport[row] ?? "").trim().length === 0;
}

/**
 * Every maximal run of blank rows that has painted content both above and
 * below it. Content bounds the run on both sides, so the run is inside the
 * painted region rather than the margin beneath it, and nothing in the frame
 * claims those rows.
 *
 * A caller whose component tree paints deliberate blank separator rows filters
 * the result against that tree; the run itself carries the rows it covers and
 * the painted rows that bound it, so the caller decides against its own layout
 * and this module never holds a size constant on its behalf.
 */
export function findViewportHoles(viewport: readonly string[]): ViewportHole[] {
	const holes: ViewportHole[] = [];
	let runStart = -1;

	for (let row = 0; row <= viewport.length; row++) {
		const blank = row < viewport.length && isBlank(viewport, row);
		if (blank) {
			if (runStart === -1) runStart = row;
			continue;
		}
		if (runStart === -1) continue;

		// The run ended at `row - 1`. It is a hole only when paint bounds it on
		// both sides: `row` is painted by construction here, so only the row
		// above has to be established, and a run starting at row 0 has nothing
		// above it and is the top margin rather than a hole.
		const endRow = row - 1;
		if (runStart > 0 && row < viewport.length) {
			const aboveRow = runStart - 1;
			holes.push({
				startRow: runStart,
				endRow,
				rowCount: endRow - runStart + 1,
				paintedRowAbove: { row: aboveRow, text: (viewport[aboveRow] ?? "").trim() },
				paintedRowBelow: { row, text: (viewport[row] ?? "").trim() },
			});
		}
		runStart = -1;
	}

	return holes;
}

/**
 * Chrome that is not the last painted row of the viewport. The composer owns
 * the end of the frame, so a painted row below it is transcript content the
 * renderer placed underneath its own chrome.
 *
 * `chromeMarker` identifies the chrome and the last row it matches is taken, so
 * a card border above the composer does not stand in for the composer. Blank
 * rows beneath the chrome are not a strand: a frame shorter than the viewport
 * paints from the top, and the unpainted margin below it is the terminal's,
 * not a defect.
 */
export function findStrandedChrome(viewport: readonly string[], chromeMarker: RegExp): StrandedChrome | null {
	let chromeRow = -1;
	for (let row = 0; row < viewport.length; row++) {
		if (chromeMarker.test(viewport[row] ?? "")) chromeRow = row;
	}
	if (chromeRow === -1) return null;

	for (let row = chromeRow + 1; row < viewport.length; row++) {
		if (isBlank(viewport, row)) continue;
		return {
			chromeRow,
			viewportRows: viewport.length,
			chromeText: (viewport[chromeRow] ?? "").trim(),
			paintedRowBelow: { row, text: (viewport[row] ?? "").trim() },
		};
	}

	return null;
}
