/**
 * How a terminal draws the search domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 */
import { viewToolRenderer } from "../../tui/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { astEditToolView } from "./ast-edit-view";
import { searchToolRenderer } from "./search-renderer";
import { searchToolBm25ToolView } from "./search-tool-bm25-view";

export const searchRenderers: Record<string, ToolRenderer> = {
	search: searchToolRenderer as ToolRenderer,
	ast_edit: viewToolRenderer(astEditToolView, { mergeCallAndResult: true, inline: true }) as ToolRenderer,
	search_tool_bm25: viewToolRenderer(searchToolBm25ToolView, {
		mergeCallAndResult: true,
		inline: true,
	}) as ToolRenderer,
};
