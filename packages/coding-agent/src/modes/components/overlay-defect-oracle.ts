/**
 * Overlay defect oracles.
 *
 * The composer oracles judge the rows a composer owns and declare an open overlay out of scope,
 * because a modal composites over those rows. That left the overlay path judged by nothing: a suite
 * proves an overlay that comes and goes leaves the frame as it was, and no oracle asks whether the
 * overlay itself was painted correctly while it was open.
 *
 * These oracles judge the painted modal. They read the block from the frame rather than from the
 * engine's layout formula: the rendered lines of the overlay component are the independent source,
 * the screen is the subject, and the placement rules are stated as invariants that hold whatever the
 * anchor, margin or percentage arithmetic decided. An oracle that recomputed the formula would agree
 * with a wrong formula.
 *
 * Same three-outcome contract as the composer registry: `appliesTo` decides whether a guarantee is
 * meaningful for a frame, `subject` states what the check reads, and a guarantee whose subject is
 * empty is reported blind rather than passing.
 */

import { stripVTControlCharacters } from "node:util";
import { type DefectEvaluation, evaluateOracleRegistry, type OracleProbe } from "./defect-oracle-registry";

export const OVERLAY_ORACLE_GUARANTEES = [
	"overlayRowsPaintContiguouslyInOrder",
	"everyOverlayRowReachesTheScreen",
	"overlayLeavesTheBaseFrameOutsideItsColumns",
	"overlayBlockStaysInsideTheViewport",
	"caretLandsWhereTheOverlayAsksForIt",
	"topmostOverlayWinsTheOverlap",
] as const;

export type OverlayOracleGuarantee = (typeof OVERLAY_ORACLE_GUARANTEES)[number];

/** One painted overlay, as the engine was asked to draw it. */
export interface OverlaySnapshot {
	/** Stack position, lowest first, matching the order the compositor paints them in. */
	stackIndex: number;
	/** Name to report this overlay under. */
	name: string;
	/** The lines the overlay component rendered, ANSI stripped, before any clipping. */
	renderedLines: readonly string[];
	/** Column width the component was rendered at. */
	renderWidth: number;
	/** True when the overlay is one the engine paints; a hidden entry is not a subject. */
	visible: boolean;
	/** True when the overlay can still take input, which an exiting card cannot. */
	interactive: boolean;
	/**
	 * Where the overlay asked for the caret, in its own coordinates, or null when it asked for none.
	 *
	 * A focusable modal emits `CURSOR_MARKER` in the line the caret belongs on, and the engine reads
	 * the marker out of the composited window and moves the hardware caret there. An overlay that
	 * emits no marker makes no claim about the caret, which is why this is nullable rather than a
	 * default of the top-left cell.
	 */
	caretRequest: { line: number; col: number } | null;
}

export interface OverlayOracleFrameState {
	width: number;
	height: number;
	/** The screen as it stands with the overlays composited, ANSI stripped. */
	viewportLines: readonly string[];
	/**
	 * The screen as it stood before any overlay was shown, ANSI stripped.
	 *
	 * The base is what the overlay is not allowed to disturb outside its own columns. Captured from
	 * the same settled frame rather than reconstructed, because a reconstruction would have to model
	 * the compositor to say what it should have left alone.
	 */
	baseViewportLines: readonly string[];
	cursor: { row: number; col: number } | null;
	overlays: readonly OverlaySnapshot[];
}

export interface OverlayOracleFailure {
	oracle: OverlayOracleGuarantee;
	message: string;
	details?: Record<string, unknown>;
}

/** A painted overlay's block on screen, located from its own rendered content. */
export interface OverlayBlock {
	overlay: OverlaySnapshot;
	/** Screen row the block's first rendered line belongs on, or null when nothing was found. */
	top: number | null;
	/** Column the first found line starts at, or null when nothing was found. */
	col: number | null;
	/** For each rendered line, the screen row it was found on, or null when it is not on screen. */
	rowOf: readonly (number | null)[];
	/** For each rendered line, the column it was found at, or null when it is not on screen. */
	colOf: readonly (number | null)[];
}

/** The lines of an overlay worth looking for: a blank line matches anything, so it is no evidence. */
function locatableLines(overlay: OverlaySnapshot): readonly { index: number; text: string }[] {
	const lines: { index: number; text: string }[] = [];
	for (let i = 0; i < overlay.renderedLines.length; i++) {
		const text = stripVTControlCharacters(overlay.renderedLines[i] ?? "").trimEnd();
		if (text.trim().length === 0) continue;
		lines.push({ index: i, text });
	}
	return lines;
}

/**
 * Locate an overlay's painted block by matching its own rendered lines against the screen.
 *
 * Each locatable line is searched for across the whole viewport, and the row and column it was found
 * at are recorded as they are, not as the block's origin predicts. That is what makes a row painted
 * two rows down, or one column across, an observable disagreement rather than a line that simply
 * could not be found: a locator that only looked where the origin says would report every misplaced
 * row as missing, and the guarantee about ordering would have nothing left to fail on.
 */
export function locateOverlayBlock(state: OverlayOracleFrameState, overlay: OverlaySnapshot): OverlayBlock {
	const candidates = locatableLines(overlay);
	const rowOf: (number | null)[] = overlay.renderedLines.map(() => null);
	const colOf: (number | null)[] = overlay.renderedLines.map(() => null);
	if (candidates.length === 0) return { overlay, top: null, col: null, rowOf, colOf };

	// Each line is searched from the row after the previous match, so a card whose lines repeat does
	// not collapse onto one row: `indexOf` alone hands back the first occurrence for every copy, which
	// reads as a block that painted its whole body on a single row.
	let searchFrom = 0;
	for (const candidate of candidates) {
		for (let r = searchFrom; r < state.viewportLines.length; r++) {
			const at = (state.viewportLines[r] ?? "").indexOf(candidate.text);
			if (at < 0) continue;
			rowOf[candidate.index] = r;
			colOf[candidate.index] = at;
			searchFrom = r + 1;
			break;
		}
	}

	const firstFound = candidates.find(candidate => rowOf[candidate.index] !== null);
	if (!firstFound) return { overlay, top: null, col: null, rowOf, colOf };
	const originRow = rowOf[firstFound.index]!;
	return { overlay, top: originRow - firstFound.index, col: colOf[firstFound.index]!, rowOf, colOf };
}

/** Every visible overlay's block, in stack order. */
export function overlayBlocks(state: OverlayOracleFrameState): readonly OverlayBlock[] {
	return state.overlays.filter(o => o.visible).map(o => locateOverlayBlock(state, o));
}

function paintedRows(block: OverlayBlock): readonly number[] {
	return block.rowOf.filter((row): row is number => row !== null);
}

/**
 * Guarantee 1: overlayRowsPaintContiguouslyInOrder
 *
 * The painted lines of one overlay occupy consecutive screen rows in the order the component
 * rendered them, all starting at the same column. A modal whose rows arrive out of order, doubled, or
 * stepped one column across is the shape a compositing bug takes.
 */
export function checkOverlayRowsPaintContiguouslyInOrder(state: OverlayOracleFrameState): OverlayOracleFailure | null {
	for (const block of overlayBlocks(state)) {
		if (block.top === null || block.col === null) continue;
		let previous: { index: number; row: number } | null = null;
		for (let index = 0; index < block.rowOf.length; index++) {
			const row = block.rowOf[index];
			if (row === null || row === undefined) continue;
			if (previous && row - previous.row !== index - previous.index) {
				return {
					oracle: "overlayRowsPaintContiguouslyInOrder",
					message: `Overlay '${block.overlay.name}' painted rendered line ${index} at screen row ${row}, but line ${previous.index} at screen row ${previous.row} puts it at ${previous.row + (index - previous.index)}.`,
					details: { overlay: block.overlay.name, index, row, previous },
				};
			}
			const col = block.colOf[index];
			if (col !== null && col !== undefined && col !== block.col) {
				return {
					oracle: "overlayRowsPaintContiguouslyInOrder",
					message: `Overlay '${block.overlay.name}' painted rendered line ${index} starting at column ${col}, and its other lines start at ${block.col}.`,
					details: { overlay: block.overlay.name, index, col, blockCol: block.col },
				};
			}
			previous = { index, row };
		}
	}
	return null;
}

/**
 * Guarantee 2: everyOverlayRowReachesTheScreen
 *
 * A rendered line is missing only because the block ran off an edge of the viewport, and then only
 * from the end that ran off. The compositor drops a row whose screen index is out of range without a
 * word, so a modal placed partly off screen loses content silently: this is the check that makes the
 * loss loud, and a missing middle row is never explainable.
 */
export function checkEveryOverlayRowReachesTheScreen(state: OverlayOracleFrameState): OverlayOracleFailure | null {
	const blocks = overlayBlocks(state);
	for (let position = 0; position < blocks.length; position++) {
		const block = blocks[position]!;
		// A row a higher card is painted over is gone for a reason, and the stack-order guarantee is
		// the one that judges that overlap. Rows covered from above are therefore not this check's
		// business, and the covering block is located from its own content like every other.
		const covered = new Set<number>();
		for (let above = position + 1; above < blocks.length; above++) {
			for (const row of paintedRows(blocks[above]!)) covered.add(row);
		}
		const candidates = locatableLines(block.overlay);
		if (block.top === null) {
			if (candidates.length === 0) continue;
			// A visible overlay that reached the screen nowhere is the loudest form of this defect, and
			// the one every other guarantee is blind to: with no block to locate, they have nothing to
			// read and report nothing. Skipping it here is how a modal that never painted would pass.
			return {
				oracle: "everyOverlayRowReachesTheScreen",
				message: `Overlay '${block.overlay.name}' is visible and none of its ${candidates.length} rendered line(s) is on screen: '${candidates[0]!.text}'.`,
				details: { overlay: block.overlay.name, lines: candidates.length },
			};
		}
		for (const candidate of candidates) {
			if (block.rowOf[candidate.index] !== null) continue;
			const row = block.top + candidate.index;
			const clipped = row < 0 || row >= state.height;
			if (!clipped && !covered.has(row)) {
				return {
					oracle: "everyOverlayRowReachesTheScreen",
					message: `Overlay '${block.overlay.name}' rendered line ${candidate.index} is missing from screen row ${row}, which is inside the viewport: '${candidate.text}'.`,
					details: { overlay: block.overlay.name, index: candidate.index, row, text: candidate.text },
				};
			}
		}
	}
	return null;
}

/**
 * Guarantee 3: overlayLeavesTheBaseFrameOutsideItsColumns
 *
 * Outside the overlay's own columns the row is the base frame's row. The compositor rebuilds a line
 * from three pieces and pads each of them, so a width miscount there wipes or shifts the part of the
 * screen the modal never claimed.
 */
export function checkOverlayLeavesTheBaseFrameOutsideItsColumns(
	state: OverlayOracleFrameState,
): OverlayOracleFailure | null {
	const blocks = overlayBlocks(state);
	if (blocks.length === 0) return null;
	// The span is the union of the rectangles the cards CLAIM, not of the rows they were located on. A
	// card whose row is covered by a higher one is located nowhere on that row and still owns those
	// columns, so a union built from located rows leaves part of the lower card outside the span and
	// then reads its own text as base damage.
	const touched = new Map<number, { from: number; to: number }>();
	for (const block of blocks) {
		if (block.top === null || block.col === null) continue;
		const right = block.col + block.overlay.renderWidth;
		for (let index = 0; index < block.overlay.renderedLines.length; index++) {
			const row = block.top + index;
			if (row < 0 || row >= state.height) continue;
			const previous = touched.get(row);
			touched.set(
				row,
				previous
					? { from: Math.min(previous.from, block.col), to: Math.max(previous.to, right) }
					: { from: block.col, to: right },
			);
		}
	}

	for (const [row, span] of touched) {
		const painted = state.viewportLines[row] ?? "";
		const base = state.baseViewportLines[row] ?? "";
		const paintedLeft = painted.slice(0, span.from);
		const baseLeft = base.slice(0, span.from);
		if (paintedLeft.trimEnd() !== baseLeft.trimEnd()) {
			return {
				oracle: "overlayLeavesTheBaseFrameOutsideItsColumns",
				message: `Row ${row} left of the overlay reads '${paintedLeft}', but the base frame has '${baseLeft}'.`,
				details: { row, span, painted, base },
			};
		}
		const paintedRight = painted.slice(span.to).trimEnd();
		const baseRight = base.slice(span.to).trimEnd();
		if (paintedRight !== baseRight) {
			return {
				oracle: "overlayLeavesTheBaseFrameOutsideItsColumns",
				message: `Row ${row} right of the overlay reads '${paintedRight}', but the base frame has '${baseRight}'.`,
				details: { row, span, painted, base },
			};
		}
	}
	return null;
}

/**
 * Guarantee 4: overlayBlockStaysInsideTheViewport
 *
 * Every painted row of the block is on the screen and no painted line runs past the right edge. The
 * placement arithmetic clamps to the terminal, so a block hanging off an edge means the clamp did not
 * hold for the size the component actually rendered at.
 */
export function checkOverlayBlockStaysInsideTheViewport(state: OverlayOracleFrameState): OverlayOracleFailure | null {
	for (const block of overlayBlocks(state)) {
		for (const row of paintedRows(block)) {
			if (row < 0 || row >= state.height) {
				return {
					oracle: "overlayBlockStaysInsideTheViewport",
					message: `Overlay '${block.overlay.name}' painted a row at ${row}, outside the viewport height ${state.height}.`,
					details: { overlay: block.overlay.name, row, height: state.height },
				};
			}
			const line = state.viewportLines[row] ?? "";
			if (line.length > state.width) {
				return {
					oracle: "overlayBlockStaysInsideTheViewport",
					message: `Overlay '${block.overlay.name}' left row ${row} ${line.length} columns wide, past the terminal width ${state.width}.`,
					details: { overlay: block.overlay.name, row, length: line.length, width: state.width },
				};
			}
		}
		if (block.col !== null && block.col < 0) {
			return {
				oracle: "overlayBlockStaysInsideTheViewport",
				message: `Overlay '${block.overlay.name}' starts at column ${block.col}.`,
				details: { overlay: block.overlay.name, col: block.col },
			};
		}
	}
	return null;
}

/**
 * Guarantee 5: caretLandsWhereTheOverlayAsksForIt
 *
 * An overlay that emits a cursor marker gets the hardware caret at the cell the marker sits in. The
 * engine reads the marker out of the composited window, so the caret has to follow the marker's own
 * line wherever the compositor put it; a caret left in the composer under a modal types into a
 * component nobody can see, and a caret one line off is an IME candidate window in the wrong place.
 *
 * An overlay that asks for no caret makes no claim here, which is why the guarantee applies only when
 * one of them asked.
 */
export function checkCaretLandsWhereTheOverlayAsksForIt(state: OverlayOracleFrameState): OverlayOracleFailure | null {
	for (const block of overlayBlocks(state)) {
		const request = block.overlay.caretRequest;
		if (!request || !block.overlay.interactive) continue;
		const row = block.rowOf[request.line];
		const col = block.colOf[request.line];
		if (row === null || row === undefined || col === null || col === undefined) continue;
		const expected = { row, col: col + request.col };
		if (!state.cursor) {
			return {
				oracle: "caretLandsWhereTheOverlayAsksForIt",
				message: `Overlay '${block.overlay.name}' asked for the caret at row ${expected.row} column ${expected.col} and there is no caret.`,
				details: { overlay: block.overlay.name, expected },
			};
		}
		if (state.cursor.row !== expected.row || state.cursor.col !== expected.col) {
			return {
				oracle: "caretLandsWhereTheOverlayAsksForIt",
				message: `Overlay '${block.overlay.name}' asked for the caret at row ${expected.row} column ${expected.col}, and it is at row ${state.cursor.row} column ${state.cursor.col}.`,
				details: { overlay: block.overlay.name, expected, cursor: state.cursor },
			};
		}
	}
	return null;
}

/**
 * Guarantee 6: topmostOverlayWinsTheOverlap
 *
 * Where two painted overlays claim the same cells, those cells show the one later in the stack. The
 * compositor walks the stack in order so the last write wins, and a reversal hides the modal the
 * operator is talking to behind one they have already dismissed.
 *
 * The comparison is per cell against both cards' own text, because the loser of an overlap is
 * mangled: asking whether the lower card's whole line is still findable answers nothing once half of
 * it has been overwritten.
 */
export function checkTopmostOverlayWinsTheOverlap(state: OverlayOracleFrameState): OverlayOracleFailure | null {
	const blocks = overlayBlocks(state).filter(block => block.top !== null && block.col !== null);
	for (let lower = 0; lower < blocks.length; lower++) {
		for (let upper = lower + 1; upper < blocks.length; upper++) {
			const under = blocks[lower]!;
			const over = blocks[upper]!;
			for (let overIndex = 0; overIndex < over.overlay.renderedLines.length; overIndex++) {
				const row = (over.top ?? 0) + overIndex;
				const underIndex = row - (under.top ?? 0);
				if (underIndex < 0 || underIndex >= under.overlay.renderedLines.length) continue;
				const overText = stripVTControlCharacters(over.overlay.renderedLines[overIndex] ?? "");
				const underText = stripVTControlCharacters(under.overlay.renderedLines[underIndex] ?? "");
				const overLeft = over.col ?? 0;
				const underLeft = under.col ?? 0;
				const from = Math.max(overLeft, underLeft);
				const to = Math.min(overLeft + overText.length, underLeft + underText.length);
				if (to <= from) continue;
				const painted = (state.viewportLines[row] ?? "").slice(from, to);
				const expectedOver = overText.slice(from - overLeft, to - overLeft);
				const expectedUnder = underText.slice(from - underLeft, to - underLeft);
				if (painted === expectedOver || expectedOver === expectedUnder) continue;
				if (painted === expectedUnder) {
					return {
						oracle: "topmostOverlayWinsTheOverlap",
						message: `Row ${row} columns [${from}..${to}) show '${painted}' from overlay '${under.overlay.name}', which '${over.overlay.name}' above it also occupies.`,
						details: { row, from, to, under: under.overlay.name, over: over.overlay.name },
					};
				}
			}
		}
	}
	return null;
}

/** One guarantee: when it applies, what it reads, and how it judges. */
export interface OverlayOracle {
	id: OverlayOracleGuarantee;
	/** Whether the guarantee says anything about this frame. */
	appliesTo: (state: OverlayOracleFrameState) => boolean;
	/** What the check will read. An empty subject means the check judges nothing. */
	subject: (state: OverlayOracleFrameState) => number;
	check: (state: OverlayOracleFrameState) => OverlayOracleFailure | null;
}

function visibleOverlays(state: OverlayOracleFrameState): readonly OverlaySnapshot[] {
	return state.overlays.filter(overlay => overlay.visible);
}

/** Painted rows across every located block: the subject most of these checks read. */
function locatedRowCount(state: OverlayOracleFrameState): number {
	return overlayBlocks(state).reduce((total, block) => total + paintedRows(block).length, 0);
}

/**
 * Every overlay guarantee, keyed by its id.
 *
 * A `Record` over the union, for the same reason the composer registry is one: an id without an entry
 * and an entry without an id are both compile errors, so a guarantee cannot be declared and left
 * unwired.
 */
export const OVERLAY_ORACLES: Readonly<Record<OverlayOracleGuarantee, OverlayOracle>> = {
	overlayRowsPaintContiguouslyInOrder: {
		id: "overlayRowsPaintContiguouslyInOrder",
		appliesTo: state => visibleOverlays(state).length > 0,
		subject: locatedRowCount,
		check: checkOverlayRowsPaintContiguouslyInOrder,
	},
	everyOverlayRowReachesTheScreen: {
		id: "everyOverlayRowReachesTheScreen",
		appliesTo: state => visibleOverlays(state).length > 0,
		// The subject is every line the overlay meant to paint, whether it arrived or not: a block that
		// reached the screen nowhere is exactly the state this guarantee exists for.
		subject: state => visibleOverlays(state).reduce((total, overlay) => total + locatableLines(overlay).length, 0),
		check: checkEveryOverlayRowReachesTheScreen,
	},
	overlayLeavesTheBaseFrameOutsideItsColumns: {
		id: "overlayLeavesTheBaseFrameOutsideItsColumns",
		appliesTo: state => visibleOverlays(state).length > 0 && state.baseViewportLines.length > 0,
		subject: locatedRowCount,
		check: checkOverlayLeavesTheBaseFrameOutsideItsColumns,
	},
	overlayBlockStaysInsideTheViewport: {
		id: "overlayBlockStaysInsideTheViewport",
		appliesTo: state => visibleOverlays(state).length > 0,
		subject: locatedRowCount,
		check: checkOverlayBlockStaysInsideTheViewport,
	},
	caretLandsWhereTheOverlayAsksForIt: {
		id: "caretLandsWhereTheOverlayAsksForIt",
		appliesTo: state => visibleOverlays(state).some(overlay => overlay.interactive && overlay.caretRequest !== null),
		// The subject is the located lines a caret was asked for on: a request whose line reached the
		// screen nowhere leaves nothing to compare the caret against.
		subject: state =>
			overlayBlocks(state).filter(block => {
				const request = block.overlay.caretRequest;
				return request !== null && block.overlay.interactive && block.rowOf[request.line] !== null;
			}).length,
		check: checkCaretLandsWhereTheOverlayAsksForIt,
	},
	topmostOverlayWinsTheOverlap: {
		id: "topmostOverlayWinsTheOverlap",
		appliesTo: state => visibleOverlays(state).length > 1,
		subject: state => overlayBlocks(state).filter(block => block.top !== null).length,
		check: checkTopmostOverlayWinsTheOverlap,
	},
};

export type OverlayEvaluationResult = DefectEvaluation<OverlayOracleGuarantee, OverlayOracleFailure>;

/**
 * How the registry reads one of its guarantees, for `evaluateOracleRegistry`.
 *
 * One object for the module rather than one per evaluation, so a sweep over thousands of frames
 * allocates nothing per frame beyond the verdict it returns.
 */
const PROBE: OracleProbe<OverlayOracleGuarantee, OverlayOracleFrameState, OverlayOracleFailure> = {
	appliesTo: (id, state) => OVERLAY_ORACLES[id].appliesTo(state),
	subjectSize: (id, state) => OVERLAY_ORACLES[id].subject(state),
	check: (id, state) => OVERLAY_ORACLES[id].check(state),
};

/** Run every overlay guarantee over one frame and sort each into skipped, blind or inspected. */
export function evaluateAllOverlayOracles(state: OverlayOracleFrameState): OverlayEvaluationResult {
	return evaluateOracleRegistry(OVERLAY_ORACLE_GUARANTEES, state, PROBE);
}
