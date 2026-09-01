/**
 * WHY:
 *
 * Model Context Protocol (MCP) server lifecycle actions (RefreshMcp, ConnectMcp,
 * DisconnectMcp, SetMcpEnabled, CallMcpTool) must manage MCP client connections,
 * surface actual server connection errors or connected tool definitions, and execute
 * tools through the MCP manager returning typed `McpToolResult` sections.
 * Before this, MCP actions were shallow stubs that returned empty tool results,
 * ignored server statuses, and failed to execute real stdio MCP tools.
 *
 * This suite defends:
 * 1. `RefreshMcp` discovers MCP servers from configuration, reporting `{ Error: { message } }`
 *    for failing/nonexistent server commands and `Connected` plus tool lists for working servers.
 * 2. `CallMcpTool` executes a tool on a connected MCP server and delivers `McpToolResult`
 *    with joined content blocks and proper error flags.
 * 3. `DisconnectMcp` and `ConnectMcp` update connection states and emit refreshed `Mcp` sections.
 * 4. `SetMcpEnabled` enables/disables server configurations and reflects status changes.
 * 5. Unknown servers or tools fail closed with `MCP_SERVER_NOT_FOUND` or `TOOL_NOT_FOUND`
 *    in scope `Mcp`.
 *
 * What it does NOT catch: Network transport edge cases for remote SSE/HTTP MCP endpoints.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { McpServerView, McpToolResultView } from "../../src/gui-host/wire";
import { MCPManager } from "../../src/mcp/manager";
import { TestSocketClient } from "./test-client";

describe("mcp server lifecycle and tool execution gui-host behaviour", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-mcp-test-"));
		MCPManager.resetForTests();
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		MCPManager.resetForTests();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup error
		}
	});

	test("RefreshMcp reports Error for broken server and Connected with tools for working server, and CallMcpTool executes", async () => {
		// 1. Create a working stdio MCP server script in tempDir
		const serverScriptPath = path.join(tempDir, "echo-mcp-server.ts");
		const serverScriptContent = `
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (msg.id === undefined || msg.id === null) return;

	if (msg.method === "initialize") {
		const res = {
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "echo-server", version: "1.0.0" },
			},
		};
		process.stdout.write(JSON.stringify(res) + "\\n");
	} else if (msg.method === "tools/list") {
		const res = {
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				tools: [
					{
						name: "echo_message",
						description: "Echoes the input message",
						inputSchema: {
							type: "object",
							properties: {
								msg: { type: "string" },
							},
							required: ["msg"],
						},
					},
				],
			},
		};
		process.stdout.write(JSON.stringify(res) + "\\n");
	} else if (msg.method === "tools/call") {
		const textArg = msg.params?.arguments?.msg ?? "no message";
		const res = {
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				content: [{ type: "text", text: "Echoed: " + textArg }],
				isError: false,
			},
		};
		process.stdout.write(JSON.stringify(res) + "\\n");
	} else {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
	}
});
rl.on("close", () => process.exit(0));
`;
		await fs.writeFile(serverScriptPath, serverScriptContent, "utf8");

		// 2. Create mcp.json in user agentDir
		const mcpConfigPath = path.join(tempDir, "mcp.json");
		const mcpConfig = {
			mcpServers: {
				broken_server: {
					command: "nonexistent_command_that_cannot_spawn_binary",
					args: [],
				},
				echo_server: {
					command: "bun",
					args: [serverScriptPath],
				},
			},
		};
		await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");

		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// 3. RefreshMcp
		const { frames: refreshFrames, outcome: refreshOutcome } = await client.request(1, "RefreshMcp");
		expect(refreshOutcome).toEqual({ RequestSucceeded: { request: 1 } });

		const mcpSnap = refreshFrames.find(f => f.Snapshot?.Mcp !== undefined);
		expect(mcpSnap).toBeDefined();
		const serverViews = mcpSnap!.Snapshot!.Mcp as McpServerView[];
		expect(Array.isArray(serverViews)).toBeTrue();

		const echoServer = serverViews.find(s => s.name === "echo_server");
		expect(echoServer).toBeDefined();
		expect(echoServer!.status).toBe("Connected");
		expect(echoServer!.enabled).toBeTrue();
		expect(echoServer!.tools).toEqual(["echo_message"]);

		const brokenServer = serverViews.find(s => s.name === "broken_server");
		expect(brokenServer).toBeDefined();
		expect(brokenServer!.tools).toEqual([]);
		expect(typeof brokenServer!.status === "object" && "Error" in brokenServer!.status).toBeTrue();

		// 4. CallMcpTool
		const { frames: toolFrames, outcome: toolOutcome } = await client.request(2, {
			CallMcpTool: {
				server: "echo_server",
				tool: "echo_message",
				arguments: { msg: "Hello from test suite" },
			},
		});

		expect(toolOutcome).toEqual({ RequestSucceeded: { request: 2 } });
		const toolResultSnap = toolFrames.find(f => f.Snapshot?.McpToolResult !== undefined);
		expect(toolResultSnap).toBeDefined();
		const toolResult = toolResultSnap!.Snapshot!.McpToolResult as McpToolResultView;
		expect(toolResult.server).toBe("echo_server");
		expect(toolResult.tool).toBe("echo_message");
		expect(toolResult.is_error).toBeFalse();
		expect(toolResult.output).toBe("Echoed: Hello from test suite");

		// 5. DisconnectMcp
		const { frames: disconnectFrames, outcome: disconnectOutcome } = await client.request(3, {
			DisconnectMcp: {
				server: "echo_server",
			},
		});
		expect(disconnectOutcome).toEqual({ RequestSucceeded: { request: 3 } });
		const disconnectSnap = disconnectFrames.find(f => f.Snapshot?.Mcp !== undefined);
		const disconnectedServers = disconnectSnap!.Snapshot!.Mcp as McpServerView[];
		const disconnectedEcho = disconnectedServers.find(s => s.name === "echo_server");
		expect(disconnectedEcho!.status).toBe("Disconnected");

		// 6. ConnectMcp
		const { frames: connectFrames, outcome: connectOutcome } = await client.request(4, {
			ConnectMcp: {
				server: "echo_server",
			},
		});
		expect(connectOutcome).toEqual({ RequestSucceeded: { request: 4 } });
		const connectSnap = connectFrames.find(f => f.Snapshot?.Mcp !== undefined);
		const connectedServers = connectSnap!.Snapshot!.Mcp as McpServerView[];
		const reconnectedEcho = connectedServers.find(s => s.name === "echo_server");
		expect(reconnectedEcho!.status).toBe("Connected");

		// 7. SetMcpEnabled false
		const { frames: disableFrames, outcome: disableOutcome } = await client.request(5, {
			SetMcpEnabled: {
				server: "echo_server",
				enabled: false,
			},
		});
		expect(disableOutcome).toEqual({ RequestSucceeded: { request: 5 } });
		const disableSnap = disableFrames.find(f => f.Snapshot?.Mcp !== undefined);
		const disabledServers = disableSnap!.Snapshot!.Mcp as McpServerView[];
		const disabledEcho = disabledServers.find(s => s.name === "echo_server");
		expect(disabledEcho!.status).toBe("Disconnected");

		// 8. Call tool on unknown server fails with MCP_SERVER_NOT_FOUND
		const { outcome: unknownServerOutcome } = await client.request(6, {
			CallMcpTool: {
				server: "nonexistent_server",
				tool: "echo_message",
			},
		});
		expect(unknownServerOutcome.RequestFailed).toBeDefined();
		expect(unknownServerOutcome.RequestFailed!.error.scope).toBe("Mcp");
		expect(unknownServerOutcome.RequestFailed!.error.code).toBe("MCP_SERVER_NOT_FOUND");

		// 9. Call unknown tool on known server fails with TOOL_NOT_FOUND
		const { outcome: unknownToolOutcome } = await client.request(7, {
			CallMcpTool: {
				server: "echo_server",
				tool: "nonexistent_tool",
			},
		});
		expect(unknownToolOutcome.RequestFailed).toBeDefined();
		expect(unknownToolOutcome.RequestFailed!.error.scope).toBe("Mcp");
		expect(unknownToolOutcome.RequestFailed!.error.code).toBe("TOOL_NOT_FOUND");

		client.destroy();
	});
});
