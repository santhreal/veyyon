import { paintsBackground } from "./frame-inspection";
import type { ComposerOracleFrameState, OracleFailure } from "./types";

/**
 * Guarantee 9: composerCardPadsAreUnpaintedAir
 * The vertical breathing rows above and below the input (CardPadRow) must render as unpainted blank lines.
 */
export function checkComposerCardPadsAreUnpaintedAir(state: ComposerOracleFrameState): OracleFailure | null {
	// Look for CardPadRow segments in the ledger
	for (const segment of state.segments) {
		if (segment.componentName === "CardPadRow" && segment.rowCount > 0) {
			// Find its screen position
			const segmentScreenRow = segment.startIndex - state.windowTopRow;
			if (segmentScreenRow >= 0 && segmentScreenRow < state.rawViewportLines.length) {
				const rawLine = state.rawViewportLines[segmentScreenRow] ?? "";
				const plainLine = state.viewportLines[segmentScreenRow] ?? "";
				// Padding must be blank air: no painted background and no glyphs.
				if (paintsBackground(rawLine) || plainLine.trim().length > 0) {
					return {
						oracle: "composerCardPadsAreUnpaintedAir",
						message: `CardPadRow at screen row ${segmentScreenRow} has non-blank content or background styling: '${rawLine}'.`,
						details: { row: segmentScreenRow, rawLine, plainLine },
					};
				}
			}
		}
	}
	return null;
}
