import { errorMessage } from "@veyyon/utils";
import { loadAllMCPConfigs } from "../../mcp/config";
import { MCPManager } from "../../mcp/manager";
import { mcpManagerInstance } from "../../mcp/manager-instance";
import { parseMCPToolName } from "../../mcp/tool-bridge";
import type { MCPServerConfig } from "../../mcp/types";
import type { McpServerStatus, McpServerView } from "../wire";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

function matchesServerTool(tool: unknown, serverName: string): boolean {
	if (!tool || typeof tool !== "object") return false;
	let toolServer: string | undefined;

	if ("mcpServerName" in tool && typeof tool.mcpServerName === "string") toolServer = tool.mcpServerName;
	if ("name" in tool && typeof tool.name === "string") {
		toolServer ??= parseMCPToolName(tool.name)?.serverName;
	}

	return toolServer === serverName;
}

function extractToolName(tool: unknown): string {
	if (tool && typeof tool === "object") {
		if ("mcpToolName" in tool && typeof tool.mcpToolName === "string") return tool.mcpToolName;
		if ("name" in tool && typeof tool.name === "string") return parseMCPToolName(tool.name)?.toolName ?? tool.name;
	}
	return "";
}

async function getOrCreateMcpManager(ctx: ActionContext): Promise<MCPManager> {
	const globalInstance = mcpManagerInstance();
	if (globalInstance) return globalInstance;

	const manager = new MCPManager(ctx.cwd);
	const authStorage = await ctx.authStorage();
	manager.setAuthStorage(authStorage);
	try {
		await manager.discoverAndConnect({ agentDir: ctx.agentDir });
	} catch {
		// Manager stores errors in lastErrors
	}
	return manager;
}

async function buildMcpServerViews(manager: MCPManager, ctx: ActionContext): Promise<McpServerView[]> {
	let configuredConfigs: Record<string, MCPServerConfig> = {};
	try {
		const loaded = await loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir });
		configuredConfigs = loaded.configs;
	} catch {
		// Fall back to runtime server state
	}

	const serverNames = Array.from(new Set([...Object.keys(configuredConfigs), ...manager.getAllServerNames()]));
	const tools = manager.getTools();

	return serverNames.map(name => {
		const config = manager.getServerConfig(name) ?? configuredConfigs[name];
		const enabled = config?.enabled !== false;
		const connStatus = manager.getConnectionStatus(name);
		let status: McpServerStatus;
		if (connStatus === "connected") {
			status = "Connected";
		} else if (connStatus === "connecting") {
			status = "Connecting";
		} else {
			const lastError = manager.getLastError(name);
			status = lastError ? { Error: { message: lastError } } : "Disconnected";
		}

		const serverTools = tools
			.filter(tool => matchesServerTool(tool, name))
			.map(extractToolName)
			.filter(toolName => toolName.length > 0);

		return { name, enabled, status, tools: serverTools };
	});
}

const handleRefreshMcp: ActionHandler = async ctx => {
	try {
		const manager = await getOrCreateMcpManager(ctx);
		const servers = await buildMcpServerViews(manager, ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({ Mcp: servers });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "MCP_REFRESH_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface SetMcpEnabledPayload {
	server?: string;
	enabled?: boolean;
}

const handleSetMcpEnabled: ActionHandler<SetMcpEnabledPayload | undefined> = async (ctx, payload) => {
	if (!payload?.server || payload.enabled === undefined) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "INVALID_ARGUMENTS",
			message: "SetMcpEnabled requires server and enabled parameters",
			retryable: false,
		});
		return;
	}

	try {
		const manager = await getOrCreateMcpManager(ctx);
		const configured = await loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir });
		const config = manager.getServerConfig(payload.server) ?? configured.configs[payload.server];
		const source = manager.getSource(payload.server) ?? configured.sources[payload.server];

		if (!config) {
			ctx.reply.failure({
				scope: "Mcp",
				code: "MCP_SERVER_NOT_FOUND",
				message: `MCP server '${payload.server}' not found`,
				retryable: false,
			});
			return;
		}

		if (payload.enabled) {
			if (manager.getConnectionStatus(payload.server) === "disconnected") {
				await manager.connectServers({ [payload.server]: config }, source ? { [payload.server]: source } : {});
			} else {
				await manager.reconnectServer(payload.server, { manual: true });
			}
		} else {
			await manager.disconnectServer(payload.server);
		}
		const servers = await buildMcpServerViews(manager, ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({ Mcp: servers });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "MCP_ENABLE_TOGGLE_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

export const mcpActionHandlers: ActionHandlersMap = {
	RefreshMcp: handleRefreshMcp as ActionHandler<never>,
	SetMcpEnabled: handleSetMcpEnabled as ActionHandler<never>,
};
