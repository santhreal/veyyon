import type { Settings } from "../config/settings";
import { delegationEnabled, resolveSessionMaxNestedSpawnDepth } from "../task/subagent-settings";
import { canSpawnAtDepth } from "../task/types";

/** IRC availability: there must be someone to chat with. True for every subagent (it always has a parent, and possibly siblings) and for any */
export function isIrcEnabled(settings: Settings, taskDepth: number, maxNestedSpawnDepth?: number): boolean {
	if (taskDepth > 0) return true;
	if (!delegationEnabled(settings)) return false;
	// Top-level session: peers exist only if it can still spawn subagents. This
	// reuses the task tool's capacity gate so zero still permits direct children.
	return canSpawnAtDepth(resolveSessionMaxNestedSpawnDepth(settings, maxNestedSpawnDepth), taskDepth);
}
