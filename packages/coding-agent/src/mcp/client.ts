import * as path from "node:path";
import * as url from "node:url";
import { errorMessage, getProjectDir, logger, withTimeout } from "@veyyon/utils";
import { MCP_PROTOCOL_VERSION } from "./protocol-version";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "./timeout";
import { MAX_TOOL_LIST_PAGES, validateToolListPage } from "./tool-list-validation";
import { createHttpTransport } from "./transports/http";
import { createSseTransport } from "./transports/sse";
import { createStdioTransport, StdioTransport } from "./transports/stdio";
import type {
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPTransport,
} from "./types";
import { assertNoUnresolvedPlaceholder } from "./unresolved-placeholder";

const CLIENT_INFO = {
	name: "veyyon-coding-agent",
	version: "1.0.0",
};

async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(
				new Error(
					`This MCP client does not implement the server-to-client request "${method}". It answers "ping" and "roots/list" only. Fix: nothing for the operator to do; the server should treat -32601 as "unsupported" and continue. If it does not, report the method name to the server's maintainer.`,
				),
				{ code: -32601 },
			);
	}
}

async function createTransport(config: MCPServerConfig): Promise<MCPTransport> {
	assertNoUnresolvedPlaceholder(config);
	const serverType = config.type ?? "stdio";

	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
			return createHttpTransport(config as MCPHttpServerConfig);
		case "sse":
			return createSseTransport(config as MCPSseServerConfig);
		default:
			throw new Error(
				`MCP server type "${serverType}" is not supported. Fix: set "type" to "stdio" (a server this machine spawns), "http" (a remote Streamable HTTP server) or "sse" (a legacy 2024-11-05 HTTP+SSE server) on this server's entry in your MCP config.`,
			);
	}
}

async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;
		onInitialized?: () => void | Promise<void>;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);

	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}

	await options?.onInitialized?.();

	await transport.notify("notifications/initialized");

	return result;
}

export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: {
		signal?: AbortSignal;
		onNotification?: (method: string, params: unknown) => void;
		onRequest?: (method: string, params: unknown) => Promise<unknown>;
		onSpawnPid?: (pid: number) => void;
		beforeSpawn?: () => Promise<void>;
	},
): Promise<MCPServerConnection> {
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	let transport: MCPTransport | undefined;

	const connect = async (): Promise<MCPServerConnection> => {
		transport = await createTransport(config);
		if (options?.onNotification) {
			transport.onNotification = options.onNotification;
		}
		if (transport instanceof StdioTransport) {
			if (options?.onSpawnPid) {
				transport.onSpawnPid = options.onSpawnPid;
			}
			if (options?.beforeSpawn) {
				transport.beforeSpawn = options.beforeSpawn;
			}
		}

		transport.onRequest = options?.onRequest ?? defaultRequestHandler;

		try {
			const initResult = await initializeConnection(transport, {
				signal: options?.signal,
				async onInitialized() {
					if ("startSSEListener" in transport! && typeof transport!.startSSEListener === "function") {
						await (transport as { startSSEListener(): Promise<void> }).startSSEListener();
					}
				},
			});

			return {
				name,
				config,
				transport,
				serverInfo: initResult.serverInfo,
				capabilities: initResult.capabilities,
				instructions: initResult.instructions,
			};
		} catch (error) {
			await transport.close();
			throw error;
		}
	};

	try {
		if (!isMCPTimeoutEnabled(timeoutMs)) {
			return await connect();
		}
		return await withTimeout(
			connect(),
			timeoutMs,
			`Connection to MCP server "${name}" timed out after ${describeMCPTimeout(timeoutMs)}`,
			options?.signal,
		);
	} catch (error) {
		if (transport) {
			closeTransportDetached(transport, name, "connect-timeout");
		}
		throw error;
	}
}

export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	if (!connection.capabilities.tools) {
		return [];
	}

	if (connection.tools) {
		return connection.tools;
	}

	const allTools: MCPToolDefinition[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	let pages = 0;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const raw = await connection.transport.request<unknown>("tools/list", params, options);
		const page = validateToolListPage(raw, connection.name);
		for (let ti = 0; ti < page.tools.length; ti++) allTools.push(page.tools[ti]!);
		cursor = page.nextCursor;
		pages++;

		if (cursor && seenCursors.has(cursor)) {
			logger.warn("MCP server repeated a pagination cursor; stopped listing its tools", {
				path: `mcp:${connection.name}`,
				server: connection.name,
				tools: allTools.length,
			});
			break;
		}
		if (cursor) seenCursors.add(cursor);
		if (pages >= MAX_TOOL_LIST_PAGES) {
			logger.warn("MCP server exceeded the tool-list page limit; stopped listing its tools", {
				pages,
				path: `mcp:${connection.name}`,
				server: connection.name,
				tools: allTools.length,
			});
			break;
		}
	} while (cursor);

	connection.tools = allTools;

	return allTools;
}

export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};

	return connection.transport.request<MCPToolCallResult>(
		"tools/call",
		params as unknown as Record<string, unknown>,
		options,
	);
}

export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

export function closeTransportDetached(
	transport: Pick<MCPServerConnection["transport"], "close">,
	server: string,
	context: string,
): void {
	void transport.close().catch((error: unknown) => {
		logger.warn("MCP transport close failed; it may be left open", {
			path: `mcp:${server}`,
			context,
			error: errorMessage(error),
		});
	});
}

export function serverSupportsTools(capabilities: MCPServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resources) {
		return connection.resources;
	}

	const allResources: MCPResource[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPResourcesListResult>("resources/list", params, options);
		for (let ri = 0; ri < result.resources.length; ri++) allResources.push(result.resources[ri]!);
		cursor = result.nextCursor;
	} while (cursor);

	connection.resources = allResources;
	return allResources;
}

function isMethodNotFoundError(error: unknown): boolean {
	const message = errorMessage(error);
	return message.includes("-32601") || /method not found/i.test(message);
}

export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) {
		return [];
	}

	if (connection.resourceTemplates) {
		return connection.resourceTemplates;
	}

	const allTemplates: MCPResourceTemplate[] = [];
	let cursor: string | undefined;

	try {
		do {
			const params: Record<string, unknown> = {};
			if (cursor) {
				params.cursor = cursor;
			}

			const result = await connection.transport.request<MCPResourceTemplatesListResult>(
				"resources/templates/list",
				params,
				options,
			);
			for (let ti = 0; ti < result.resourceTemplates.length; ti++) allTemplates.push(result.resourceTemplates[ti]!);
			cursor = result.nextCursor;
		} while (cursor);
	} catch (error) {
		if (isMethodNotFoundError(error)) {
			connection.resourceTemplates = [];
			return [];
		}
		throw error;
	}

	connection.resourceTemplates = allTemplates;
	return allTemplates;
}

export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const params: MCPResourceReadParams = { uri };
	return connection.transport.request<MCPResourceReadResult>(
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
}

export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return connection.transport.request(
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) {
		return [];
	}

	if (connection.prompts) {
		return connection.prompts;
	}

	const allPrompts: MCPPrompt[] = [];
	let cursor: string | undefined;

	do {
		const params: Record<string, unknown> = {};
		if (cursor) {
			params.cursor = cursor;
		}

		const result = await connection.transport.request<MCPPromptsListResult>("prompts/list", params, options);
		for (let pi = 0; pi < result.prompts.length; pi++) allPrompts.push(result.prompts[pi]!);
		cursor = result.nextCursor;
	} while (cursor);

	connection.prompts = allPrompts;
	return allPrompts;
}

export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	return connection.transport.request<MCPGetPromptResult>(
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
}

export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
