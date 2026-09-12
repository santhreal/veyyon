/**
 * WHY: the desktop reaches MCP through two actions only, `RefreshMcp` and
 * `SetMcpEnabled`, and `SetMcpEnabled` carries the whole connection lifecycle:
 * `false` disconnects a running server and `true` connects or reconnects it.
 * The defect class this closes is a lifecycle edge that answers with a stale or
 * fabricated status -- a disable that leaves the server reported as `Connected`,
 * an enable that reports connected without rediscovering the server's tools, or
 * an unknown server that succeeds silently instead of failing closed.
 *
 * The server here is a real stdio MCP process spoken to over JSON-RPC, so
 * `Connected` and the tool list are what the protocol produced, not a fixture.
 * The broken row is a command that cannot spawn, which is the only failure the
 * status enum distinguishes.
 *
 * What it does NOT catch: remote SSE/HTTP transports, and the tool-call path,
 * which the desktop does not drive -- an MCP tool reaches a session as an
 * ordinary tool call through the agent, not through a host action.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { McpServerView } from "../../src/gui-host/wire";
import { MCPManager } from "../../src/mcp/manager";
import { TestSocketClient } from "./test-client";

const ECHO_SERVER = `
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
							properties: { msg: { type: "string" } },
							required: ["msg"],
						},
					},
				],
			},
		};
		process.stdout.write(JSON.stringify(res) + "\\n");
	} else {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
	}
});
rl.on("close", () => process.exit(0));
`;

describe("an mcp server connects, disconnects and reports its tools", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient | null = null;

	const rowOf = (frames: { Snapshot?: { Mcp?: unknown } }[], name: string): McpServerView | undefined => {
		const snapshot = frames.find(frame => frame.Snapshot?.Mcp !== undefined);
		if (!snapshot?.Snapshot?.Mcp) {
			throw new Error("no frame carried an Mcp snapshot section");
		}
		return (snapshot.Snapshot.Mcp as McpServerView[]).find(row => row.name === name);
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-mcp-test-"));
		MCPManager.resetForTests();
		await fs.writeFile(path.join(tempDir, "echo-mcp-server.ts"), ECHO_SERVER, "utf8");
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					broken_server: { command: "nonexistent_command_that_cannot_spawn_binary", args: [] },
					echo_server: { command: "bun", args: [path.join(tempDir, "echo-mcp-server.ts")] },
				},
			}),
			"utf8",
		);
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir });
		client = await TestSocketClient.connect(server.endpoint);
	});

	afterEach(async () => {
		client?.destroy();
		client = null;
		if (server) {
			await server.close();
			server = null;
		}
		MCPManager.resetForTests();
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	test("RefreshMcp reports a spawn failure as Error and a live server as Connected with its tools", async () => {
		const { frames, outcome } = await client!.request(1, "RefreshMcp");
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const echo = rowOf(frames, "echo_server");
		expect(echo?.status).toBe("Connected");
		expect(echo?.enabled).toBeTrue();
		expect(echo?.tools).toEqual(["echo_message"]);

		const broken = rowOf(frames, "broken_server");
		expect(broken?.tools).toEqual([]);
		expect(typeof broken?.status === "object" && broken?.status !== null && "Error" in broken.status).toBeTrue();
	});

	test("SetMcpEnabled false disconnects the server and true brings it back with its tools", async () => {
		await client!.request(1, "RefreshMcp");

		const disabled = await client!.request(2, { SetMcpEnabled: { server: "echo_server", enabled: false } });
		expect(disabled.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(rowOf(disabled.frames, "echo_server")?.status).toBe("Disconnected");

		const enabled = await client!.request(3, { SetMcpEnabled: { server: "echo_server", enabled: true } });
		expect(enabled.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		const reconnected = rowOf(enabled.frames, "echo_server");
		expect(reconnected?.status).toBe("Connected");
		expect(reconnected?.tools).toEqual(["echo_message"]);
	});

	test("SetMcpEnabled fails closed on a server no configuration declares", async () => {
		const { outcome } = await client!.request(2, {
			SetMcpEnabled: { server: "nonexistent_server", enabled: true },
		});
		expect(outcome.RequestFailed?.error.scope).toBe("Mcp");
		expect(outcome.RequestFailed?.error.code).toBe("MCP_SERVER_NOT_FOUND");
	});

	test("SetMcpEnabled without a state to set is rejected rather than guessed", async () => {
		const { outcome } = await client!.request(2, { SetMcpEnabled: { server: "echo_server" } });
		expect(outcome.RequestFailed?.error.scope).toBe("Mcp");
		expect(outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
	});
});
