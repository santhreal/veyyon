/**
 * Composer zone defect oracle.
 *
 * Evaluates rendered terminal frames and TUI state against formal invariant guarantees
 * of the composer zone rather than comparisons against golden snapshots.
 *
 * Derived directly from renderer semantics (packages/tui/src/tui.ts and
 * packages/coding-agent/src/modes/components/composer-chrome.ts).
 */

import { sgrSequence } from "@veyyon/tui/ansi";
import { visibleWidth } from "@veyyon/tui/utils";
import { COMPOSER_INSET_COLS } from "./composer-chrome";

export const COMPOSER_ORACLE_GUARANTEES = [
	"exactlyOneComposerPrompt",
	"noOutputBleedPastComposer",
	"noMixedTranscriptAndChromeRows",
	"footerOccupiesBottomPhysicalRows",
	"noFooterRowsAboveFooterRegion",
	"mouseClickRoutesToRenderedZone",
	"caretWithinComposerEditorBounds",
	"noHorizontalOverflow",
	"composerCardPadsAreUnpaintedAir",
	"composerHairlineSpanAndPlacement",
	"footerHeightMatchesComposedSegmentLedger",
	"virtualScrollPreservesFooterStability",
	"noStyleBleedPastPaintedText",
] as const;

export type ComposerOracleGuarantee = (typeof COMPOSER_ORACLE_GUARANTEES)[number];

export interface FrameSegmentSnapshot {
	startIndex: number;
	rowCount: number;
	componentName: string;
}

/** The columns of one screen row whose cells carry a non-default style. */
export interface RowStyledColumns {
	background: readonly number[];
	foreground: readonly number[];
	underline: readonly number[];
}

export interface ComposerOracleFrameState {
	/** Viewport width in columns */
	width: number;
	/** Viewport height in rows */
	height: number;
	/** Visible lines on the terminal screen (ANSI stripped) */
	viewportLines: readonly string[];
	/**
	 * Visible lines as the emulator's cell grid spells them.
	 *
	 * Named for the byte stream it once held. The Ghostty-backed test terminal reconstructs a row from
	 * its cells, which carry style as attributes rather than as escape sequences, so these rows are
	 * the same text as `viewportLines` under that harness. A caller that does have the byte stream
	 * still supplies it here, and the checks that read escape sequences still read them.
	 */
	rawViewportLines: readonly string[];
	/**
	 * Per screen row, the columns whose cell carries a non-default style.
	 *
	 * Read from the emulator's cell grid, which is where style survives: an escape sequence is consumed
	 * into cell attributes, so a check looking for one in a row's text finds nothing and passes. That
	 * is how the padding oracle's background clause came to judge a property no mount could express.
	 */
	styledColumns: readonly RowStyledColumns[];
	/** Terminal cursor position (0-based screen coordinates) */
	cursor: { row: number; col: number } | null;
	/** Total composed frame length across all root components */
	totalFrameRows: number;
	/** Window top row in composed frame */
	windowTopRow: number;
	/** Number of root children pinned as footer */
	pinnedFooterChildCount: number;
	/** Number of rows occupied by pinned footer */
	pinnedFooterRows: number;
	/** Virtual scroll top if scrolled back, null if live tail */
	virtualScrollTop: number | null;
	/** Screen row bounds computed for footer hit-testing */
	screenBounds: {
		footerTop: number;
		footerBottom: number;
		footerRowOffset: number;
		contentBottom: number;
	};
	/** Segment ledger from the compose pass */
	segments: readonly FrameSegmentSnapshot[];
	/** Mouse click dispatch recorder for each screen row */
	mouseRouting?: ReadonlyMap<number, { routedTo: string | null; localLine: number | null; col: number | null }>;
	/** Known transcript line prefixes / patterns for bleed detection */
	transcriptLineMarkers?: readonly string[];
	/** Active prompt glyph expected (e.g. "›", "!", "$", "◈") */
	expectedPromptGlyph?: string;
	/** Whether the editor is currently focused */
	editorFocused?: boolean;
	/** Live footer rendered lines (for virtual scroll parity check) */
	liveFooterLines?: readonly string[];
}

export interface OracleFailure {
	oracle: ComposerOracleGuarantee;
	message: string;
	details?: Record<string, unknown>;
}

/**
 * The verdict of one sweep over every oracle.
 *
 * `passed` collapses to whether anything failed. The three arrays separate outcomes a single boolean
 * hides: an oracle out of scope for the state, an oracle in scope whose subject was empty so it read
 * nothing, and an oracle that actually looked at something. Their union is always every guarantee.
 */
export interface OracleEvaluationResult {
	passed: boolean;
	failures: OracleFailure[];
	/** Oracles whose `appliesTo` rejected the state. */
	skipped: ComposerOracleGuarantee[];
	/** Oracles that read a non-empty subject and reached a verdict. */
	inspected: ComposerOracleGuarantee[];
	/** Oracles that applied but had nothing to read. A silent pass, and where two defects hid. */
	blind: ComposerOracleGuarantee[];
}

const PROMPT_GLYPHS = ["›", "!", "$", "◈", ">"] as const;

const SGR = sgrSequence("g");

/**
 * Whether a raw terminal line paints a background anywhere in it.
 *
 * Walks the SGR parameter list instead of pattern-matching its text. The `4`-prefixed spelling
 * this replaced read `ESC [ 4 m` (underline) and `ESC [ 49 m` (background reset) as fills, missed
 * the bright backgrounds 100-107, and missed a truecolor background written with colon
 * subparameters, because a background is a parameter value rather than a text shape.
 */
function paintsBackground(rawLine: string): boolean {
	SGR.lastIndex = 0;
	for (let match = SGR.exec(rawLine); match !== null; match = SGR.exec(rawLine)) {
		const params = match[1] ?? "";
		const parts = params.length > 0 ? params.split(";") : [];
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index] ?? "";
			const code = Number(part.split(":")[0]);
			if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return true;
			// Skip an extended foreground or underline colour so its subparameters are not
			// misread as background codes: `38;5;41` selects a foreground, not background 41.
			if (code === 38 || code === 58) {
				if (part.includes(":")) continue;
				const selector = Number(parts[index + 1]);
				if (selector === 2) index += 4;
				else if (selector === 5) index += 2;
				else index += 1;
			}
		}
	}
	return false;
}

/** Check if a line is a composer prompt row */
export function isComposerPromptLine(plainLine: string, expectedGlyph?: string): boolean {
	const trimmedLeading = plainLine.trimStart();
	if (trimmedLeading.length === 0) return false;
	const leadingSpaces = plainLine.length - trimmedLeading.length;

	// Inset must be at least COMPOSER_INSET_COLS (2) or start with glyph
	if (leadingSpaces < COMPOSER_INSET_COLS && !PROMPT_GLYPHS.some(g => trimmedLeading.startsWith(g))) {
		return false;
	}

	if (expectedGlyph && trimmedLeading.startsWith(expectedGlyph)) {
		return true;
	}

	return PROMPT_GLYPHS.some(g => trimmedLeading.startsWith(g));
}

/** Check if a line is a hairline row (consisting of box drawing horizontal line chars) */
export function isHairlineLine(plainLine: string): boolean {
	const trimmed = plainLine.trim();
	if (trimmed.length < 3) return false;
	const barChars = ["─", "━", "-"];
	let barCount = 0;
	for (const char of trimmed) {
		if (barChars.includes(char)) barCount++;
	}
	return barCount >= trimmed.length * 0.7;
}

// ---------------------------------------------------------------------------
// Individual Oracle Predicates
// ---------------------------------------------------------------------------

/**
 * Guarantee 1: exactlyOneComposerPrompt
 * Exactly one composer prompt row exists in the active terminal viewport frame when the
 * composer prompt's frame row is within the rendered screen window, and zero when scrolled off.
 */
export function checkExactlyOneComposerPrompt(state: ComposerOracleFrameState): OracleFailure | null {
	const promptRows: number[] = [];
	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		if (isComposerPromptLine(line, state.expectedPromptGlyph)) {
			promptRows.push(r);
		}
	}

	const editorSegment = state.segments.find(s => s.componentName === "Editor");
	let expectedPromptInView = state.pinnedFooterRows > 0;

	if (state.virtualScrollTop !== null) {
		const footerRows = Math.min(state.pinnedFooterRows, state.height - 1);
		if (state.liveFooterLines) {
			const promptIndexInFooter = state.liveFooterLines.findIndex(l =>
				isComposerPromptLine(l, state.expectedPromptGlyph),
			);
			expectedPromptInView =
				promptIndexInFooter >= 0 && promptIndexInFooter >= state.liveFooterLines.length - footerRows;
		}
	} else if (editorSegment) {
		const promptFrameRow = editorSegment.startIndex;
		const isPromptVisible =
			promptFrameRow >= state.windowTopRow && promptFrameRow < state.windowTopRow + state.height;
		expectedPromptInView = isPromptVisible;
	}

	const expectedCount = expectedPromptInView ? 1 : 0;

	if (promptRows.length !== expectedCount) {
		return {
			oracle: "exactlyOneComposerPrompt",
			message: `Expected ${expectedCount} composer prompt row(s) in viewport (expectedPromptInView=${expectedPromptInView}), found ${promptRows.length} at rows: [${promptRows.join(", ")}].`,
			details: { promptRows, expectedCount, expectedPromptInView, viewportLines: state.viewportLines },
		};
	}
	return null;
}
/**
 * Guarantee 2: noOutputBleedPastComposer
 * Rendered transcript output rows must never bleed past the composer boundary into the footer zone,
 * and footer rows must never appear above the footer boundary in the transcript zone.
 */
export function checkNoOutputBleedPastComposer(state: ComposerOracleFrameState): OracleFailure | null {
	const { footerTop, footerBottom, contentBottom } = state.screenBounds;
	const markers = state.transcriptLineMarkers ?? [];

	if (state.pinnedFooterRows <= 0) return null;

	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		const hasTranscriptMarker = markers.some(m => line.includes(m));

		if (hasTranscriptMarker) {
			// Transcript content must be strictly above footerTop (or in transcript region)
			if (r >= footerTop && r <= footerBottom) {
				return {
					oracle: "noOutputBleedPastComposer",
					message: `Transcript output row '${line}' found at row ${r}, which is inside the composer footer zone (footerTop=${footerTop}, footerBottom=${footerBottom}).`,
					details: { row: r, line, footerTop, footerBottom },
				};
			}
			if (r > contentBottom) {
				return {
					oracle: "noOutputBleedPastComposer",
					message: `Transcript output row '${line}' found at row ${r} beyond contentBottom ${contentBottom}.`,
					details: { row: r, line, contentBottom },
				};
			}
		}
	}

	return null;
}

/**
 * Guarantee 3: noMixedTranscriptAndChromeRows
 * No single row in the rendered frame may contain both transcript/output text and composer chrome tokens.
 */
export function checkNoMixedTranscriptAndChromeRows(state: ComposerOracleFrameState): OracleFailure | null {
	const markers = state.transcriptLineMarkers ?? [];
	if (markers.length === 0) return null;

	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		const hasTranscript = markers.some(m => line.includes(m));
		if (!hasTranscript) continue;

		const hasPrompt = isComposerPromptLine(line, state.expectedPromptGlyph);
		const hasHairline = isHairlineLine(line);

		if (hasPrompt || hasHairline) {
			return {
				oracle: "noMixedTranscriptAndChromeRows",
				message: `Row ${r} mixes transcript content with composer chrome: '${line}'.`,
				details: { row: r, line, hasPrompt, hasHairline },
			};
		}
	}

	return null;
}

/**
 * Guarantee 4: footerOccupiesBottomPhysicalRows
 * The pinned footer occupies exactly the bottom n physical rows of the viewport in live tail mode
 * when the frame fills or exceeds the viewport.
 */
export function checkFooterOccupiesBottomPhysicalRows(state: ComposerOracleFrameState): OracleFailure | null {
	if (state.pinnedFooterRows <= 0) return null;

	const { footerTop, footerBottom, contentBottom } = state.screenBounds;
	const isFullFrame = state.totalFrameRows >= state.height;

	if (isFullFrame && state.virtualScrollTop === null) {
		const expectedFooterBottom = state.height - 1;
		if (footerBottom !== expectedFooterBottom) {
			return {
				oracle: "footerOccupiesBottomPhysicalRows",
				message: `Pinned footer bottom (${footerBottom}) does not reach terminal bottom (${expectedFooterBottom}) in a full frame.`,
				details: { footerBottom, expectedFooterBottom, height: state.height },
			};
		}

		const expectedVisibleFooterTop = Math.max(0, state.height - state.pinnedFooterRows);
		const visibleFooterTop = Math.max(0, footerTop);
		if (visibleFooterTop !== expectedVisibleFooterTop) {
			return {
				oracle: "footerOccupiesBottomPhysicalRows",
				message: `Pinned footer top (${visibleFooterTop}) does not match expected top (${expectedVisibleFooterTop}) for ${state.pinnedFooterRows} footer rows in viewport of height ${state.height}.`,
				details: {
					visibleFooterTop,
					expectedVisibleFooterTop,
					pinnedFooterRows: state.pinnedFooterRows,
					height: state.height,
				},
			};
		}
	} else if (!isFullFrame && state.virtualScrollTop === null) {
		// In short frame, footer immediately follows content
		if (footerBottom !== contentBottom) {
			return {
				oracle: "footerOccupiesBottomPhysicalRows",
				message: `In short frame, footer bottom (${footerBottom}) must match content bottom (${contentBottom}).`,
				details: { footerBottom, contentBottom },
			};
		}
	}

	return null;
}

/**
 * Guarantee 5: noFooterRowsAboveFooterRegion
 * No row belonging to the footer / composer zone appears anywhere above footerTop.
 */
export function checkNoFooterRowsAboveFooterRegion(state: ComposerOracleFrameState): OracleFailure | null {
	if (state.pinnedFooterRows <= 0) return null;
	const { footerTop } = state.screenBounds;

	for (let r = 0; r < footerTop; r++) {
		const line = state.viewportLines[r] ?? "";
		if (isComposerPromptLine(line, state.expectedPromptGlyph)) {
			return {
				oracle: "noFooterRowsAboveFooterRegion",
				message: `Composer prompt row found at row ${r}, which is above footerTop (${footerTop}): '${line}'.`,
				details: { row: r, footerTop, line },
			};
		}
		if (isHairlineLine(line) && r < footerTop - 1) {
			return {
				oracle: "noFooterRowsAboveFooterRegion",
				message: `Composer hairline row found at row ${r}, which is above footer region (${footerTop}): '${line}'.`,
				details: { row: r, footerTop, line },
			};
		}
	}

	return null;
}

/**
 * Guarantee 6: mouseClickRoutesToRenderedZone
 * A mouse click at row r must route to the component that actually rendered at row r.
 */
export function checkMouseClickRoutesToRenderedZone(state: ComposerOracleFrameState): OracleFailure | null {
	if (!state.mouseRouting) return null;
	const { footerTop, footerBottom, contentBottom } = state.screenBounds;

	for (const [row, routing] of state.mouseRouting.entries()) {
		if (row < 0 || row >= state.height) continue;

		const isInsideFooter = row >= footerTop && row <= footerBottom && state.pinnedFooterRows > 0;
		const isInsideTranscript = row >= 0 && row < footerTop && row <= contentBottom;
		const isOutsideContent = row > contentBottom || (!isInsideFooter && row > footerBottom);

		if (isInsideFooter && routing.routedTo === "transcript") {
			return {
				oracle: "mouseClickRoutesToRenderedZone",
				message: `Mouse click at row ${row} is inside footer bounds [${footerTop}..${footerBottom}] but routed to transcript.`,
				details: { row, footerTop, footerBottom, routing },
			};
		}

		if (isInsideTranscript && routing.routedTo?.startsWith("footer")) {
			return {
				oracle: "mouseClickRoutesToRenderedZone",
				message: `Mouse click at row ${row} is inside transcript bounds [0..${Math.min(footerTop - 1, contentBottom)}] but routed to footer: ${routing.routedTo}.`,
				details: { row, footerTop, contentBottom, routing },
			};
		}

		if (isOutsideContent && routing.routedTo?.startsWith("footer")) {
			return {
				oracle: "mouseClickRoutesToRenderedZone",
				message: `Mouse click at row ${row} is outside active content bounds (contentBottom=${contentBottom}) but routed to footer: ${routing.routedTo}.`,
				details: { row, contentBottom, routing },
			};
		}
	}

	return null;
}

/**
 * Guarantee 7: caretWithinComposerEditorBounds
 * When editor is focused, the terminal cursor must be within the editor's screen rows and column bounds.
 */
export function checkCaretWithinComposerEditorBounds(state: ComposerOracleFrameState): OracleFailure | null {
	if (!state.editorFocused || !state.cursor) return null;
	if (state.pinnedFooterRows <= 0) return null;

	const { footerTop, footerBottom } = state.screenBounds;

	// Cursor must be within footer screen rows
	if (state.cursor.row < footerTop || state.cursor.row > footerBottom) {
		return {
			oracle: "caretWithinComposerEditorBounds",
			message: `Cursor row ${state.cursor.row} is outside footer screen row bounds [${footerTop}..${footerBottom}].`,
			details: { cursor: state.cursor, footerTop, footerBottom },
		};
	}

	// Cursor col must be within [0, width)
	if (state.cursor.col < 0 || state.cursor.col >= state.width) {
		return {
			oracle: "caretWithinComposerEditorBounds",
			message: `Cursor col ${state.cursor.col} is outside terminal width bounds [0..${state.width - 1}].`,
			details: { cursor: state.cursor, width: state.width },
		};
	}

	return null;
}

/**
 * Guarantee 8: noHorizontalOverflow
 * Every rendered row in the terminal grid must have visible character width <= terminal width.
 */
export function checkNoHorizontalOverflow(state: ComposerOracleFrameState): OracleFailure | null {
	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		const width = visibleWidth(line);
		if (width > state.width) {
			return {
				oracle: "noHorizontalOverflow",
				message: `Row ${r} has visible width ${width} exceeding terminal width ${state.width}: '${line}'.`,
				details: { row: r, visibleWidth: width, terminalWidth: state.width, line },
			};
		}
	}
	return null;
}

/**
 * Screen row a segment's first row occupies, or null when that row is off screen.
 *
 * A frame row maps to a screen row differently for the two regions of the frame. The pinned footer
 * is painted at the bottom of the screen whatever the transcript is doing, so a footer segment is
 * located from the footer's own top row. Everything above it scrolls, so a content segment is
 * located from the top of whatever window is on screen: the frozen slice's top row while the view
 * is scrolled back, and the live window's top row otherwise.
 *
 * `startIndex - windowTopRow` alone is only the live-tail content mapping. Applied to a footer
 * segment while the view was frozen it produced two wrong answers at once: a frame that overflowed
 * the viewport by a few rows mapped a pad row onto a footer row and reported the capability line as
 * unpainted air, and a frame that overflowed by more than a screen mapped it past the end of the
 * viewport, where the bounds check dropped it and the oracle inspected nothing at all.
 *
 * A terminal shorter than the footer is the third case. The engine paints the footer's tail and
 * drops the rest, so a footer row above the footer's top row is on no screen row, and returning the
 * arithmetic's answer for it names a row the transcript owns.
 */
export function screenRowForSegment(state: ComposerOracleFrameState, segmentIndex: number): number | null {
	const segment = state.segments[segmentIndex];
	if (!segment) return null;
	const footerFirstIndex = state.segments.length - state.pinnedFooterChildCount;
	if (state.pinnedFooterChildCount > 0 && segmentIndex >= footerFirstIndex) {
		const footerFirst = state.segments[footerFirstIndex];
		if (!footerFirst) return null;
		const row = state.screenBounds.footerRowOffset + (segment.startIndex - footerFirst.startIndex);
		// A terminal too short to hold the whole footer shows only its tail, so a footer row above
		// the footer's top row was clipped and is on no screen row at all. Without this the
		// arithmetic hands back a row the transcript is painted on.
		return row < Math.max(0, state.screenBounds.footerTop) ? null : row;
	}
	const top = state.virtualScrollTop ?? state.windowTopRow;
	const row = segment.startIndex - top;
	return row < 0 ? null : row;
}

/**
 * Guarantee 9: composerCardPadsAreUnpaintedAir
 * The vertical breathing rows above and below the input (CardPadRow) must render as unpainted blank lines.
 */
export function checkComposerCardPadsAreUnpaintedAir(state: ComposerOracleFrameState): OracleFailure | null {
	// Look for CardPadRow segments in the ledger
	for (let i = 0; i < state.segments.length; i += 1) {
		const segment = state.segments[i]!;
		if (segment.componentName === "CardPadRow" && segment.rowCount > 0) {
			const segmentScreenRow = screenRowForSegment(state, i);
			if (segmentScreenRow !== null && segmentScreenRow < state.rawViewportLines.length) {
				const rawLine = state.rawViewportLines[segmentScreenRow] ?? "";
				const plainLine = state.viewportLines[segmentScreenRow] ?? "";
				// Padding must be blank air: no painted background and no glyphs. The background is read
				// from the cell grid as well as from the escape sequences, because a harness whose rows
				// come back as cell text carries the fill in the cells and nowhere else.
				const styled = state.styledColumns[segmentScreenRow];
				const filled = (styled?.background.length ?? 0) > 0;
				if (paintsBackground(rawLine) || filled || plainLine.trim().length > 0) {
					return {
						oracle: "composerCardPadsAreUnpaintedAir",
						message: `CardPadRow at screen row ${segmentScreenRow} has non-blank content or background styling: '${rawLine}'.`,
						details: { row: segmentScreenRow, rawLine, plainLine },
					};
				}
			}
		}
	}
	return null;
}

/**
 * Guarantee 10: composerHairlineSpanAndPlacement
 * The hairline separates transcript from composer zone and renders on exactly one boundary row.
 */
export function checkComposerHairlineSpanAndPlacement(state: ComposerOracleFrameState): OracleFailure | null {
	if (state.pinnedFooterRows <= 0) return null;

	const hairlineSegments = state.segments.filter(s => s.componentName === "ComposerHairline");
	if (hairlineSegments.length === 0) return null;

	for (const seg of hairlineSegments) {
		if (seg.rowCount !== 1) {
			return {
				oracle: "composerHairlineSpanAndPlacement",
				message: `ComposerHairline segment rowCount is ${seg.rowCount}, expected exactly 1.`,
				details: { segment: seg },
			};
		}
	}

	return null;
}

/**
 * Guarantee 11: footerHeightMatchesComposedSegmentLedger
 * pinnedFooterRows matches the sum of row counts of the last pinnedFooterChildCount root segments.
 */
export function checkFooterHeightMatchesComposedSegmentLedger(state: ComposerOracleFrameState): OracleFailure | null {
	if (state.pinnedFooterChildCount <= 0) {
		if (state.pinnedFooterRows !== 0) {
			return {
				oracle: "footerHeightMatchesComposedSegmentLedger",
				message: `pinnedFooterChildCount is 0 but pinnedFooterRows is ${state.pinnedFooterRows}.`,
				details: { pinnedFooterChildCount: state.pinnedFooterChildCount, pinnedFooterRows: state.pinnedFooterRows },
			};
		}
		return null;
	}

	const footerSegments = state.segments.slice(-state.pinnedFooterChildCount);
	const ledgerSum = footerSegments.reduce((sum, s) => sum + s.rowCount, 0);

	if (state.pinnedFooterRows !== ledgerSum) {
		return {
			oracle: "footerHeightMatchesComposedSegmentLedger",
			message: `pinnedFooterRows (${state.pinnedFooterRows}) does not match segment ledger sum (${ledgerSum}) across last ${state.pinnedFooterChildCount} children.`,
			details: {
				pinnedFooterRows: state.pinnedFooterRows,
				ledgerSum,
				footerSegments,
			},
		};
	}

	return null;
}

/**
 * Guarantee 12: virtualScrollPreservesFooterStability
 * When scrolling back in scroll isolation, the footer rows rendered at the bottom must remain strictly
 * identical to the live footer state without leaking historical snapshot lines.
 */
export function checkVirtualScrollPreservesFooterStability(state: ComposerOracleFrameState): OracleFailure | null {
	if (state.virtualScrollTop === null || !state.liveFooterLines || state.pinnedFooterRows <= 0) {
		return null;
	}

	const { footerTop, footerBottom } = state.screenBounds;
	const renderedFooterRows = state.viewportLines.slice(footerTop, footerBottom + 1);
	const footerRows = Math.min(state.pinnedFooterRows, state.height - 1);
	const expectedFooter = state.liveFooterLines.slice(-footerRows);

	// The rendered footer in virtual scroll must match the live footer lines
	if (renderedFooterRows.length !== expectedFooter.length) {
		return {
			oracle: "virtualScrollPreservesFooterStability",
			message: `Virtual scroll footer rendered ${renderedFooterRows.length} rows, live footer expected ${expectedFooter.length} rows.`,
			details: { renderedFooterRows, expectedFooter, liveFooterLines: state.liveFooterLines },
		};
	}

	for (let i = 0; i < renderedFooterRows.length; i++) {
		const rendered = renderedFooterRows[i] ?? "";
		const expected = expectedFooter[i] ?? "";
		if (rendered !== expected) {
			return {
				oracle: "virtualScrollPreservesFooterStability",
				message: `Virtual scroll footer row ${i} ('${rendered}') differs from live footer ('${expected}').`,
				details: { index: i, rendered, expected },
			};
		}
	}

	return null;
}

/**
 * Guarantee 13: noStyleBleedPastPaintedText
 * No cell beyond a row's painted text carries a style.
 *
 * This is what an escape sequence the renderer never closed looks like once a terminal has parsed it.
 * The sequence itself is gone by then, consumed into cell attributes, so nothing in a row's text
 * reveals it; what remains is a colour on cells the row never wrote to, and on the rows after it. The
 * effect is a stripe of background across the blank right-hand side of a row, or a coloured shell
 * prompt after the process exits, and neither is visible in a stripped grid.
 */
export function checkNoStyleBleedPastPaintedText(state: ComposerOracleFrameState): OracleFailure | null {
	for (let row = 0; row < state.styledColumns.length; row += 1) {
		const styled = state.styledColumns[row];
		if (!styled) continue;
		// The painted text is the row's own content. `viewportLines` arrives with trailing blanks
		// trimmed, so its length is the first column the row did not write to.
		const painted = (state.viewportLines[row] ?? "").length;
		for (const [attribute, columns] of [
			["background", styled.background],
			["foreground", styled.foreground],
			["underline", styled.underline],
		] as const) {
			const past = columns.filter(column => column >= painted);
			if (past.length > 0) {
				return {
					oracle: "noStyleBleedPastPaintedText",
					message: `Row ${row} paints ${painted} columns of text and carries ${attribute} on column(s) ${past.join(", ")} past it, which is an unclosed style bleeding into blank cells.`,
					details: { row, attribute, painted, columns: past },
				};
			}
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * What an oracle reads to reach its verdict.
 *
 * An oracle with an empty subject inspects nothing, and every one of them reports that as success.
 * Two defects found in this module were exactly that: the padding oracle computing a screen row past
 * the end of the viewport, and the bleed oracle looking for a transcript marker no painted row
 * carried. Neither failed anything, and a sweep of thousands of states reported clean while the
 * guarantee went unchecked. Declaring the subject makes the difference between a state an oracle
 * judged and a state it walked away from observable, instead of both reading as a pass.
 */
export type OracleSubject =
	| { kind: "rows"; rows: readonly number[] }
	| { kind: "ledger"; segments: readonly FrameSegmentSnapshot[] }
	| { kind: "routing"; rows: readonly number[] }
	| { kind: "cursor"; row: number; col: number }
	| { kind: "bounds"; footerTop: number; footerBottom: number };

/** How many things a subject holds. Zero means the oracle would inspect nothing. */
export function subjectSize(subject: OracleSubject): number {
	switch (subject.kind) {
		case "rows":
		case "routing":
			return subject.rows.length;
		case "ledger":
			return subject.segments.length;
		case "cursor":
		case "bounds":
			return 1;
	}
}

/**
 * One guarantee, its precondition, and what it reads.
 *
 * Before this registry the module carried three hand-maintained parallel lists: the id tuple, the
 * array of check functions inside the evaluator, and the `Guarantee N` numbering in the doc
 * comments. Nothing linked them, so an oracle added to one and missed in another was silent, and
 * every precondition was buried in the check body as an early `return null`, which is indexed as a
 * pass. The registry is keyed by the id union, so a new id without an entry and an entry without an
 * id are both type errors.
 */
export interface ComposerOracle {
	/** Guarantee id, matching its key in the registry. */
	id: ComposerOracleGuarantee;
	/** What the guarantee promises, in one sentence. */
	description: string;
	/**
	 * Whether the guarantee is meaningful for this state at all.
	 *
	 * A state outside an oracle's scope is reported as skipped rather than passed. These predicates
	 * are the guards that used to sit at the top of each check body.
	 */
	appliesTo(state: ComposerOracleFrameState): boolean;
	/** What `run` will read for this state. */
	subject(state: ComposerOracleFrameState): OracleSubject;
	/** The judgement itself. */
	run(state: ComposerOracleFrameState): OracleFailure | null;
}

/** Every viewport row index, for an oracle that scans the whole grid. */
function allRows(state: ComposerOracleFrameState): readonly number[] {
	return Array.from({ length: state.viewportLines.length }, (_v, r) => r);
}

/** Rows carrying a declared transcript marker, which is what the bleed oracles judge. */
function markerRows(state: ComposerOracleFrameState): readonly number[] {
	const markers = state.transcriptLineMarkers ?? [];
	if (markers.length === 0) return [];
	const rows: number[] = [];
	for (let r = 0; r < state.viewportLines.length; r += 1) {
		const line = state.viewportLines[r] ?? "";
		if (markers.some(m => line.includes(m))) rows.push(r);
	}
	return rows;
}

/** Screen rows the CardPadRow segments land on, dropping the ones off screen. */
function padRows(state: ComposerOracleFrameState): readonly number[] {
	const rows: number[] = [];
	for (let i = 0; i < state.segments.length; i += 1) {
		const segment = state.segments[i]!;
		if (segment.componentName !== "CardPadRow" || segment.rowCount <= 0) continue;
		const row = screenRowForSegment(state, i);
		if (row !== null && row < state.rawViewportLines.length) rows.push(row);
	}
	return rows;
}

/**
 * Every guarantee, keyed by its id.
 *
 * Keyed by the union rather than held in an array so the type checker enforces totality in both
 * directions: adding an id to `COMPOSER_ORACLE_GUARANTEES` without an entry here fails to compile,
 * and an entry whose key is not an id fails too.
 */
export const COMPOSER_ORACLES: Readonly<Record<ComposerOracleGuarantee, ComposerOracle>> = {
	exactlyOneComposerPrompt: {
		id: "exactlyOneComposerPrompt",
		description:
			"One composer prompt row is on screen when the composer is in view, and none when it is scrolled off.",
		appliesTo: () => true,
		subject: state => ({ kind: "rows", rows: allRows(state) }),
		run: checkExactlyOneComposerPrompt,
	},
	noOutputBleedPastComposer: {
		id: "noOutputBleedPastComposer",
		description: "No transcript row is painted inside the footer zone or below the content bottom.",
		appliesTo: state => state.pinnedFooterRows > 0 && (state.transcriptLineMarkers ?? []).length > 0,
		subject: state => ({ kind: "rows", rows: markerRows(state) }),
		run: checkNoOutputBleedPastComposer,
	},
	noMixedTranscriptAndChromeRows: {
		id: "noMixedTranscriptAndChromeRows",
		description: "No row carries both transcript content and composer chrome.",
		appliesTo: state => (state.transcriptLineMarkers ?? []).length > 0,
		subject: state => ({ kind: "rows", rows: markerRows(state) }),
		run: checkNoMixedTranscriptAndChromeRows,
	},
	footerOccupiesBottomPhysicalRows: {
		id: "footerOccupiesBottomPhysicalRows",
		description: "The pinned footer occupies the bottom rows of the viewport on the live tail.",
		// The body judges nothing while the view is frozen: both of its branches require a null
		// virtual scroll top, so a frozen state was walking out through the bottom of the function.
		appliesTo: state => state.pinnedFooterRows > 0 && state.virtualScrollTop === null,
		subject: state => ({
			kind: "bounds",
			footerTop: state.screenBounds.footerTop,
			footerBottom: state.screenBounds.footerBottom,
		}),
		run: checkFooterOccupiesBottomPhysicalRows,
	},
	noFooterRowsAboveFooterRegion: {
		id: "noFooterRowsAboveFooterRegion",
		description: "No composer chrome row appears above the top of the footer region.",
		appliesTo: state => state.pinnedFooterRows > 0 && state.screenBounds.footerTop > 0,
		subject: state => ({
			kind: "rows",
			rows: Array.from({ length: Math.max(0, state.screenBounds.footerTop) }, (_v, r) => r),
		}),
		run: checkNoFooterRowsAboveFooterRegion,
	},
	mouseClickRoutesToRenderedZone: {
		id: "mouseClickRoutesToRenderedZone",
		description: "A click routes to the component painted at the row it landed on.",
		appliesTo: state => (state.mouseRouting?.size ?? 0) > 0,
		subject: state => ({ kind: "routing", rows: [...(state.mouseRouting?.keys() ?? [])] }),
		run: checkMouseClickRoutesToRenderedZone,
	},
	caretWithinComposerEditorBounds: {
		id: "caretWithinComposerEditorBounds",
		description: "The terminal cursor sits inside the editor's rows and the terminal's width.",
		appliesTo: state => state.editorFocused === true && state.cursor !== null && state.pinnedFooterRows > 0,
		subject: state => ({ kind: "cursor", row: state.cursor?.row ?? -1, col: state.cursor?.col ?? -1 }),
		run: checkCaretWithinComposerEditorBounds,
	},
	noHorizontalOverflow: {
		id: "noHorizontalOverflow",
		description: "No row's visible width exceeds the terminal width.",
		appliesTo: () => true,
		subject: state => ({ kind: "rows", rows: allRows(state) }),
		run: checkNoHorizontalOverflow,
	},
	composerCardPadsAreUnpaintedAir: {
		id: "composerCardPadsAreUnpaintedAir",
		description: "The breathing rows above and below the input paint no glyphs and no background.",
		appliesTo: state => state.segments.some(s => s.componentName === "CardPadRow" && s.rowCount > 0),
		subject: state => ({ kind: "rows", rows: padRows(state) }),
		run: checkComposerCardPadsAreUnpaintedAir,
	},
	composerHairlineSpanAndPlacement: {
		id: "composerHairlineSpanAndPlacement",
		description: "The hairline occupies exactly one boundary row.",
		appliesTo: state =>
			state.pinnedFooterRows > 0 && state.segments.some(s => s.componentName === "ComposerHairline"),
		subject: state => ({
			kind: "ledger",
			segments: state.segments.filter(s => s.componentName === "ComposerHairline"),
		}),
		run: checkComposerHairlineSpanAndPlacement,
	},
	footerHeightMatchesComposedSegmentLedger: {
		id: "footerHeightMatchesComposedSegmentLedger",
		description: "The pinned footer's row count is the sum of its children's rows in the ledger.",
		appliesTo: () => true,
		subject: state => ({
			kind: "ledger",
			segments:
				state.pinnedFooterChildCount > 0 ? state.segments.slice(-state.pinnedFooterChildCount) : state.segments,
		}),
		run: checkFooterHeightMatchesComposedSegmentLedger,
	},
	virtualScrollPreservesFooterStability: {
		id: "virtualScrollPreservesFooterStability",
		description: "A frozen view paints the live footer at the bottom, with no snapshot rows leaking into it.",
		appliesTo: state =>
			state.virtualScrollTop !== null && (state.liveFooterLines?.length ?? 0) > 0 && state.pinnedFooterRows > 0,
		subject: state => ({
			kind: "bounds",
			footerTop: state.screenBounds.footerTop,
			footerBottom: state.screenBounds.footerBottom,
		}),
		run: checkVirtualScrollPreservesFooterStability,
	},
	noStyleBleedPastPaintedText: {
		id: "noStyleBleedPastPaintedText",
		description: "No cell beyond a row's painted text carries a background, foreground or underline.",
		appliesTo: () => true,
		// Every row, because the absence of style past the text is the property: a row with no styled
		// cell at all is a row this read and found clean, not a row it could not judge.
		subject: state => ({ kind: "rows", rows: allRows(state) }),
		run: checkNoStyleBleedPastPaintedText,
	},
};

// ---------------------------------------------------------------------------
// Master Evaluator
// ---------------------------------------------------------------------------

/**
 * Run every composer defect oracle on a frame state.
 *
 * Walks `COMPOSER_ORACLE_GUARANTEES` so the order is the declared one rather than an object's key
 * order, and separates the three outcomes an oracle can have. `passed` still reports only whether
 * anything failed, so existing callers are unaffected.
 */
export function evaluateAllComposerOracles(state: ComposerOracleFrameState): OracleEvaluationResult {
	const failures: OracleFailure[] = [];
	const skipped: ComposerOracleGuarantee[] = [];
	const inspected: ComposerOracleGuarantee[] = [];
	const blind: ComposerOracleGuarantee[] = [];

	for (const id of COMPOSER_ORACLE_GUARANTEES) {
		const oracle = COMPOSER_ORACLES[id];
		if (!oracle.appliesTo(state)) {
			skipped.push(id);
			continue;
		}
		if (subjectSize(oracle.subject(state)) === 0) {
			blind.push(id);
			continue;
		}
		inspected.push(id);
		const failure = oracle.run(state);
		if (failure) failures.push(failure);
	}

	return { passed: failures.length === 0, failures, skipped, inspected, blind };
}
