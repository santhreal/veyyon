/**
 * The paint one frame takes. `TUI#doRender` plans the window, then selects an intent from the
 * plan and the frame's classification; the intent selects the emitter. Split out of `frame-plan.ts`
 * and `tui.ts` so the record and the rule that produces it are read together.
 */
import type { WindowPlan } from "./frame-plan";
import { isMultiplexerSession } from "./terminal-session";

/**
 * Render intent. `#doRender` classifies each frame, and the matching `#emit*`
 * method owns the bytes written and the state update.
 *
 * - `fullPaint`: gesture-driven replay — initial paint, session replacement,
 *   resize, resetDisplay. Rewrites the frame from home; destructive replaces
 *   clear native scrollback via ED3 without first blanking the viewport. The
 *   only ED3 callsite in the engine.
 * - `update`: ordinary frame. Commits the newly settled chunk at the
 *   scrollback seam (if any) and repaints the window with relative moves.
 */
export type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };

/**
 * The paint a classified frame takes: an incremental update of the planned window, or a full paint that clears
 * native scrollback after a divergence, or after a requested replace or geometry rebuild outside a multiplexer.
 */
export function frameIntent(
	fullPaint: boolean,
	divergenceRebuild: boolean,
	rebuildRequested: boolean,
	plan: WindowPlan,
): RenderIntent {
	if (!fullPaint) return { kind: "update", chunkTo: plan.chunkTo, windowTop: plan.windowTop };
	return { kind: "fullPaint", clearScrollback: divergenceRebuild || (rebuildRequested && !isMultiplexerSession()) };
}
