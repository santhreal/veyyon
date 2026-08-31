/**
 * How a terminal draws the agent domain's tools.
 *
 * Separate from `./manifest` on purpose: a renderer constructs terminal components, so this module
 * is imported only by a host that draws one.
 *
 * The five vibe rows come from one factory taking the sub-command, which is why they are spelled out
 * here rather than derived: each is a distinct tool name in the same table.
 */
import type { ToolRenderer } from "../renderers";
import { askToolRenderer } from "./ask-render";
import { ircToolRenderer } from "./irc-render";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory-render";
import { resolveToolRenderer } from "./resolve-render";
import { todoToolRenderer } from "./todo-render";
import { createVibeToolRenderer } from "./vibe-render";

export const agentRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	irc: ircToolRenderer as ToolRenderer,
	todo: todoToolRenderer as ToolRenderer,
	resolve: resolveToolRenderer as ToolRenderer,
	retain: retainToolRenderer as ToolRenderer,
	recall: recallToolRenderer as ToolRenderer,
	reflect: reflectToolRenderer as ToolRenderer,
	vibe_spawn: createVibeToolRenderer("spawn") as ToolRenderer,
	vibe_send: createVibeToolRenderer("send") as ToolRenderer,
	vibe_wait: createVibeToolRenderer("wait") as ToolRenderer,
	vibe_kill: createVibeToolRenderer("kill") as ToolRenderer,
	vibe_list: createVibeToolRenderer("list") as ToolRenderer,
};
