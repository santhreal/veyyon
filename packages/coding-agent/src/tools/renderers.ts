/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@veyyon/tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolView } from "../goals/goal-tool";
import { lspToolRenderer } from "../lsp/render";
import { taskToolRenderer } from "../task/renderer";
import type { Theme } from "../theme/theme";
import { viewToolRenderer } from "../tui/draw-tool-view";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask-render";
import { astEditToolRenderer } from "./ast-edit-render";
import { bashToolRenderer } from "./bash-render";
import { browserToolRenderer } from "./browser/render";
import { debugToolRenderer } from "./debug-render";
import { evalToolRenderer } from "./eval-render";
import { githubToolRenderer } from "./gh-renderer";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { ircToolRenderer } from "./irc-render";
import { jobToolRenderer } from "./job-render";
import { launchToolRenderer } from "./launch-render";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory-render";
import { readToolRenderer } from "./read-render";
import { resolveToolRenderer } from "./resolve-render";
import { searchToolRenderer } from "./search-renderer";
import { searchToolBm25Renderer } from "./search-tool-bm25-render";
import { setCwdToolRenderer } from "./set-cwd-render";
import { sshToolRenderer } from "./ssh-render";
import { todoToolRenderer } from "./todo-render";
import { createVibeToolRenderer } from "./vibe-render";
import { writeToolRenderer } from "./write-render";
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
	ask: askToolRenderer as ToolRenderer,
	ast_edit: astEditToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	browser: browserToolRenderer as ToolRenderer,
	debug: debugToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	search: searchToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
	irc: ircToolRenderer as ToolRenderer,
	launch: launchToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	job: jobToolRenderer as ToolRenderer,
	resolve: resolveToolRenderer as ToolRenderer,
	retain: retainToolRenderer as ToolRenderer,
	recall: recallToolRenderer as ToolRenderer,
	reflect: reflectToolRenderer as ToolRenderer,
	search_tool_bm25: searchToolBm25Renderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	// Lazy getter: `taskToolRenderer` lives in a module that closes an import
	// cycle back here (task/renderer → task/render → … → tools/renderers), so
	// reading it at init order-dependently hits its temporal dead zone. Deferring
	// the read to first access (render time) sidesteps the cycle entirely.
	get task(): ToolRenderer {
		return taskToolRenderer as ToolRenderer;
	},
	todo: todoToolRenderer as ToolRenderer,
	set_cwd: setCwdToolRenderer as ToolRenderer,
	github: githubToolRenderer as ToolRenderer,
	// The goal tool describes a view instead of drawing a component, so its entry here is the
	// terminal's drawing of that same view. It exists for the rebuilt transcript of a session that
	// never constructed the tool, which is the one path that cannot read `tool.view`.
	goal: viewToolRenderer(goalToolView, { mergeCallAndResult: true }) as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	vibe_spawn: createVibeToolRenderer("spawn") as ToolRenderer,
	vibe_send: createVibeToolRenderer("send") as ToolRenderer,
	vibe_wait: createVibeToolRenderer("wait") as ToolRenderer,
	vibe_kill: createVibeToolRenderer("kill") as ToolRenderer,
	vibe_list: createVibeToolRenderer("list") as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
};
