import { isComposerPromptLine } from "./frame-inspection";
import type { ComposerOracleFrameState, OracleFailure } from "./types";

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

	if (editorSegment) {
		const promptFrameRow = editorSegment.startIndex;
		const footerStartFrameRow = state.totalFrameRows - state.pinnedFooterRows;
		const promptIsFooterRow = state.pinnedFooterRows > 0 && promptFrameRow >= footerStartFrameRow;
		if (promptIsFooterRow) {
			// The footer's screen placement is `footerRowOffset` — the screen row its
			// FIRST row would occupy, negative when the footer is taller than the
			// viewport and the renderer clips its top. Mapping the prompt through that
			// offset asks the same question the renderer answered, instead of
			// re-deriving how many footer rows fit.
			const promptScreenRow = state.screenBounds.footerRowOffset + (promptFrameRow - footerStartFrameRow);
			expectedPromptInView = promptScreenRow >= 0 && promptScreenRow < state.height;
		} else {
			expectedPromptInView =
				promptFrameRow >= state.windowTopRow && promptFrameRow < state.windowTopRow + state.height;
		}
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
