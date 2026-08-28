/**
 * Composer zone defect oracle predicates.
 *
 * Evaluates rendered terminal frames and TUI state against formal invariant guarantees
 * of the composer zone rather than comparisons against golden snapshots.
 *
 * Derived directly from renderer semantics (packages/tui/src/tui.ts and
 * packages/coding-agent/src/modes/components/composer-chrome.ts).
 *
 * These predicates are the composer specialisation of the oracle surface. They read
 * `ComposerOracleFrameState`, which carries composer chrome placement a general
 * `FrameCapture` does not describe. `../layout.ts` adapts each one into a registered
 * `Guarantee` so the registry, the sweep and the corpus reach them the same way they
 * reach every other domain.
 */

import { checkNoMixedTranscriptAndChromeRows, checkNoOutputBleedPastComposer } from "./boundary-bleed";
import { checkComposerCardPadsAreUnpaintedAir } from "./card-pads";
import { checkCaretWithinComposerEditorBounds } from "./caret-bounds";
import { checkFooterOccupiesBottomPhysicalRows, checkNoFooterRowsAboveFooterRegion } from "./footer-placement";
import { checkComposerHairlineSpanAndPlacement } from "./hairline-span";
import { checkNoHorizontalOverflow } from "./horizontal-overflow";
import { checkMouseClickRoutesToRenderedZone } from "./mouse-routing";
import { checkExactlyOneComposerPrompt } from "./prompt-rows";
import { checkFooterHeightMatchesComposedSegmentLedger } from "./segment-ledger";
import type { ComposerOracleFrameState, OracleEvaluationResult, OracleFailure } from "./types";
import { checkVirtualScrollPreservesFooterStability } from "./virtual-scroll-stability";

export * from "./boundary-bleed";
export * from "./card-pads";
export * from "./caret-bounds";
export * from "./footer-placement";
export * from "./frame-inspection";
export * from "./hairline-span";
export * from "./horizontal-overflow";
export * from "./mouse-routing";
export * from "./prompt-rows";
export * from "./segment-ledger";
export * from "./types";
export * from "./virtual-scroll-stability";

// ---------------------------------------------------------------------------
// Master Evaluator
// ---------------------------------------------------------------------------

/**
 * Run all composer defect oracles on a frame state.
 */
export function evaluateAllComposerOracles(state: ComposerOracleFrameState): OracleEvaluationResult {
	const failures: OracleFailure[] = [];

	const checks = [
		checkExactlyOneComposerPrompt,
		checkNoOutputBleedPastComposer,
		checkNoMixedTranscriptAndChromeRows,
		checkFooterOccupiesBottomPhysicalRows,
		checkNoFooterRowsAboveFooterRegion,
		checkMouseClickRoutesToRenderedZone,
		checkCaretWithinComposerEditorBounds,
		checkNoHorizontalOverflow,
		checkComposerCardPadsAreUnpaintedAir,
		checkComposerHairlineSpanAndPlacement,
		checkFooterHeightMatchesComposedSegmentLedger,
		checkVirtualScrollPreservesFooterStability,
	];

	for (const check of checks) {
		const failure = check(state);
		if (failure) {
			failures.push(failure);
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}
