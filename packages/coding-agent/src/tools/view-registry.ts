/**
 * Canonical terminal-independent registry of pure tool view definitions and presentation policies.
 *
 * This module is host-agnostic: it imports pure {@link ToolViewRenderer} definitions and
 * presentation policies without pulling in `@veyyon/tui`, terminal themes, or component runtimes.
 * Presentation producers and terminal renderer adapters both derive their cards from this single
 * source of truth.
 */
import type { ToolViewRenderer } from "@veyyon/view";
import { editToolView } from "../edit/edit-view";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolView } from "../goals/goal-view";
import { lspToolView } from "../lsp/view";
import { taskToolView } from "../task/task-view";
import { askToolView } from "./agent/ask-view";
import { ircToolView } from "./agent/irc-view";
import { recallToolView, reflectToolView, retainToolView } from "./agent/memory-view";
import { resolveToolView } from "./agent/resolve-view";
import { todoToolView } from "./agent/todo-view";
import { createVibeToolView } from "./agent/vibe-view";
import { inspectImageToolView } from "./fs/inspect-image-view";
import { readToolView } from "./fs/read-view";
import { setCwdToolView } from "./fs/set-cwd-view";
import { writeContentExceedsStreamingWindow, writeToolView } from "./fs/write-view";
import { astEditToolView } from "./search/ast-edit-view";
import { searchToolBm25ToolView } from "./search/search-tool-bm25-view";
import { searchToolView } from "./search/search-view";
import { bashToolView } from "./shell/bash-view";
import { debugToolView } from "./shell/debug-view";
import { evalToolView } from "./shell/eval-view";
import { jobToolView } from "./shell/job-view";
import type { LaunchRenderArgs } from "./shell/launch";
import { launchToolView } from "./shell/launch-view";
import { sshToolView } from "./shell/ssh-view";
import { browserToolView } from "./web/browser/view";
import { githubToolView } from "./web/gh-view";
import { webSearchToolView } from "./web/search/view";

/**
 * Per-renderer opt-in for a full viewport replay when the first result
 * replaces a painted pending-call render. A predicate receives the painted
 * call args and render options so the repaint stays scoped to the pending
 * shapes that actually re-anchor (an over-eager replay wipes native
 * scrollback on direct terminals).
 */
export type FirstResultViewportRepaint = boolean | ((args: unknown, options: RenderResultOptions) => boolean);

/**
 * Terminal-independent tool presentation policy and pure view descriptor.
 */
export interface ToolViewDefinition<Args = never, Result = never> {
	/**
	 * The host-agnostic pure view renderer describing the card.
	 */
	view: Required<ToolViewRenderer<Args, Result>>;
	/**
	 * Whether the result render replaces the call preview row rather than
	 * painting both one under the other.
	 */
	mergeCallAndResult?: boolean;
	/**
	 * Whether the call render IS an interactive widget rather than a preview of one.
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
	 * full viewport repaint.
	 */
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;
	/**
	 * Whether settling a provisional partial result into the final render requires
	 * a full viewport repaint.
	 */
	forceResultViewportRepaintOnSettle?: boolean;
}

/**
 * Whether the painted call args still carry the streamed raw-JSON buffer, which is the shape that
 * draws the `⏳ SSH: […]` / `$ …` placeholder the first result re-anchors.
 */
function hasStreamedRenderArgs(args: unknown): boolean {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return false;
	return typeof args.__partialJson === "string";
}

/** Whether the call is the action whose card grows as the script arrives. */
function isRunAction(args: unknown): boolean {
	return (args as { action?: unknown } | undefined)?.action === "run";
}

export const fsViewDefinitions: Record<string, ToolViewDefinition> = {
	read: {
		view: readToolView,
		mergeCallAndResult: true,
	},
	write: {
		view: writeToolView,
		mergeCallAndResult: true,
		// The collapsed pending preview follows the streaming edge with a tail window once the content
		// outgrows it; the first partial result re-anchors the frame to the top of the file, so tail
		// rows already committed to viewport/native scrollback would survive as stale content above
		// the new frame without a full replay. Expanded and short previews stay top-anchored and skip
		// the (scrollback-wiping) reset.
		forceFirstResultViewportRepaint: (args, options) => !options.expanded && writeContentExceedsStreamingWindow(args),
	},
	set_cwd: {
		view: setCwdToolView,
	},
	inspect_image: {
		view: inspectImageToolView,
		mergeCallAndResult: true,
	},
};

export const searchViewDefinitions: Record<string, ToolViewDefinition> = {
	search: {
		view: searchToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	ast_edit: {
		view: astEditToolView,
		mergeCallAndResult: true,
		inline: true,
	},
	search_tool_bm25: {
		view: searchToolBm25ToolView,
		mergeCallAndResult: true,
		inline: true,
	},
};

export const shellViewDefinitions: Record<string, ToolViewDefinition> = {
	// The card opens on the command it ran, drawn in the response flow: a header would say "Bash"
	// over `$ ls`. Neither the preview nor a still-arriving output consumes a spinner frame — the
	// command and its bytes are the whole card, and the motion a live block carries is the rail's
	// own repaint in `tool-execution.ts`, which needs no declaration here.
	bash: {
		view: bashToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	// Only an op that can sit produces a partial result worth animating: list, describe, stop, restart
	// and send answer in one round trip, and a spinner over those is motion with nothing behind it.
	launch: {
		view: launchToolView,
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
		animatedPartialResult: args => {
			const op = (args as LaunchRenderArgs).op;
			return op === "start" || op === "logs" || op === "wait";
		},
	},
	// One row per background job under a row that reports the set, drawn in the response flow: the
	// card is a snapshot of what is still going rather than a panel of output.
	job: {
		view: jobToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	// A debug card is a stack, a frame list or a variable set drawn in the response flow: its rows are
	// the state a step landed in, not a panel. The partial result animates because a launch, a step
	// and a continue all sit while the adapter answers.
	debug: {
		view: debugToolView,
		inline: true,
		mergeCallAndResult: true,
		animatedPartialResult: true,
	},
	// A cell is still being written while its code streams and while it runs, so both the preview and
	// the partial result animate; the card is inline, because a cell's output belongs under the code
	// that produced it rather than in a card of its own.
	eval: {
		view: evalToolView,
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
		animatedPartialResult: true,
	},
	// The streamed placeholder (`⏳ SSH: […]` / `$ …`) is re-anchored by the first result rather than
	// preserved by it, and the provisional pending frame settles into the final one, so both shape
	// changes ask for a viewport replay; painting the placeholder consumes a spinner frame.
	ssh: {
		view: sshToolView,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
		forceFirstResultViewportRepaint: hasStreamedRenderArgs,
		forceResultViewportRepaintOnSettle: true,
	},
};

export const webViewDefinitions: Record<string, ToolViewDefinition> = {
	// A `run` card is the only one that animates: it streams the script and then the output, where
	// `open` and `close` are one row that either happened or did not.
	browser: {
		view: browserToolView,
		mergeCallAndResult: true,
		inline: true,
		animatedPendingPreview: isRunAction,
		animatedPartialResult: isRunAction,
	},
	// No animatedPendingPreview: the pending row is materialized once per display rebuild rather than
	// from a render closure, so a live spinner interval would ask for 30fps repaints while the visible
	// glyph stayed frozen.
	github: {
		view: githubToolView,
		mergeCallAndResult: true,
	},
};

export const agentViewDefinitions: Record<string, ToolViewDefinition> = {
	ask: {
		view: askToolView,
		mergeCallAndResult: true,
		callIsLiveWidget: true,
	},
	irc: {
		view: ircToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	todo: {
		view: todoToolView,
		mergeCallAndResult: true,
	},
	// The resolution plate and the three memory cards draw in the response flow: a plate that fills
	// its own width, and three cards whose rows are one fact each. A card of their own would put a
	// second edge around rows that are already one decision or one line.
	resolve: {
		view: resolveToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	retain: {
		view: retainToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	recall: {
		view: recallToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	reflect: {
		view: reflectToolView,
		inline: true,
		mergeCallAndResult: true,
	},
	// The composer ops paint a caret that blinks with the frame, so both consume one; only a wait can
	// sit long enough to report progress, which is the one partial result worth animating.
	vibe_spawn: {
		view: createVibeToolView("spawn"),
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
	},
	vibe_send: {
		view: createVibeToolView("send"),
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
	},
	vibe_wait: {
		view: createVibeToolView("wait"),
		inline: true,
		mergeCallAndResult: true,
		animatedPartialResult: true,
	},
	vibe_kill: {
		view: createVibeToolView("kill"),
		inline: true,
		mergeCallAndResult: true,
	},
	vibe_list: {
		view: createVibeToolView("list"),
		inline: true,
		mergeCallAndResult: true,
	},
};

// One object under both names: `apply_patch` is the provider-side spelling of `edit`, and a host
// that groups by renderer identity (streamed-arg keys, the first-result replay) treats them as the
// same card. Two wrappers around the same view would be two objects and split that grouping.
const editViewDefinition: ToolViewDefinition = {
	view: editToolView,
	mergeCallAndResult: true,
};

export const toolViewDefinitions: Record<string, ToolViewDefinition> = {
	...fsViewDefinitions,
	...searchViewDefinitions,
	...shellViewDefinitions,
	...webViewDefinitions,
	...agentViewDefinitions,
	edit: editViewDefinition,
	apply_patch: editViewDefinition,
	// The lsp tool describes a view, and this entry is the terminal's drawing of it — the path a
	// rebuilt transcript takes, where no tool instance exists to read `tool.view` from.
	lsp: {
		view: lspToolView,
		mergeCallAndResult: true,
		inline: true,
	},
	// The task tool describes a view, and this entry is the terminal's drawing of it. The lazy getter
	// that used to stand here worked around an import cycle through `task/render.ts`, which drew the
	// card with the terminal engine and reached back into this table; a view imports neither.
	task: {
		view: taskToolView,
		mergeCallAndResult: true,
	},
	// The goal tool describes a view instead of drawing a component, so its entry here is the
	// terminal's drawing of that same view. It exists for the rebuilt transcript of a session that
	// never constructed the tool, which is the one path that cannot read `tool.view`.
	goal: {
		view: goalToolView,
		mergeCallAndResult: true,
	},
	web_search: {
		view: webSearchToolView,
		mergeCallAndResult: true,
	},
};
