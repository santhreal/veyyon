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
