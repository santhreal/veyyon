/**
 * The MCP server actions: listing, enabling, adding, removing, testing,
 * clearing a login and reloading. Every write lands in the profile's own
 * `mcp.json`, the file the terminal's `/mcp` edits, so a change made in either
 * host is the other's next read.
 */
import { errorMessage } from "@veyyon/utils";
import { loadAllMCPConfigs } from "../../mcp/config";
import {
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import {
	clearMcpServerAuth,
	persistOAuthResult,
	planMcpAddOAuth,
	probeMcpAddAuth,
	probeMcpServer,
	testMcpConnection,
} from "../../mcp/management";
import type { MCPServerConfig } from "../../mcp/types";
import { buildMcpServerConfig } from "../../slash-commands/helpers/mcp-args";
import type { McpProbeOutcome, McpServerTarget } from "../wire";
import { authFlowBusyMessage, mcpAuthActionHandlers, startMcpLogin } from "./mcp-auth";
import { mcpRegistryActionHandlers } from "./mcp-registry";
import {
	addServerToProfile,
	connectConfiguredServer,
	failMcp,
	findMcpServer,
	mcpManagerFor,
	mcpUserConfigPath,
	preparerFor,
	publishMcpSections,
	refreshSessionMcpTools,
	refuseServerName,
	reloadMcp,
	replyMcpSections,
} from "./mcp-runtime";
import type { ActionHandler, ActionHandlersMap } from "./types";

const handleRefreshMcp: ActionHandler = async ctx => {
	try {
		await replyMcpSections(ctx, await mcpManagerFor(ctx));
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_REFRESH_FAILED", errorMessage(error));
	}
};

interface SetMcpEnabledPayload {
	server?: string;
	enabled?: boolean;
}

/**
 * Enable or disable a server and write the choice into the profile's
 * `mcp.json`: `enabled` on the profile's own entry, the denylist for a server
 * another tool's config declares. A server enabled while connected is
 * reconnected, which is the terminal's `/mcp reconnect`.
 */
const handleSetMcpEnabled: ActionHandler<SetMcpEnabledPayload | undefined> = async (ctx, payload) => {
	const name = payload?.server;
	const enabled = payload?.enabled;
	if (!name || enabled === undefined) {
		failMcp(ctx, "INVALID_ARGUMENTS", "SetMcpEnabled requires server and enabled parameters");
		return;
	}
	try {
		const manager = await mcpManagerFor(ctx);
		const userPath = mcpUserConfigPath(ctx);
		const own = (await readMCPConfigFile(userPath)).mcpServers?.[name];
		if (own) {
			if ((own.enabled ?? true) !== enabled) await updateMCPServer(userPath, name, { ...own, enabled });
		} else {
			const denied = (await readDisabledServers(userPath)).includes(name);
			const discovered =
				manager.getServerConfig(name) !== undefined ||
				(await loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir })).configs[name] !== undefined;
			if (!discovered && !denied) {
				failMcp(ctx, "MCP_SERVER_NOT_FOUND", `MCP server '${name}' not found`);
				return;
			}
			if (denied === enabled) await setServerDisabled(userPath, name, !enabled);
		}
		if (!enabled) {
			await manager.disconnectServer(name);
			await refreshSessionMcpTools(ctx, manager);
		} else if (manager.getConnectionStatus(name) === "disconnected") {
			await connectConfiguredServer(ctx, manager, name);
		} else {
			await manager.reconnectServer(name, { manual: true });
			await refreshSessionMcpTools(ctx, manager);
		}
		await replyMcpSections(ctx, manager);
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_ENABLE_TOGGLE_FAILED", errorMessage(error));
	}
};

interface AddMcpServerPayload {
	name?: string;
	target?: McpServerTarget;
}

/** The config a target describes, through the parser `/mcp add` uses. */
function configForTarget(target: McpServerTarget): MCPServerConfig | undefined {
	if ("Command" in target) {
		const { command, args } = target.Command;
		if (!command.trim()) return undefined;
		return buildMcpServerConfig({ transport: "http", commandTokens: [command, ...args] });
	}
	const { url, token } = "Http" in target ? target.Http : target.Sse;
	return buildMcpServerConfig({
		transport: "Http" in target ? "http" : "sse",
		url: url.trim() || undefined,
		authToken: token?.trim() || undefined,
	});
}

/**
 * Add a server to the profile. A remote server without a token is probed
 * first: one that wants OAuth is added once its login completes, one that
 * wants a login it does not advertise is refused, and one that fails for
 * another reason is added and reports the failure as its status. A token is
 * tested before the server is written, so a rejected token adds nothing.
 */
const handleAddMcpServer: ActionHandler<AddMcpServerPayload | undefined> = async (ctx, payload) => {
	const name = payload?.name?.trim();
	const config = payload?.target ? configForTarget(payload.target) : undefined;
	if (!name || !config) {
		failMcp(ctx, "INVALID_ARGUMENTS", "AddMcpServer requires a name and a command or URL to reach the server");
		return;
	}
	try {
		const manager = await mcpManagerFor(ctx);
		const refusal = await refuseServerName(ctx, manager, name);
		if (refusal) {
			failMcp(ctx, "MCP_SERVER_NAME_REFUSED", refusal);
			return;
		}
		const prepare = preparerFor(manager);
		if (config.type === "http" || config.type === "sse") {
			if (config.headers?.Authorization) {
				try {
					await testMcpConnection(prepare, config);
				} catch (error) {
					failMcp(ctx, "MCP_AUTH_FAILED", `The server '${name}' rejected the token: ${errorMessage(error)}`);
					return;
				}
			} else {
				const probe = await probeMcpAddAuth(prepare, config);
				if (probe.outcome === "undiscoverable") {
					failMcp(
						ctx,
						"MCP_AUTH_UNDISCOVERABLE",
						`The server '${name}' requires authentication and advertises no OAuth endpoints. Fix: add it with a token.`,
					);
					return;
				}
				if (probe.outcome === "oauth") {
					const plan = planMcpAddOAuth(probe.endpoints, config);
					const started = startMcpLogin(ctx, name, plan.flow, async result => {
						await addServerToProfile(ctx, manager, name, persistOAuthResult(config, result, plan.persist));
						await publishMcpSections(ctx, manager);
					});
					if (!started) {
						failMcp(ctx, "AUTH_FLOW_IN_PROGRESS", authFlowBusyMessage(ctx));
						return;
					}
					ctx.reply.success();
					return;
				}
			}
		}
		await addServerToProfile(ctx, manager, name, config);
		await replyMcpSections(ctx, manager);
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_ADD_FAILED", errorMessage(error));
	}
};

interface McpServerPayload {
	server?: string;
}

/**
 * Delete a server from the profile's `mcp.json` and disconnect it. A server
 * another tool's config declares is not the profile's to delete; it is
 * disabled instead. A discovered server the deleted entry shadowed connects
 * in its place.
 */
const handleRemoveMcpServer: ActionHandler<McpServerPayload | undefined> = async (ctx, payload) => {
	const name = payload?.server;
	if (!name) {
		failMcp(ctx, "INVALID_ARGUMENTS", "RemoveMcpServer requires a server parameter");
		return;
	}
	try {
		const manager = await mcpManagerFor(ctx);
		const userPath = mcpUserConfigPath(ctx);
		if (!(await readMCPConfigFile(userPath)).mcpServers?.[name]) {
			const source = manager.getSource(name);
			if (source) {
				failMcp(
					ctx,
					"MCP_SERVER_NOT_REMOVABLE",
					`MCP server '${name}' is declared by ${source.providerName} (${source.path}), not by this profile's mcp.json. Fix: disable it instead.`,
				);
			} else {
				failMcp(ctx, "MCP_SERVER_NOT_FOUND", `MCP server '${name}' not found`);
			}
			return;
		}
		await manager.disconnectServer(name);
		await removeMCPServer(userPath, name);
		await connectConfiguredServer(ctx, manager, name);
		await replyMcpSections(ctx, manager);
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_REMOVE_FAILED", errorMessage(error));
	}
};

/**
 * Connect to a server once and list its tools, leaving its running connection
 * as it was. A connection that fails is the probe's outcome, not the request's
 * failure; the request fails only for a server it cannot name.
 */
const handleTestMcpServer: ActionHandler<McpServerPayload | undefined> = async (ctx, payload) => {
	const name = payload?.server;
	if (!name) {
		failMcp(ctx, "INVALID_ARGUMENTS", "TestMcpServer requires a server parameter");
		return;
	}
	const manager = await mcpManagerFor(ctx);
	const entry = await findMcpServer(ctx, manager, name);
	if (!entry) {
		failMcp(ctx, "MCP_SERVER_NOT_FOUND", `MCP server '${name}' not found`);
		return;
	}
	if (entry.config.enabled === false) {
		failMcp(ctx, "MCP_SERVER_DISABLED", `MCP server '${name}' is disabled. Fix: enable it, then test it.`);
		return;
	}
	let outcome: McpProbeOutcome;
	try {
		const probe = await probeMcpServer(preparerFor(manager), name, entry.config);
		outcome = { Connected: { name: probe.serverName, version: probe.serverVersion, tools: probe.tools } };
	} catch (error) {
		outcome = { Failed: { message: errorMessage(error) } };
	}
	ctx.reply.snapshot({ McpProbe: { server: name, outcome } });
	ctx.reply.success();
};

/**
 * Delete a server's stored OAuth credentials and the `auth` block pointing at
 * them, then reconnect it signed out. A discovered server's config is another
 * tool's file and is left as it is, so one with no stored login fails the
 * request, and the window can say there was nothing to delete.
 */
const handleClearMcpServerAuth: ActionHandler<McpServerPayload | undefined> = async (ctx, payload) => {
	const name = payload?.server;
	if (!name) {
		failMcp(ctx, "INVALID_ARGUMENTS", "ClearMcpServerAuth requires a server parameter");
		return;
	}
	try {
		const manager = await mcpManagerFor(ctx);
		const entry = await findMcpServer(ctx, manager, name);
		if (!entry) {
			failMcp(ctx, "MCP_SERVER_NOT_FOUND", `MCP server '${name}' not found`);
			return;
		}
		const cleared = await clearMcpServerAuth(await ctx.authStorage(), entry, mcpUserConfigPath(ctx), name);
		if (!cleared) {
			failMcp(ctx, "MCP_NO_STORED_AUTH", `MCP server '${name}' has no stored OAuth login to delete`);
			return;
		}
		await manager.disconnectServer(name);
		await connectConfiguredServer(ctx, manager, name);
		await replyMcpSections(ctx, manager);
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_CLEAR_AUTH_FAILED", errorMessage(error));
	}
};

const handleReloadMcp: ActionHandler = async ctx => {
	try {
		const manager = await mcpManagerFor(ctx);
		await reloadMcp(ctx, manager);
		await replyMcpSections(ctx, manager);
		ctx.reply.success();
	} catch (error) {
		failMcp(ctx, "MCP_RELOAD_FAILED", errorMessage(error));
	}
};

export const mcpActionHandlers: ActionHandlersMap = {
	RefreshMcp: handleRefreshMcp as ActionHandler<never>,
	SetMcpEnabled: handleSetMcpEnabled as ActionHandler<never>,
	AddMcpServer: handleAddMcpServer as ActionHandler<never>,
	RemoveMcpServer: handleRemoveMcpServer as ActionHandler<never>,
	TestMcpServer: handleTestMcpServer as ActionHandler<never>,
	ClearMcpServerAuth: handleClearMcpServerAuth as ActionHandler<never>,
	ReloadMcp: handleReloadMcp as ActionHandler<never>,
	...mcpAuthActionHandlers,
	...mcpRegistryActionHandlers,
};
