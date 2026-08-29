import type { AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import { normalizeSchemaForMCP } from "@veyyon/ai/utils/schema";
import { untilAborted } from "@veyyon/utils";
import type { SourceMeta } from "../capability/types";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { throwIfAborted } from "../tools/tool-errors";
import { callTool } from "./client";
import { renderMCPCall, renderMCPResult } from "./render";
import type { MCPReconnect, MCPToolDetails } from "./tool-bridge-helpers";
import {
	buildErrorResult,
	buildResult,
	createMCPToolName,
	mcpFailureWarrantsReconnect,
	normalizeToolArgs,
	prepareOutboundArgs,
	reconnectWithAbort,
	rethrowIfAborted,
} from "./tool-bridge-helpers";
import type { MCPServerConnection, MCPToolDefinition } from "./types";

export { mcpToolNamePrefix, parseMCPToolName } from "./tool-bridge-helpers";
export type { MCPReconnect, MCPToolDetails };
export { createMCPToolName, mcpFailureWarrantsReconnect };

export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly mcpToolName: string;
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	readonly mergeCallAndResult = true;
	readonly strict = false as const;

	static fromTools(connection: MCPServerConnection, tools: MCPToolDefinition[], reconnect?: MCPReconnect): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${connection.name}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = connection.name;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const rawParams = params;
		const provider = this.connection._source?.provider;
		const providerName = this.connection._source?.providerName;

		try {
			const args = await prepareOutboundArgs(rawParams, this.tool.inputSchema, _ctx);
			throwIfAborted(signal);
			const result = await callTool(this.connection, this.tool.name, args, { signal });
			return buildResult(result, this.connection.name, this.tool.name, provider, providerName, rawParams);
		} catch (error) {
			rethrowIfAborted(error, signal);
			if (this.reconnect && mcpFailureWarrantsReconnect(error)) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					this.connection = newConn;
					const retryProvider = newConn._source?.provider ?? provider;
					const retryProviderName = newConn._source?.providerName ?? providerName;
					try {
						const retryArgs = await prepareOutboundArgs(rawParams, this.tool.inputSchema, _ctx);
						throwIfAborted(signal);
						const result = await callTool(newConn, this.tool.name, retryArgs, { signal });
						return buildResult(result, newConn.name, this.tool.name, retryProvider, retryProviderName, rawParams);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(
							retryError,
							this.connection.name,
							this.tool.name,
							retryProvider,
							retryProviderName,
							rawParams,
						);
					}
				}
			}
			return buildErrorResult(error, this.connection.name, this.tool.name, provider, providerName, rawParams);
		}
	}
}

export class DeferredMCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly mcpToolName: string;
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	readonly mergeCallAndResult = true;
	readonly strict = false as const;

	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;

	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
	): DeferredMCPTool[] {
		return tools.map(tool => new DeferredMCPTool(serverName, tool, getConnection, source, reconnect));
	}

	constructor(
		private readonly serverName: string,
		private readonly tool: MCPToolDefinition,
		private readonly getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(serverName, tool.name);
		this.label = `${serverName}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${serverName}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.#fallbackProvider = source?.provider;
		this.#fallbackProviderName = source?.providerName;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const rawParams = params;
		const provider = this.#fallbackProvider;
		const providerName = this.#fallbackProviderName;

		try {
			const connection = await untilAborted(signal, () => this.getConnection());
			throwIfAborted(signal);
			try {
				const args = await prepareOutboundArgs(rawParams, this.tool.inputSchema, _ctx);
				throwIfAborted(signal);
				const result = await callTool(connection, this.tool.name, args, { signal });
				return buildResult(
					result,
					this.serverName,
					this.tool.name,
					connection._source?.provider ?? provider,
					connection._source?.providerName ?? providerName,
					rawParams,
				);
			} catch (callError) {
				rethrowIfAborted(callError, signal);
				if (this.reconnect && mcpFailureWarrantsReconnect(callError)) {
					const newConn = await reconnectWithAbort(this.reconnect, signal);
					if (newConn) {
						const retryProvider = newConn._source?.provider ?? provider;
						const retryProviderName = newConn._source?.providerName ?? providerName;
						try {
							const retryArgs = await prepareOutboundArgs(rawParams, this.tool.inputSchema, _ctx);
							throwIfAborted(signal);
							const result = await callTool(newConn, this.tool.name, retryArgs, { signal });
							return buildResult(
								result,
								this.serverName,
								this.tool.name,
								retryProvider,
								retryProviderName,
								rawParams,
							);
						} catch (retryError) {
							rethrowIfAborted(retryError, signal);
							return buildErrorResult(
								retryError,
								this.serverName,
								this.tool.name,
								retryProvider,
								retryProviderName,
								rawParams,
							);
						}
					}
				}
				return buildErrorResult(callError, this.serverName, this.tool.name, provider, providerName, rawParams);
			}
		} catch (connError) {
			rethrowIfAborted(connError, signal);
			if (this.reconnect) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					try {
						const retryArgs = await prepareOutboundArgs(rawParams, this.tool.inputSchema, _ctx);
						throwIfAborted(signal);
						const result = await callTool(newConn, this.tool.name, retryArgs, { signal });
						return buildResult(
							result,
							this.serverName,
							this.tool.name,
							newConn._source?.provider ?? provider,
							newConn._source?.providerName ?? providerName,
							rawParams,
						);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(
							retryError,
							this.serverName,
							this.tool.name,
							provider,
							providerName,
							rawParams,
						);
					}
				}
			}
			return buildErrorResult(connError, this.serverName, this.tool.name, provider, providerName, rawParams);
		}
	}
}
