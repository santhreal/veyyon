/**
 * The MCP state every MCP action reads and writes: the one manager the host
 * connects servers through, the profile's own `mcp.json`, and the `Mcp` and
 * `McpCatalog` sections that report both. A repository's `mcp.json` is never
 * read or written here; the only config file an action edits is
 * `<agentDir>/mcp.json`.
 */
import { getMCPConfigPath } from "@veyyon/utils";
import { reset as resetCapabilities } from "../../discovery/capability";
import { listPrompts, listResources, listResourceTemplates } from "../../mcp/client";
import { loadAllMCPConfigs } from "../../mcp/config";
import { addMCPServer, readDisabledServers, readMCPConfigFile, validateServerName } from "../../mcp/config-writer";
import type { PrepareMcpConfig } from "../../mcp/management";
import { MCPManager } from "../../mcp/manager";
import { mcpManagerInstance } from "../../mcp/manager-instance";
import { parseMCPToolName } from "../../mcp/tool-bridge";
import type { MCPServerConfig } from "../../mcp/types";
import { actingSettings } from "../acting-settings";
import { writeFrame } from "../frames";
import type { McpCatalogView, McpServerCatalogView, McpServerStatus, McpServerView, SnapshotSection } from "../wire";
import type { ActionContext } from "./types";

/** A connect that is still discovering, shared so two actions sent together build one manager. */
let pendingManager: Promise<MCPManager> | undefined;
/** The manager an MCP action built and installed, until a session installs its own or the host closes. */
let hostBuilt: MCPManager | undefined;

/**
 * The manager every MCP action acts on. A session installs its own manager
 * when it starts; until then the first MCP action builds one, discovers the
 * configured servers and installs it, so the next action finds the same
 * connections instead of spawning a second set. A host-built manager a
 * session's manager replaced is disconnected here, so its servers do not run
 * twice.
 */
export async function mcpManagerFor(ctx: ActionContext): Promise<MCPManager> {
	const installed = mcpManagerInstance();
	if (installed) {
		if (hostBuilt && installed !== hostBuilt) await releaseHostMcpManager();
		return installed;
	}
	if (pendingManager) return pendingManager;
	pendingManager = (async () => {
		const manager = new MCPManager(ctx.cwd);
		manager.setAuthStorage(await ctx.authStorage());
		// A session's manager subscribes when the setting is on; one the window
		// builds before a session exists acts on the same setting.
		if ((await actingSettings(ctx)).get("mcp.notifications")) manager.setNotificationsEnabled(true);
		try {
			await manager.discoverAndConnect({ agentDir: ctx.agentDir });
		} catch {
			// A config the loader cannot read is recorded as the manager's last error.
		}
		MCPManager.setInstance(manager);
		hostBuilt = manager;
		return manager;
	})();
	try {
		return await pendingManager;
	} finally {
		pendingManager = undefined;
	}
}

/**
 * Disconnect the manager an MCP action built and uninstall it when it is
 * still the installed one. The host calls this when it closes, so a manager
 * built for one host's configs never answers the next host in the process.
 */
export async function releaseHostMcpManager(): Promise<void> {
	const manager = hostBuilt;
	if (!manager) return;
	hostBuilt = undefined;
	if (mcpManagerInstance() === manager) MCPManager.setInstance(undefined);
	await manager.disconnectAll();
}

/** Resolve a config's auth and `${...}` references through `manager`. */
export function preparerFor(manager: MCPManager): PrepareMcpConfig {
	return (config, options) => manager.prepareConfig(config, options);
}

/** The profile's own MCP config file, the only one an action writes. */
export function mcpUserConfigPath(ctx: ActionContext): string {
	return getMCPConfigPath("user", ctx.cwd, ctx.agentDir);
}

/** A server an action can name: where its config came from, and the config itself. */
export interface McpServerEntry {
	config: MCPServerConfig;
	/** True for a server another tool's config declares, absent from the profile's `mcp.json`. */
	discovered: boolean;
}

/**
 * Find `name` in the profile's `mcp.json`, then among the servers the manager
 * discovered. A discovered server's changes are written into the profile's
 * file under the same name, which shadows the discovered entry on reload.
 */
export async function findMcpServer(
	ctx: ActionContext,
	manager: MCPManager,
	name: string,
): Promise<McpServerEntry | undefined> {
	const own = (await readMCPConfigFile(mcpUserConfigPath(ctx))).mcpServers?.[name];
	if (own) return { config: own, discovered: false };
	const config = manager.getServerConfig(name);
	if (config && manager.getSource(name)) return { config, discovered: true };
	return undefined;
}

function toolServerName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	if ("mcpServerName" in tool && typeof tool.mcpServerName === "string") return tool.mcpServerName;
	if ("name" in tool && typeof tool.name === "string") return parseMCPToolName(tool.name)?.serverName;
	return undefined;
}

/** The name the server gave a tool, without the `mcp_<server>_` prefix the session adds. */
function serverToolName(tool: unknown): string {
	if (!tool || typeof tool !== "object") return "";
	if ("mcpToolName" in tool && typeof tool.mcpToolName === "string") return tool.mcpToolName;
	if ("name" in tool && typeof tool.name === "string") return parseMCPToolName(tool.name)?.toolName ?? tool.name;
	return "";
}

/**
 * Every server the profile can see: the ones discovery loaded, the ones the
 * manager holds, the ones the profile's `mcp.json` declares disabled and the
 * discovered ones its denylist disables. A disabled server stays listed with
 * `enabled: false`, so the window can enable it again.
 */
async function buildMcpServerViews(manager: MCPManager, ctx: ActionContext): Promise<McpServerView[]> {
	const userPath = mcpUserConfigPath(ctx);
	const [loaded, own, denied] = await Promise.all([
		loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir }).catch(() => undefined),
		readMCPConfigFile(userPath),
		readDisabledServers(userPath).then(names => new Set(names)),
	]);
	const configured = loaded?.configs ?? {};
	const ownServers = own.mcpServers ?? {};
	const names = new Set([
		...Object.keys(configured),
		...manager.getAllServerNames(),
		...Object.keys(ownServers),
		...denied,
	]);
	const tools = manager.getTools();

	return Array.from(names, name => {
		const config = ownServers[name] ?? manager.getServerConfig(name) ?? configured[name];
		const enabled = !denied.has(name) && config?.enabled !== false;
		const connection = manager.getConnectionStatus(name);
		let status: McpServerStatus;
		if (connection === "connected") status = "Connected";
		else if (connection === "connecting") status = "Connecting";
		else {
			const lastError = enabled ? manager.getLastError(name) : undefined;
			status = lastError ? { Error: { message: lastError } } : "Disconnected";
		}
		const serverTools = tools
			.filter(tool => toolServerName(tool) === name)
			.map(serverToolName)
			.filter(toolName => toolName.length > 0);
		return { name, enabled, status, tools: serverTools };
	});
}

/**
 * What one connected server offers beyond tools. A server connected moments
 * ago may not have been asked yet, since the manager lists resources and
 * prompts after its tools; the lists come from its cache once filled and from
 * the server otherwise, so a catalog sent right after a connect is complete.
 * A list the server fails to answer is empty.
 */
async function catalogOf(
	manager: MCPManager,
	server: string,
	subscribed: ReadonlySet<string> | undefined,
): Promise<McpServerCatalogView | undefined> {
	const connection = manager.getConnection(server);
	if (!connection) return undefined;
	const { capabilities } = connection;
	const [resources, templates, prompts] = await Promise.all([
		listResources(connection).catch(() => []),
		listResourceTemplates(connection).catch(() => []),
		listPrompts(connection).catch(() => []),
	]);
	return {
		server,
		resources: resources.map(resource => ({
			uri: resource.uri,
			name: resource.name,
			description: resource.description ?? null,
			mime_type: resource.mimeType ?? null,
		})),
		templates: templates.map(template => ({
			uri_template: template.uriTemplate,
			name: template.name,
			description: template.description ?? null,
		})),
		prompts: prompts.map(prompt => ({
			name: prompt.name,
			command: `/${server}:${prompt.name}`,
			description: prompt.description ?? null,
			arguments: (prompt.arguments ?? []).map(argument => ({
				name: argument.name,
				description: argument.description ?? null,
				required: argument.required === true,
			})),
		})),
		notifies: {
			tools_changed: capabilities.tools?.listChanged === true,
			resources_changed: capabilities.resources?.listChanged === true,
			prompts_changed: capabilities.prompts?.listChanged === true,
			offers_resources: capabilities.resources !== undefined,
			subscribe: capabilities.resources?.subscribe === true,
		},
		subscriptions: Array.from(subscribed ?? []),
	};
}

/**
 * What each connected server offers beyond tools: its resources, resource
 * templates and prompts, the notifications its capabilities declare, and the
 * resource URIs the host is subscribed to on it.
 */
async function buildMcpCatalogView(manager: MCPManager): Promise<McpCatalogView> {
	const { enabled, subscriptions } = manager.getNotificationState();
	const listed = await Promise.all(
		manager
			.getConnectedServers()
			.map(server => catalogOf(manager, server, enabled ? subscriptions.get(server) : undefined)),
	);
	return { notifications: enabled, servers: listed.filter(view => view !== undefined) };
}

/** The `Mcp` and `McpCatalog` sections as the manager and the profile's config now stand. */
async function mcpSections(ctx: ActionContext, manager: MCPManager): Promise<SnapshotSection[]> {
	const [servers, catalog] = await Promise.all([buildMcpServerViews(manager, ctx), buildMcpCatalogView(manager)]);
	ctx.clientState.revision += 1;
	return [{ Mcp: servers }, { McpCatalog: catalog }];
}

/** Answer the request with the `Mcp` and `McpCatalog` sections. */
export async function replyMcpSections(ctx: ActionContext, manager: MCPManager): Promise<void> {
	for (const section of await mcpSections(ctx, manager)) ctx.reply.snapshot(section);
}

/** Send the `Mcp` and `McpCatalog` sections outside a request, after work the request started finishes. */
export async function publishMcpSections(ctx: ActionContext, manager: MCPManager): Promise<void> {
	for (const section of await mcpSections(ctx, manager)) writeFrame(ctx.socket, { Snapshot: section });
}

/** Rebind this window's session to the manager's current tools, when a session is open. */
export async function refreshSessionMcpTools(ctx: ActionContext, manager: MCPManager): Promise<void> {
	await ctx.clientState.agentSession?.refreshMCPTools(manager.getTools());
}

/**
 * Disconnect every server, re-read every MCP config and connect again. The
 * discovery file cache is dropped first, so a config another program wrote
 * since the last read is read from disk. The credentials a `!command` in a
 * config mints are read again too: nothing else notices that kind of secret
 * rotating, because the cache is keyed by the command text.
 */
export async function reloadMcp(ctx: ActionContext, manager: MCPManager): Promise<void> {
	resetCapabilities();
	manager.invalidateCommandCredentials();
	await manager.disconnectAll();
	await manager.discoverAndConnect({ agentDir: ctx.agentDir });
	await refreshSessionMcpTools(ctx, manager);
}

/**
 * Connect `name` as the MCP configs on disk now declare it, then rebind this
 * window's session to the manager's tools. A server the configs disable or no
 * longer declare stays disconnected.
 */
export async function connectConfiguredServer(ctx: ActionContext, manager: MCPManager, name: string): Promise<void> {
	const { configs, sources } = await loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir });
	const config = configs[name];
	if (config) {
		const source = sources[name];
		await manager.connectServers({ [name]: config }, source ? { [name]: source } : {});
	}
	await refreshSessionMcpTools(ctx, manager);
}

/**
 * Why `name` cannot be added: a name the config writer rejects, or one the
 * profile's `mcp.json` or discovery already holds. Adding over a discovered
 * server would shadow it without saying so.
 */
export async function refuseServerName(
	ctx: ActionContext,
	manager: MCPManager,
	name: string,
): Promise<string | undefined> {
	const invalid = validateServerName(name);
	if (invalid) return invalid;
	const own = (await readMCPConfigFile(mcpUserConfigPath(ctx))).mcpServers ?? {};
	if (Object.hasOwn(own, name) || manager.getSource(name)) {
		return `An MCP server named "${name}" is already configured. Fix: choose another name, or remove the existing server first.`;
	}
	return undefined;
}

/**
 * Write `config` into the profile's `mcp.json` under `name`, connect it, and
 * activate its tools in this window's session: a session keeps its prior MCP
 * tool selection on refresh, so a new server's tools are otherwise registered
 * and never offered to the model.
 */
export async function addServerToProfile(
	ctx: ActionContext,
	manager: MCPManager,
	name: string,
	config: MCPServerConfig,
): Promise<void> {
	await addMCPServer(mcpUserConfigPath(ctx), name, config);
	await connectConfiguredServer(ctx, manager, name);
	const session = ctx.clientState.agentSession;
	if (!session) return;
	const added = manager
		.getTools()
		.filter(tool => toolServerName(tool) === name)
		.map(tool => tool.name)
		.filter(toolName => session.getToolByName(toolName));
	if (added.length === 0) return;
	await session.setActiveToolsByName(Array.from(new Set([...session.getActiveToolNames(), ...added])));
}

/** Fail the request in the `Mcp` scope. Every MCP failure is final until the operator changes something. */
export function failMcp(ctx: ActionContext, code: string, message: string): void {
	ctx.reply.failure({ scope: "Mcp", code, message, retryable: false });
}
