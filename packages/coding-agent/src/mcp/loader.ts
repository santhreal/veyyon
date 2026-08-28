import { errorMessage, logger } from "@veyyon/utils";
import type { LoadedCustomTool } from "../extensibility/custom-tools/types";
import { AgentStorage } from "../session/agent-storage";
import type { AuthStorage } from "../session/auth-storage";
import { type MCPDiscoverOptions, type MCPLoadResult, MCPManager } from "./manager";
import { MCPToolCache } from "./tool-cache";

export interface MCPToolsLoadResult {
	manager: MCPManager;
	tools: LoadedCustomTool[];
	errors: Array<{ path: string; error: string }>;
	connectedServers: string[];
	exaApiKeys: string[];
}

export interface MCPToolsLoadOptions extends MCPDiscoverOptions {
	cacheStorage?: AgentStorage | null;
	authStorage?: AuthStorage;
}

async function resolveToolCache(storage: AgentStorage | null | undefined): Promise<MCPToolCache | null> {
	if (storage === null) return null;
	try {
		const resolved = storage ?? (await AgentStorage.open());
		return new MCPToolCache(resolved);
	} catch (error) {
		logger.warn("MCP tool cache unavailable", { error: String(error) });
		return null;
	}
}

export async function discoverAndLoadMCPTools(cwd: string, options?: MCPToolsLoadOptions): Promise<MCPToolsLoadResult> {
	const { cacheStorage, authStorage, ...discoverOptions } = options ?? {};
	const toolCache = await resolveToolCache(cacheStorage);
	const manager = new MCPManager(cwd, toolCache);
	if (authStorage) {
		manager.setAuthStorage(authStorage);
	}

	let result: MCPLoadResult;
	try {
		result = await manager.discoverAndConnect(discoverOptions);
	} catch (error) {
		const message = errorMessage(error);
		return {
			manager,
			tools: [],
			errors: [{ path: ".mcp.json", error: message }],
			connectedServers: [],
			exaApiKeys: [],
		};
	}

	const loadedTools: LoadedCustomTool[] = result.tools.map(tool => {
		const mcpTool = tool as { mcpServerName?: string };
		const serverName = mcpTool.mcpServerName;

		const connection = serverName ? manager.getConnection(serverName) : undefined;
		const source = serverName ? manager.getSource(serverName) : undefined;
		const providerName =
			connection?._source?.providerName ?? source?.providerName ?? connection?._source?.provider ?? source?.provider;

		const path = serverName && providerName ? `mcp:${serverName} via ${providerName}` : `mcp:${tool.name}`;

		return {
			path,
			resolvedPath: `mcp:${tool.name}`,
			tool,
		};
	});

	const errors: Array<{ path: string; error: string }> = [];
	for (const [serverName, errorMsg] of result.errors) {
		errors.push({ path: `mcp:${serverName}`, error: errorMsg });
	}

	return {
		manager,
		tools: loadedTools,
		errors,
		connectedServers: result.connectedServers,
		exaApiKeys: result.exaApiKeys,
	};
}
