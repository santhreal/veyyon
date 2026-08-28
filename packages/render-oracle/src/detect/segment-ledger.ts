import type { ComposerOracleFrameState, OracleFailure } from "./types";

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
