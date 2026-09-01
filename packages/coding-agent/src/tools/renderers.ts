/**
 * TUI renderers for built-in tools.
 *
 * The rows come from the domain renderer tables, each sitting next to the tools it draws, plus the
 * six whose subject lives outside `tools/`. This module owns the {@link ToolRenderer} contract and
 * the union; it no longer owns the list.
 */
import type { Component } from "@veyyon/tui";
import type { ToolViewRenderer } from "@veyyon/view";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolView } from "../goals/goal-tool";
import { lspToolView } from "../lsp/view";
import { taskToolRenderer } from "../task/renderer";
import type { Theme } from "../theme/theme";
import { viewToolRenderer } from "../tui/draw-tool-view";
import { webSearchToolView } from "../web/search/view";
import { agentRenderers } from "./agent/renderers";
import { fsRenderers } from "./fs/renderers";
import { searchRenderers } from "./search/renderers";
import { shellRenderers } from "./shell/renderers";
import { webRenderers } from "./web/renderers";

/**
 * Per-renderer opt-in for a full viewport replay when the first result
 * replaces a painted pending-call render. A predicate receives the painted
 * call args and render options so the repaint stays scoped to the pending
 * shapes that actually re-anchor (an over-eager replay wipes native
 * scrollback on direct terminals).
 */
export type FirstResultViewportRepaint = boolean | ((args: unknown, options: RenderResultOptions) => boolean);

export type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	/**
	 * The host-agnostic card this entry draws, present only on an entry built by `viewToolRenderer`.
	 *
	 * An entry either DESCRIBES its card as a {@link ToolViewRenderer} and lets a host draw it, or
	 * draws terminal components itself. Both look the same from the two members above, so the
	 * distinction is stated here rather than inferred, and the architecture gate that records every
	 * card still drawn in terminal components resolves the split from the registry instead of from a
	 * list kept by hand.
	 */
	view?: ToolViewRenderer<never, never>;
	mergeCallAndResult?: boolean;
	/**
	 * Whether the call render IS an interactive widget rather than a preview of one.
	 *
	 * `ask` paints the whole selectable question in `renderCall`, because until a result arrives
	 * that widget is the card. For a call that never reached the tool, painting it puts an
	 * answerable question on screen for a question that was never asked, so the component falls
	 * back to the plain tool label. Only set this where the call render invites an answer: a
	 * command preview (`bash`) or a diff preview is the one fact the card must keep in that state.
	 */
	callIsLiveWidget?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
	/**
	 * Whether the renderer's pending-call path visibly consumes
	 * `options.spinnerFrame`. Used to avoid scheduling repaint ticks for live
	 * partial calls whose bytes cannot change between spinner frames.
	 */
	animatedPendingPreview?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether the renderer's partial-result path visibly consumes
	 * `options.spinnerFrame`.
	 */
	animatedPartialResult?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether replacing a pending call render with the first result requires a
	 * full viewport repaint. Use for merged renderers whose pending rows can be
	 * re-anchored instead of preserved by the result render.
	 */
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;
	/**
	 * Whether settling a provisional partial result into the final render requires
	 * a full viewport repaint. Use when the result renderer changes chrome or
	 * frame topology at `options.isPartial: true -> false`.
	 */
	forceResultViewportRepaintOnSettle?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	...fsRenderers,
	...searchRenderers,
	...shellRenderers,
	...webRenderers,
	...agentRenderers,
	edit: editToolRenderer as ToolRenderer,
	// The same renderer under the name a provider-side patch call arrives as.
	apply_patch: editToolRenderer as ToolRenderer,
	// The lsp tool describes a view, and this entry is the terminal's drawing of it — the path a
	// rebuilt transcript takes, where no tool instance exists to read `tool.view` from.
	lsp: viewToolRenderer(lspToolView, { mergeCallAndResult: true, inline: true }) as ToolRenderer,
	// Lazy getter: `taskToolRenderer` lives in a module that closes an import
	// cycle back here (task/renderer → task/render → … → tools/renderers), so
	// reading it at init order-dependently hits its temporal dead zone. Deferring
	// the read to first access (render time) sidesteps the cycle entirely.
	get task(): ToolRenderer {
		return taskToolRenderer as ToolRenderer;
	},
	// The goal tool describes a view instead of drawing a component, so its entry here is the
	// terminal's drawing of that same view. It exists for the rebuilt transcript of a session that
	// never constructed the tool, which is the one path that cannot read `tool.view`.
	goal: viewToolRenderer(goalToolView, { mergeCallAndResult: true }) as ToolRenderer,
	web_search: viewToolRenderer(webSearchToolView, { mergeCallAndResult: true }) as ToolRenderer,
};
