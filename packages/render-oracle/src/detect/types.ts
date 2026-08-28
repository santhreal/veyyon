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
