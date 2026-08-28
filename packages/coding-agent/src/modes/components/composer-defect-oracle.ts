/** Composer zone defect oracle. Evaluates rendered terminal frames and TUI state against formal invariant guarantees */

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
] as const;

export type ComposerOracleGuarantee = (typeof COMPOSER_ORACLE_GUARANTEES)[number];

export interface FrameSegmentSnapshot {
	startIndex: number;
	rowCount: number;
	componentName: string;
}

export interface ComposerOracleFrameState {
	/** Viewport width in columns */
	width: number;
	/** Viewport height in rows */
	height: number;
	/** Visible lines on the terminal screen (ANSI stripped) */
	viewportLines: readonly string[];
	/** Raw visible lines with ANSI escape sequences */
	rawViewportLines: readonly string[];
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

export interface OracleEvaluationResult {
	passed: boolean;
	failures: OracleFailure[];
}

const PROMPT_GLYPHS = ["›", "!", "$", "◈", ">"] as const;

/** The prompt glyphs that also open an ordinary transcript row: a shell command, a markdown blockquote, a CSS rule. `›` and `◈` open none, so only these need */
const AMBIGUOUS_PROMPT_GLYPHS = new Set(["!", "$", ">"]);

const SGR = sgrSequence("g");

/** Whether a raw terminal line paints a background anywhere in it. Walks the SGR parameter list instead of pattern-matching its text. The `4`-prefixed spelling */
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

/** Check if a line is a composer prompt row. `expectedGlyph` is the glyph the frame states the composer painted. When it is */
export function isComposerPromptLine(plainLine: string, expectedGlyph?: string): boolean {
	const trimmedLeading = plainLine.trimStart();
	if (trimmedLeading.length === 0) return false;
	const leadingSpaces = plainLine.length - trimmedLeading.length;
	const glyphs: readonly string[] = expectedGlyph ? [expectedGlyph] : PROMPT_GLYPHS;
	let glyph: string | undefined;
	for (let gi = 0; gi < glyphs.length; gi++) {
		if (trimmedLeading.startsWith(glyphs[gi]!)) {
			glyph = glyphs[gi];
			break;
		}
	}
	if (glyph === undefined) return false;

	// A narrow terminal collapses the inset, so an unambiguous glyph counts at any
	// column. `!`, `$` and `>` are ASCII that opens ordinary transcript rows, so
	// they count only where the composer would actually paint them.
	return leadingSpaces >= COMPOSER_INSET_COLS || !AMBIGUOUS_PROMPT_GLYPHS.has(glyph);
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

/** Guarantee 1: exactlyOneComposerPrompt Exactly one composer prompt row exists in the active terminal viewport frame when the */
export function checkExactlyOneComposerPrompt(state: ComposerOracleFrameState): OracleFailure | null {
	const promptRows: number[] = [];
	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		if (isComposerPromptLine(line, state.expectedPromptGlyph)) {
			promptRows.push(r);
		}
	}

	let editorSegment: (typeof state.segments)[number] | undefined;
	for (let si = 0; si < state.segments.length; si++) {
		if (state.segments[si]!.componentName === "Editor") {
			editorSegment = state.segments[si];
			break;
		}
	}
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
/** Guarantee 2: noOutputBleedPastComposer Rendered transcript output rows must never bleed past the composer boundary into the footer zone, */
export function checkNoOutputBleedPastComposer(state: ComposerOracleFrameState): OracleFailure | null {
	const { footerTop, footerBottom, contentBottom } = state.screenBounds;
	const markers = state.transcriptLineMarkers ?? [];

	if (state.pinnedFooterRows <= 0) return null;

	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		let hasTranscriptMarker = false;
		for (let mi = 0; mi < markers.length; mi++) {
			if (line.includes(markers[mi]!)) {
				hasTranscriptMarker = true;
				break;
			}
		}

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

/** Guarantee 3: noMixedTranscriptAndChromeRows No single row in the rendered frame may contain both transcript/output text and composer chrome tokens. */
export function checkNoMixedTranscriptAndChromeRows(state: ComposerOracleFrameState): OracleFailure | null {
	const markers = state.transcriptLineMarkers ?? [];
	if (markers.length === 0) return null;

	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		let hasTranscript = false;
		for (let mi = 0; mi < markers.length; mi++) {
			if (line.includes(markers[mi]!)) {
				hasTranscript = true;
				break;
			}
		}
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

/** Guarantee 4: footerOccupiesBottomPhysicalRows The pinned footer occupies exactly the bottom n physical rows of the viewport in live tail mode */
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

/** Guarantee 5: noFooterRowsAboveFooterRegion No row belonging to the footer / composer zone appears anywhere above footerTop. */
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

/** Guarantee 6: mouseClickRoutesToRenderedZone A mouse click at row r must route to the component that actually rendered at row r. */
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

/** Guarantee 7: caretWithinComposerEditorBounds When editor is focused, the terminal cursor must be within the editor's screen rows and column bounds. */
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

/** Guarantee 8: noHorizontalOverflow Every rendered row in the terminal grid must have visible character width <= terminal width. */
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

/** Guarantee 9: composerCardPadsAreUnpaintedAir The vertical breathing rows above and below the input (CardPadRow) must render as unpainted blank lines. */
export function checkComposerCardPadsAreUnpaintedAir(state: ComposerOracleFrameState): OracleFailure | null {
	// Look for CardPadRow segments in the ledger
	for (const segment of state.segments) {
		if (segment.componentName === "CardPadRow" && segment.rowCount > 0) {
			// Find its screen position
			const segmentScreenRow = segment.startIndex - state.windowTopRow;
			if (segmentScreenRow >= 0 && segmentScreenRow < state.rawViewportLines.length) {
				const rawLine = state.rawViewportLines[segmentScreenRow] ?? "";
				const plainLine = state.viewportLines[segmentScreenRow] ?? "";
				// Padding must be blank air: no painted background and no glyphs.
				if (paintsBackground(rawLine) || plainLine.trim().length > 0) {
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

/** Guarantee 10: composerHairlineSpanAndPlacement The hairline separates transcript from composer zone and renders on exactly one boundary row. */
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

/** Guarantee 11: footerHeightMatchesComposedSegmentLedger pinnedFooterRows matches the sum of row counts of the last pinnedFooterChildCount root segments. */
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
	let ledgerSum = 0;
	for (let i = 0; i < footerSegments.length; i++) ledgerSum += footerSegments[i]!.rowCount;

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

/** Guarantee 12: virtualScrollPreservesFooterStability When scrolling back in scroll isolation, the footer rows rendered at the bottom must remain strictly */
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
 * Run all composer defect oracles on a frame state.
 */
export function evaluateAllComposerOracles(state: ComposerOracleFrameState): OracleEvaluationResult {
	const failures: OracleFailure[] = [];

	const checks = [
		checkExactlyOneComposerPrompt,
		checkNoOutputBleedPastComposer,
		checkNoMixedTranscriptAndChromeRows,
		checkFooterOccupiesBottomPhysicalRows,
		checkNoFooterRowsAboveFooterRegion,
		checkMouseClickRoutesToRenderedZone,
		checkCaretWithinComposerEditorBounds,
		checkNoHorizontalOverflow,
		checkComposerCardPadsAreUnpaintedAir,
		checkComposerHairlineSpanAndPlacement,
		checkFooterHeightMatchesComposedSegmentLedger,
		checkVirtualScrollPreservesFooterStability,
	];

	for (const check of checks) {
		const failure = check(state);
		if (failure) {
			failures.push(failure);
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}
