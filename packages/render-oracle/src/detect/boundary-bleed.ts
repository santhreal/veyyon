import { isComposerPromptLine, isHairlineLine } from "./frame-inspection";
import type { ComposerOracleFrameState, OracleFailure } from "./types";

/**
 * Guarantee 2: noOutputBleedPastComposer
 * Rendered transcript output rows must never bleed past the composer boundary into the footer zone,
 * and footer rows must never appear above the footer boundary in the transcript zone.
 */
export function checkNoOutputBleedPastComposer(state: ComposerOracleFrameState): OracleFailure | null {
	const { footerTop, footerBottom, contentBottom } = state.screenBounds;
	const markers = state.transcriptLineMarkers ?? [];

	if (state.pinnedFooterRows <= 0) return null;

	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		const hasTranscriptMarker = markers.some(m => line.includes(m));

		if (hasTranscriptMarker) {
			// Transcript content must be strictly above footerTop (or in transcript region)
			if (r >= footerTop && r <= footerBottom) {
				return {
					oracle: "noOutputBleedPastComposer",
					message: `Transcript output row '${line}' found at row ${r}, which is inside the composer footer zone (footerTop=${footerTop}, footerBottom=${footerBottom}).`,
					details: { row: r, line, footerTop, footerBottom },
				};
			}
			if (r > contentBottom) {
				return {
					oracle: "noOutputBleedPastComposer",
					message: `Transcript output row '${line}' found at row ${r} beyond contentBottom ${contentBottom}.`,
					details: { row: r, line, contentBottom },
				};
			}
		}
	}

	return null;
}

/**
 * Guarantee 3: noMixedTranscriptAndChromeRows
 * No single row in the rendered frame may contain both transcript/output text and composer chrome tokens.
 */
export function checkNoMixedTranscriptAndChromeRows(state: ComposerOracleFrameState): OracleFailure | null {
	const markers = state.transcriptLineMarkers ?? [];
	if (markers.length === 0) return null;

	for (let r = 0; r < state.viewportLines.length; r++) {
		const line = state.viewportLines[r] ?? "";
		const hasTranscript = markers.some(m => line.includes(m));
		if (!hasTranscript) continue;

		const hasPrompt = isComposerPromptLine(line, state.expectedPromptGlyph);
		const hasHairline = isHairlineLine(line);

		if (hasPrompt || hasHairline) {
			return {
				oracle: "noMixedTranscriptAndChromeRows",
				message: `Row ${r} mixes transcript content with composer chrome: '${line}'.`,
				details: { row: r, line, hasPrompt, hasHairline },
			};
		}
	}

	return null;
}
