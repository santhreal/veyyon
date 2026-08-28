import type { ComposerOracleFrameState, OracleFailure } from "./types";

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
	const renderedFooterRows = state.viewportLines.slice(Math.max(0, footerTop), footerBottom + 1);
	// How many footer rows reach the screen is the renderer's decision, read back from
	// the bounds it placed rather than re-derived from a clamp this file would have to
	// keep in step. The footer shows its LAST rows when it does not fit.
	const expectedFooter =
		renderedFooterRows.length === 0 ? [] : state.liveFooterLines.slice(-renderedFooterRows.length);

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
