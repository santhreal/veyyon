/**
 * How a terminal draws the web domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 */
import { viewToolRenderer } from "../../tui/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { browserToolRenderer } from "./browser/render";
import { githubToolView } from "./gh-view";

export const webRenderers: Record<string, ToolRenderer> = {
	browser: browserToolRenderer as ToolRenderer,
	// No animatedPendingPreview: the pending row is materialized once per display rebuild rather than
	// from a render closure, so a live spinner interval would ask for 30fps repaints while the visible
	// glyph stayed frozen.
	github: viewToolRenderer(githubToolView, { mergeCallAndResult: true }) as ToolRenderer,
};
