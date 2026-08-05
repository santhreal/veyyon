import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@veyyon/coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@veyyon/coding-agent/mcp/startup-events";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import { removeSyncWithRetries } from "@veyyon/utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCPManager connection status events", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-mcp-status-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("emits connecting, connected, and failed updates for startup status", async () => {
		const manager = new MCPManager(workDir);
		const events: McpConnectionStatusEvent[] = [];
		const success: MCPServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
		};
		const invalid: MCPServerConfig = { type: "stdio", command: "" };

		try {
			const result = await manager.connectServers({ alpha: success, broken: invalid }, {}, event =>
				events.push(event),
			);

			expect(result.connectedServers).toContain("alpha");
			expect(result.errors.get("broken")).toBe(
				'Server "broken" is a stdio server with no "command" to spawn. Fix: add the executable, for example ' +
					'`"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]`. ' +
					'If this is a remote server, set `"type": "http"` and give it a "url" instead.',
			);
			expect(events).toEqual([
				{ type: "connecting", serverNames: ["alpha", "broken"] },
				{
					type: "failed",
					serverName: "broken",
					error:
						'Server "broken" is a stdio server with no "command" to spawn. Fix: add the executable, for example ' +
						'`"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]`. ' +
						'If this is a remote server, set `"type": "http"` and give it a "url" instead.',
					// A server from veyyon's own config — not imported from another tool.
					foreign: false,
				},
				{ type: "connected", serverName: "alpha" },
			]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
