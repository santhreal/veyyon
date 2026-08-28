import { isComposerPromptLine, isHairlineLine } from "./frame-inspection";
import type { ComposerOracleFrameState, OracleFailure } from "./types";

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
