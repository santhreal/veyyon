/**
 * How a terminal draws the agent domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 *
 * The five vibe rows come from one factory taking the sub-command, which is why they are spelled out
 * here rather than derived: each is a distinct tool name in the same table, and each states its own
 * animation policy.
 */
import { viewToolRenderer } from "../../tui/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { askToolView } from "./ask-view";
import { ircToolView } from "./irc-view";
import { recallToolView, reflectToolView, retainToolView } from "./memory-view";
import { resolveToolView } from "./resolve-view";
import { todoToolView } from "./todo-view";
import { createVibeToolView } from "./vibe-view";

export const agentRenderers: Record<string, ToolRenderer> = {
	ask: viewToolRenderer(askToolView, { mergeCallAndResult: true, callIsLiveWidget: true }) as ToolRenderer,
	irc: viewToolRenderer(ircToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	todo: viewToolRenderer(todoToolView, { mergeCallAndResult: true }) as ToolRenderer,
	// The resolution plate and the three memory cards draw in the response flow: a plate that fills
	// its own width, and three cards whose rows are one fact each. A card of their own would put a
	// second edge around rows that are already one decision or one line.
	resolve: viewToolRenderer(resolveToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	retain: viewToolRenderer(retainToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	recall: viewToolRenderer(recallToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	reflect: viewToolRenderer(reflectToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	// The composer ops paint a caret that blinks with the frame, so both consume one; only a wait can
	// sit long enough to report progress, which is the one partial result worth animating.
	vibe_spawn: viewToolRenderer(createVibeToolView("spawn"), {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
	}) as ToolRenderer,
	vibe_send: viewToolRenderer(createVibeToolView("send"), {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: true,
	}) as ToolRenderer,
	vibe_wait: viewToolRenderer(createVibeToolView("wait"), {
		inline: true,
		mergeCallAndResult: true,
		animatedPartialResult: true,
	}) as ToolRenderer,
	vibe_kill: viewToolRenderer(createVibeToolView("kill"), {
		inline: true,
		mergeCallAndResult: true,
	}) as ToolRenderer,
	vibe_list: viewToolRenderer(createVibeToolView("list"), {
		inline: true,
		mergeCallAndResult: true,
	}) as ToolRenderer,
};
