import type { Settings } from "../config/settings";
import { delegationEnabled, resolveSessionMaxNestedSpawnDepth } from "../task/subagent-settings";
import { canSpawnAtDepth } from "../task/types";

/**
 * IRC availability: there must be someone to chat with. True for every
 * subagent (it always has a parent, and possibly siblings) and for any
 * session that can still spawn subagents through the task tool. Only a
 * top-level session with task spawning unavailable has no peers — no irc.
 *
 * Lives outside `./irc` so the tool registry and sdk can gate the tool
 * without loading the full IRC implementation at boot.
 */
export function isIrcEnabled(settings: Settings, taskDepth: number, maxNestedSpawnDepth?: number): boolean {
	if (taskDepth > 0) return true;
	if (!delegationEnabled(settings)) return false;
	// Top-level session: peers exist only if it can still spawn subagents. This
	// reuses the task tool's capacity gate so zero still permits direct children.
	return canSpawnAtDepth(resolveSessionMaxNestedSpawnDepth(settings, maxNestedSpawnDepth), taskDepth);
}
