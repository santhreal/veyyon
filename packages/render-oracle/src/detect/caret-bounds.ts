import type { ComposerOracleFrameState, OracleFailure } from "./types";

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
