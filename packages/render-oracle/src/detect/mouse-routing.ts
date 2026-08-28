import type { ComposerOracleFrameState, OracleFailure } from "./types";

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
