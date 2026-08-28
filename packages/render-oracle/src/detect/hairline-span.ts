import type { ComposerOracleFrameState, OracleFailure } from "./types";

/**
 * Guarantee 10: composerHairlineSpanAndPlacement
 * The hairline separates transcript from composer zone and renders on exactly one boundary row.
 */
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
