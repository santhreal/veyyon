/**
 * How a terminal draws the agent domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 *
 * The five vibe rows come from one factory taking the sub-command, which is why they are spelled out
 * here rather than derived: each is a distinct tool name in the same table.
 */
import { viewToolRenderer } from "../../tui/draw-tool-view";
import type { ToolRenderer } from "../renderers";
import { askToolView } from "./ask-view";
import { ircToolView } from "./irc-view";
import { recallToolView, reflectToolView, retainToolView } from "./memory-view";
import { resolveToolView } from "./resolve-view";
import { todoToolView } from "./todo-view";
import { createVibeToolRenderer } from "./vibe-render";

export const agentRenderers: Record<string, ToolRenderer> = {
	ask: viewToolRenderer(askToolView, { mergeCallAndResult: true, callIsLiveWidget: true }) as ToolRenderer,
	irc: viewToolRenderer(ircToolView, { inline: true, mergeCallAndResult: true }) as ToolRenderer,
	todo: viewToolRenderer(todoToolView, { mergeCallAndResult: true }) as ToolRenderer,
	resolve: viewToolRenderer(resolveToolView, { mergeCallAndResult: true }) as ToolRenderer,
	retain: viewToolRenderer(retainToolView, { mergeCallAndResult: true }) as ToolRenderer,
	recall: viewToolRenderer(recallToolView, { mergeCallAndResult: true }) as ToolRenderer,
	reflect: viewToolRenderer(reflectToolView, { mergeCallAndResult: true }) as ToolRenderer,
	vibe_spawn: createVibeToolRenderer("spawn") as ToolRenderer,
	vibe_send: createVibeToolRenderer("send") as ToolRenderer,
	vibe_wait: createVibeToolRenderer("wait") as ToolRenderer,
	vibe_kill: createVibeToolRenderer("kill") as ToolRenderer,
	vibe_list: createVibeToolRenderer("list") as ToolRenderer,
};
