/**
 * WHY: every `/mcp` subcommand that changes a server has a desktop action,
 * and each must leave the profile in the state the terminal's subcommand
 * leaves it: the same `<agentDir>/mcp.json` written, the same server running
 * or stopped, and the same catalog listed. The defect class this closes is an
 * action that answers from memory instead of the profile: a disable that stops
 * the server but writes nothing, so the next start brings it back; an add or
 * a remove the running manager sees and the file does not; a catalog built
 * before the server was asked what it offers; a reload that lists a new entry
 * without connecting it.
 *
 * Each server is a real stdio process speaking JSON-RPC, so what a row states
 * is what the protocol produced. Remote servers and their logins are pinned by
 * `an-mcp-login-runs-in-the-window-the-way-a-provider-login-does.test.ts`, the
 * Smithery registry by
 * `the-smithery-registry-is-searched-and-signed-into-from-the-window.test.ts`.
 *
 * What it does NOT catch: a server another tool's config declares, which is
 * read from the home directory; disabling one writes the denylist instead of
 * its entry, and no test here seeds such a config.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { McpCatalogView, McpProbeView, McpServerView } from "../../src/gui-host/wire";
import { readMCPConfigFile } from "../../src/mcp/config-writer";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig } from "../../src/mcp/types";
import { PROMPT, RESOURCE, SERVER_INFO, TEMPLATE, TOOL } from "../fixtures/catalog-mcp";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const CATALOG_SERVER = path.join(import.meta.dirname, "..", "fixtures", "catalog-mcp.ts");
const UNSPAWNABLE = "nonexistent_command_that_cannot_spawn_binary";

let root = "";
let agentDir = "";
let authStorage: AuthStorage;
let host: GuiHostServer | undefined;
let client: TestSocketClient | undefined;

async function openHost(): Promise<void> {
	host = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: root, agentDir, authStorage });
	client = await TestSocketClient.connect(host.endpoint);
}

async function closeHost(): Promise<void> {
	client?.destroy();
	client = undefined;
	await host?.close();
	host = undefined;
}

async function succeeds(id: number, action: unknown): Promise<RequestFrame[]> {
	const { frames, outcome } = await client!.request(id, action);
	expect(outcome).toEqual({ RequestSucceeded: { request: id } });
	return frames;
}

/** The code an MCP request failed with. */
async function failsWith(id: number, action: unknown): Promise<string | undefined> {
	const { outcome } = await client!.request(id, action);
	expect(outcome.RequestFailed?.error.scope).toBe("Mcp");
	return outcome.RequestFailed?.error.code;
}

function lastSection<T>(frames: RequestFrame[], section: string): T {
	const value = snapshotSections<T>(frames, section).at(-1);
	if (value === undefined) throw new Error(`no frame carried a ${section} section`);
	return value;
}

function rowOf(frames: RequestFrame[], name: string): McpServerView | undefined {
	return lastSection<McpServerView[]>(frames, "Mcp").find(row => row.name === name);
}

function userConfigPath(): string {
	return path.join(agentDir, "mcp.json");
}

async function profileServers(): Promise<Record<string, MCPServerConfig>> {
	return (await readMCPConfigFile(userConfigPath())).mcpServers ?? {};
}

async function writeProfile(servers: Record<string, MCPServerConfig>): Promise<void> {
	await fs.writeFile(userConfigPath(), JSON.stringify({ mcpServers: servers }), "utf8");
}

const catalogServer: MCPServerConfig = { command: "bun", args: [CATALOG_SERVER] };
const connectedCatalogRow = (name: string): McpServerView => ({
	name,
	enabled: true,
	status: "Connected",
	tools: [TOOL.name],
});

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-mcp-manage-"));
	agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	MCPManager.resetForTests();
	authStorage = await isolatedAuthStorage(root);
	await writeProfile({ catalog: catalogServer, broken: { command: UNSPAWNABLE, args: [] } });
});

afterEach(async () => {
	await closeHost();
	MCPManager.resetForTests();
	authStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

describe("an mcp server is managed from the desktop as the terminal manages it", () => {
	test("disabling a server writes it disabled into the profile, and a host started afterwards leaves it off", async () => {
		await openHost();
		const off = await succeeds(1, { SetMcpEnabled: { server: "catalog", enabled: false } });
		expect(rowOf(off, "catalog")).toEqual({ name: "catalog", enabled: false, status: "Disconnected", tools: [] });
		expect((await profileServers()).catalog?.enabled).toBe(false);

		await closeHost();
		await openHost();
		const restarted = await succeeds(2, "RefreshMcp");
		expect(rowOf(restarted, "catalog")).toEqual({
			name: "catalog",
			enabled: false,
			status: "Disconnected",
			tools: [],
		});

		const on = await succeeds(3, { SetMcpEnabled: { server: "catalog", enabled: true } });
		expect(rowOf(on, "catalog")).toEqual(connectedCatalogRow("catalog"));
		expect((await profileServers()).catalog?.enabled).toBe(true);
	});

	test("a server added from the window is written into the profile and connects with everything it offers", async () => {
		await openHost();
		const added = await succeeds(1, {
			AddMcpServer: { name: "added", target: { Command: { command: "bun", args: [CATALOG_SERVER] } } },
		});
		expect((await profileServers()).added).toMatchObject({ command: "bun", args: [CATALOG_SERVER] });
		expect(rowOf(added, "added")).toEqual(connectedCatalogRow("added"));

		const catalog = lastSection<McpCatalogView>(added, "McpCatalog");
		expect(catalog.notifications).toBe(false);
		expect(catalog.servers.find(view => view.server === "added")).toEqual({
			server: "added",
			resources: [
				{ uri: RESOURCE.uri, name: RESOURCE.name, description: RESOURCE.description, mime_type: RESOURCE.mimeType },
			],
			templates: [{ uri_template: TEMPLATE.uriTemplate, name: TEMPLATE.name, description: TEMPLATE.description }],
			prompts: [
				{
					name: PROMPT.name,
					command: `/added:${PROMPT.name}`,
					description: PROMPT.description,
					arguments: PROMPT.arguments.map(argument => ({ ...argument, required: true })),
				},
			],
			notifies: {
				tools_changed: true,
				resources_changed: true,
				prompts_changed: false,
				offers_resources: true,
				subscribe: true,
			},
			subscriptions: [],
		});
	});

	test("an add that names a configured server or no way to reach one is refused and writes nothing", async () => {
		await openHost();
		const before = await fs.readFile(userConfigPath(), "utf8");
		const command = { Command: { command: "bun", args: [CATALOG_SERVER] } };
		expect(await failsWith(1, { AddMcpServer: { name: "catalog", target: command } })).toBe(
			"MCP_SERVER_NAME_REFUSED",
		);
		expect(await failsWith(2, { AddMcpServer: { name: "bad name", target: command } })).toBe(
			"MCP_SERVER_NAME_REFUSED",
		);
		expect(
			await failsWith(3, { AddMcpServer: { name: "blank", target: { Command: { command: " ", args: [] } } } }),
		).toBe("INVALID_ARGUMENTS");
		expect(await failsWith(4, { AddMcpServer: { name: "remote", target: { Http: { url: "", token: null } } } })).toBe(
			"INVALID_ARGUMENTS",
		);
		expect(await fs.readFile(userConfigPath(), "utf8")).toBe(before);
	});

	test("removing a server deletes it from the profile and stops it", async () => {
		await openHost();
		expect(rowOf(await succeeds(1, "RefreshMcp"), "catalog")).toEqual(connectedCatalogRow("catalog"));

		const removed = await succeeds(2, { RemoveMcpServer: { server: "catalog" } });
		expect(rowOf(removed, "catalog")).toBeUndefined();
		expect(lastSection<McpCatalogView>(removed, "McpCatalog").servers).toEqual([]);
		expect(Object.keys(await profileServers())).toEqual(["broken"]);

		expect(await failsWith(3, { RemoveMcpServer: { server: "catalog" } })).toBe("MCP_SERVER_NOT_FOUND");
	});

	test("testing a server reports what it answered or why it could not connect", async () => {
		await openHost();
		const answered = await succeeds(1, { TestMcpServer: { server: "catalog" } });
		expect(lastSection<McpProbeView>(answered, "McpProbe")).toEqual({
			server: "catalog",
			outcome: { Connected: { name: SERVER_INFO.name, version: SERVER_INFO.version, tools: [TOOL.name] } },
		});

		const refused = await succeeds(2, { TestMcpServer: { server: "broken" } });
		expect(lastSection<McpProbeView>(refused, "McpProbe")).toMatchObject({
			server: "broken",
			outcome: { Failed: { message: expect.any(String) } },
		});

		expect(await failsWith(3, { TestMcpServer: { server: "absent" } })).toBe("MCP_SERVER_NOT_FOUND");
		await succeeds(4, { SetMcpEnabled: { server: "catalog", enabled: false } });
		expect(await failsWith(5, { TestMcpServer: { server: "catalog" } })).toBe("MCP_SERVER_DISABLED");
	});

	test("a reload connects a server another program wrote into the profile", async () => {
		await openHost();
		await succeeds(1, "RefreshMcp");
		await writeProfile({ ...(await profileServers()), late: catalogServer });

		const reloaded = await succeeds(2, "ReloadMcp");
		expect(rowOf(reloaded, "late")).toEqual(connectedCatalogRow("late"));
		expect(rowOf(reloaded, "catalog")).toEqual(connectedCatalogRow("catalog"));
	});

	test("signing a stdio server in again is refused before anything changes", async () => {
		await openHost();
		const before = await fs.readFile(userConfigPath(), "utf8");
		expect(await failsWith(1, { ReauthMcpServer: { server: "catalog" } })).toBe("MCP_REAUTH_UNAVAILABLE");
		expect(await failsWith(2, { ReauthMcpServer: { server: "absent" } })).toBe("MCP_SERVER_NOT_FOUND");
		expect(await fs.readFile(userConfigPath(), "utf8")).toBe(before);
	});
});
