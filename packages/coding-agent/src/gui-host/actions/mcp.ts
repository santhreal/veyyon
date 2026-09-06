import { loadAllMCPConfigs } from "../../mcp/config";
import { MCPManager } from "../../mcp/manager";
import { mcpManagerInstance } from "../../mcp/manager-instance";
import { parseMCPToolName } from "../../mcp/tool-bridge";
import type { MCPServerConfig } from "../../mcp/types";
import type { McpServerStatus, McpServerView } from "../wire";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

function matchesServerTool(tool: unknown, serverName: string, toolName?: string): boolean {
	if (!tool || typeof tool !== "object") return false;
	let toolServer: string | undefined;
	let toolMethod: string | undefined;

	if ("mcpServerName" in tool && typeof tool.mcpServerName === "string") toolServer = tool.mcpServerName;
	if ("mcpToolName" in tool && typeof tool.mcpToolName === "string") toolMethod = tool.mcpToolName;
	if ("name" in tool && typeof tool.name === "string") {
		const parsed = parseMCPToolName(tool.name);
		if (parsed) {
			toolServer ??= parsed.serverName;
			toolMethod ??= parsed.toolName;
		} else {
			toolMethod ??= tool.name;
		}
	}

	if (toolServer !== serverName) return false;
	if (toolName !== undefined && toolMethod !== toolName && "name" in tool && tool.name !== toolName) return false;
	return true;
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

function formatMcpOutput(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content ? JSON.stringify(content) : "";

	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
		} else if (block && typeof block === "object" && "type" in block) {
			if (block.type === "text" && "text" in block && typeof block.text === "string") {
				parts.push(block.text);
			} else if (block.type === "image") {
				let mediaType = "image";
				if ("media_type" in block && typeof block.media_type === "string") mediaType = block.media_type;
				else if ("mimeType" in block && typeof block.mimeType === "string") mediaType = block.mimeType;
				parts.push(`[image ${mediaType}]`);
			} else if (
				block.type === "resource" &&
				"resource" in block &&
				block.resource &&
				typeof block.resource === "object"
			) {
				if ("text" in block.resource && typeof block.resource.text === "string") {
					parts.push(block.resource.text);
				} else if ("uri" in block.resource && typeof block.resource.uri === "string") {
					parts.push(`[resource ${block.resource.uri}]`);
				}
			} else {
				parts.push(JSON.stringify(block));
			}
		} else {
			parts.push(JSON.stringify(block));
		}
	}
	return parts.join("\n\n");
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
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface ConnectMcpPayload {
	server?: string;
}

const handleConnectMcp: ActionHandler<ConnectMcpPayload | undefined> = async (ctx, payload) => {
	if (!payload?.server) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "INVALID_ARGUMENTS",
			message: "ConnectMcp requires a server parameter",
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

		if (manager.getConnectionStatus(payload.server) === "disconnected") {
			await manager.connectServers({ [payload.server]: config }, source ? { [payload.server]: source } : {});
		} else {
			await manager.reconnectServer(payload.server, { manual: true });
		}

		const servers = await buildMcpServerViews(manager, ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({ Mcp: servers });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "MCP_CONNECT_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface DisconnectMcpPayload {
	server?: string;
}

const handleDisconnectMcp: ActionHandler<DisconnectMcpPayload | undefined> = async (ctx, payload) => {
	if (!payload?.server) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "INVALID_ARGUMENTS",
			message: "DisconnectMcp requires a server parameter",
			retryable: false,
		});
		return;
	}

	try {
		const manager = await getOrCreateMcpManager(ctx);
		const configured = await loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir });
		const exists = manager.getAllServerNames().includes(payload.server) || payload.server in configured.configs;

		if (!exists) {
			ctx.reply.failure({
				scope: "Mcp",
				code: "MCP_SERVER_NOT_FOUND",
				message: `MCP server '${payload.server}' not found`,
				retryable: false,
			});
			return;
		}

		await manager.disconnectServer(payload.server);
		const servers = await buildMcpServerViews(manager, ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({ Mcp: servers });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "MCP_DISCONNECT_FAILED",
			message: error instanceof Error ? error.message : String(error),
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
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface CallMcpToolPayload {
	server?: string;
	tool?: string;
	arguments?: Record<string, unknown>;
}

const handleCallMcpTool: ActionHandler<CallMcpToolPayload | undefined> = async (ctx, payload) => {
	if (!payload?.server || !payload?.tool) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "INVALID_ARGUMENTS",
			message: "CallMcpTool requires server and tool parameters",
			retryable: false,
		});
		return;
	}

	try {
		const manager = await getOrCreateMcpManager(ctx);
		const configured = await loadAllMCPConfigs(ctx.cwd, { agentDir: ctx.agentDir });
		const exists = manager.getAllServerNames().includes(payload.server) || payload.server in configured.configs;

		if (!exists) {
			ctx.reply.failure({
				scope: "Mcp",
				code: "MCP_SERVER_NOT_FOUND",
				message: `MCP server '${payload.server}' not found`,
				retryable: false,
			});
			return;
		}

		const tools = manager.getTools();
		const tool = tools.find(t => matchesServerTool(t, payload.server!, payload.tool!));
		if (!tool) {
			ctx.reply.failure({
				scope: "Mcp",
				code: "TOOL_NOT_FOUND",
				message: `MCP tool '${payload.tool}' was not found on server '${payload.server}'`,
				retryable: false,
			});
			return;
		}

		const result = await tool.execute(`mcp-${Date.now()}`, payload.arguments ?? {}, undefined, {
			cwd: ctx.cwd,
		} as never);
		const is_error = result.isError === true;
		const output = formatMcpOutput(result.content);

		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			McpToolResult: {
				server: payload.server,
				tool: payload.tool,
				is_error,
				output,
			},
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Mcp",
			code: "MCP_TOOL_EXECUTION_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

export const mcpActionHandlers: ActionHandlersMap = {
	RefreshMcp: handleRefreshMcp as ActionHandler<never>,
	ConnectMcp: handleConnectMcp as ActionHandler<never>,
	DisconnectMcp: handleDisconnectMcp as ActionHandler<never>,
	SetMcpEnabled: handleSetMcpEnabled as ActionHandler<never>,
	CallMcpTool: handleCallMcpTool as ActionHandler<never>,
};
