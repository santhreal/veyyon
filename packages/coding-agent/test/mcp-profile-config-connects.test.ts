/**
 * The positive control for the removal of project-scope MCP discovery.
 *
 * Nothing in a working tree may name an MCP server any more. The whole point of
 * that rule is that the OPERATOR'S own configuration still works, and every test
 * written around the removal is a negative: they prove a file was ignored, which
 * an accidentally broken loader would also satisfy. This one runs the surviving
 * path end to end: a profile-scoped `<agentDir>/mcp.json` is discovered by the
 * `native` provider, survives `loadAllMCPConfigs`, and is actually CONNECTED by
 * `MCPManager.discoverAndConnect`, with its tools registered.
 *
 * `discovery/mcp-profile.test.ts` covers the discovery half (which profile's file
 * is read). This covers the half that matters to a person: the server starts.
 *
 * A real subprocess speaking real JSON-RPC over stdio, not a mock transport: a
 * stubbed connection would pass even if config never reached the runtime, which
 * is exactly the failure this guards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@veyyon/coding-agent/mcp/config";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@veyyon/coding-agent/mcp/startup-events";
import { removeWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";
import { TOOL_NAME } from "./fixtures/instructions-mcp";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const SERVER_NAME = "profile-notes";

describe("a profile-scoped mcp.json is discovered and connected", () => {
	let settingsState: SettingsTestState | undefined;
	let tempHome = "";
	let agentDir = "";
	let projectDir = "";
	const dirOverrides = captureDirOverrides();

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-positive-home-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-positive-agent-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-mcp-positive-project-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(tempHome);
		await removeWithRetries(agentDir);
		await removeWithRetries(projectDir);
	});

	it("connects the server the operator's own config names, and registers its tools", async () => {
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					[SERVER_NAME]: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] },
				},
			}),
		);

		// The loader half: the profile file is the source, and it is the ONLY source.
		const loaded = await loadAllMCPConfigs(projectDir);
		expect(Object.keys(loaded.configs)).toEqual([SERVER_NAME]);
		expect(loaded.sources[SERVER_NAME]?.level).toBe("user");
		expect(loaded.sources[SERVER_NAME]?.path).toBe(path.join(agentDir, "mcp.json"));
		expect(loaded.warnings).toEqual([]);

		// The runtime half: a live subprocess, a completed handshake, real tools.
		const manager = new MCPManager(projectDir);
		const events: McpConnectionStatusEvent[] = [];
		try {
			await manager.discoverAndConnect({ onStatus: event => events.push(event) });

			expect(manager.getConnectedServers()).toContain(SERVER_NAME);
			expect(manager.getConnectionStatus(SERVER_NAME)).toBe("connected");
			expect(manager.getTools().map(tool => tool.mcpToolName)).toContain(TOOL_NAME);
			expect(events.filter(event => event.type === "failed")).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 20_000);
});
