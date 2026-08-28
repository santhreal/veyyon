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
