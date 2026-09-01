/**
 * How a terminal draws the shell domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 */
import { viewToolRenderer } from "../../tui/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { bashToolRenderer } from "./bash-render";
import { debugToolView } from "./debug-view";
import { evalToolRenderer } from "./eval-render";
import { jobToolView } from "./job-view";
import type { LaunchRenderArgs } from "./launch";
import { launchToolView } from "./launch-view";
import { sshToolView } from "./ssh-view";

/**
 * Whether the painted call args still carry the streamed raw-JSON buffer, which is the shape that
 * draws the `⏳ SSH: […]` / `$ …` placeholder the first result re-anchors.
 */
function hasStreamedRenderArgs(args: unknown): boolean {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return false;
	return typeof args.__partialJson === "string";
}

export const shellRenderers: Record<string, ToolRenderer> = {
	bash: bashToolRenderer as ToolRenderer,
	// Only an op that can sit produces a partial result worth animating: list, describe, stop, restart
	// and send answer in one round trip, and a spinner over those is motion with nothing behind it.
	launch: viewToolRenderer(launchToolView, {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
		animatedPartialResult: args => {
			const op = (args as LaunchRenderArgs).op;
			return op === "start" || op === "logs" || op === "wait";
		},
	}) as ToolRenderer,
	// One row per background job under a row that reports the set, drawn in the response flow: the
	// card is a snapshot of what is still going rather than a panel of output.
	job: viewToolRenderer(jobToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	debug: viewToolRenderer(debugToolView, {
		mergeCallAndResult: true,
		animatedPartialResult: true,
	}) as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	// The streamed placeholder (`⏳ SSH: […]` / `$ …`) is re-anchored by the first result rather than
	// preserved by it, and the provisional pending frame settles into the final one, so both shape
	// changes ask for a viewport replay; painting the placeholder consumes a spinner frame.
	ssh: viewToolRenderer(sshToolView, {
		mergeCallAndResult: true,
		animatedPendingPreview: true,
		forceFirstResultViewportRepaint: hasStreamedRenderArgs,
		forceResultViewportRepaintOnSettle: true,
	}) as ToolRenderer,
};
