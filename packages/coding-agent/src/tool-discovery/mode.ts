import type { Settings } from "../config/settings";
import { type EffectiveToolDiscoveryMode, resolveToolDiscoveryMode } from "../tools/loading";

/**
 * Settings adapter for the discovery-mode rule.
 *
 * The rule itself lives in `tools/loading/policy.ts` with every other tool-loading decision;
 * this file only reads the two settings it needs and hands them over. The signature is
 * unchanged because four call sites and two suites depend on it.
 */
export {
	countToolsForAutoDiscovery,
	type EffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
	TOOL_DISCOVERY_SEARCH_TOOL_NAME,
	type ToolDiscoveryModeSetting,
} from "../tools/loading";

export function resolveEffectiveToolDiscoveryMode(settings: Settings, toolCount: number): EffectiveToolDiscoveryMode {
	return resolveToolDiscoveryMode({
		configuredMode: settings.get("tools.discoveryMode"),
		legacyMcpDiscoveryMode: settings.get("mcp.discoveryMode") === true,
		toolCount,
	});
}
