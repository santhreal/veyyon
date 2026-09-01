/**
 * How a terminal draws the web domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 */
import { viewToolRenderer } from "../../tui/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { browserToolView } from "./browser/view";
import { githubToolView } from "./gh-view";

/** Whether the call is the action whose card grows as the script arrives. */
function isRunAction(args: unknown): boolean {
	return (args as { action?: unknown } | undefined)?.action === "run";
}

export const webRenderers: Record<string, ToolRenderer> = {
	// A `run` card is the only one that animates: it streams the script and then the output, where
	// `open` and `close` are one row that either happened or did not.
	browser: viewToolRenderer(browserToolView, {
		mergeCallAndResult: true,
		inline: true,
		animatedPendingPreview: isRunAction,
		animatedPartialResult: isRunAction,
	}) as ToolRenderer,
	// No animatedPendingPreview: the pending row is materialized once per display rebuild rather than
	// from a render closure, so a live spinner interval would ask for 30fps repaints while the visible
	// glyph stayed frozen.
	github: viewToolRenderer(githubToolView, { mergeCallAndResult: true }) as ToolRenderer,
};
