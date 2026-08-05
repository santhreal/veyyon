import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type EffectiveToolDiscoveryMode,
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_AUTO_THRESHOLD,
} from "@veyyon/coding-agent/tool-discovery/mode";

// ─── Subagent discovery mode inheritance tests ────────────────────────────────
// These are unit-level tests that verify the settings resolution logic
// without needing to spin up a full AgentSession or subagent.
// ─────────────────────────────────────────────────────────────────────────────

describe("effective discovery mode resolution", () => {
	function resolveEffectiveMode(settings: Settings, toolCount = 0): EffectiveToolDiscoveryMode {
		return resolveEffectiveToolDiscoveryMode(settings, toolCount);
	}

	it("tools.discoveryMode=all beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "all", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("all");
	});

	it("tools.discoveryMode=mcp-only beats mcp.discoveryMode=false", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "mcp-only", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=true → mcp-only (back-compat alias)", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": true });
		expect(resolveEffectiveMode(s)).toBe("mcp-only");
	});

	it("tools.discoveryMode=off + mcp.discoveryMode=false → off", () => {
		const s = Settings.isolated({ "tools.discoveryMode": "off", "mcp.discoveryMode": false });
		expect(resolveEffectiveMode(s)).toBe("off");
	});

	/**
	 * Locks in the token-saving default that leaves discovery off for ordinary
	 * catalogs at the auto threshold.
	 */
	it("default auto hides discoverable built-ins at the threshold", () => {
		const s = Settings.isolated({});
		expect(s.get("tools.discoveryMode")).toBe("auto");
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD)).toBe("off");
	});

	/**
	 * Large tool catalogs switch auto to MCP-only so remote schemas can be
	 * discovered without hiding the built-in catalog.
	 */
	it("default auto enables full discovery above the threshold", () => {
		const s = Settings.isolated({});
		expect(resolveEffectiveMode(s, TOOL_DISCOVERY_AUTO_THRESHOLD + 1)).toBe("mcp-only");
	});
});
