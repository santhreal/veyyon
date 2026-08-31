/**
 * How a terminal draws the web domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 */
import type { ToolRenderer } from "../renderers";
import { browserToolRenderer } from "./browser/render";
import { githubToolRenderer } from "./gh-renderer";

export const webRenderers: Record<string, ToolRenderer> = {
	browser: browserToolRenderer as ToolRenderer,
	github: githubToolRenderer as ToolRenderer,
};
