/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */

import type { AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import { normalizeSchemaForMCP } from "@veyyon/ai/utils/schema";
import { errorMessage, isAbortError, isRecord, untilAborted } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { SourceMeta } from "../capability/types";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import { resolveLocalUrlToFile } from "../internal-urls/local-protocol";
import type { Theme } from "../modes/theme/theme";
import { resolveProviderTextTransform, transformProviderPayload } from "../provider-boundary";
import type { OutputMeta } from "../tools/output-meta";
import { normalizeLocalScheme } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted, toolAbort } from "../tools/tool-errors";
import { callTool } from "./client";
import { renderMCPCall, renderMCPResult } from "./render";
import { retainMCPToolArgsAttemptFactory } from "./transports/http";
import type { MCPContent, MCPServerConnection, MCPToolCallParams, MCPToolCallResult, MCPToolDefinition } from "./types";

/** Reconnect callback: tears down stale connection, returns new one or null. */
export type MCPReconnect = () => Promise<MCPServerConnection | null>;

/**
 * Network-level and stale-session errors that warrant a reconnect + single retry.
 * Conservative: only catches errors where the server is likely alive but the
 * connection object is stale (dead SSE, expired session, refused after restart).
 */
const RETRIABLE_PATTERNS = [
	"econnrefused",
	"econnreset",
	"epipe",
	"enetunreach",
	"ehostunreach",
	"fetch failed",
	"transport not connected",
	"transport closed",
	"network error",
];

export function isRetriableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	// Stale session (server restarted, old session ID is gone)
	if (/^http (404|502|503):/.test(msg)) return true;
	return RETRIABLE_PATTERNS.some(p => msg.includes(p));
}

type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;
const MCP_TOOL_CALL_BOUNDARY = "MCP tool call";

function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (!isRecord(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

function isUnusedOptionalPlaceholder(value: unknown): boolean {
	return value === undefined || value === "" || (isRecord(value) && Object.keys(value).length === 0);
}

function omitUnusedOptionalArgs(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	const properties = inputSchema.properties;
	if (!properties) return args;

	let cleaned: MCPToolArgs | undefined;
	const required = new Set(inputSchema.required ?? []);
	for (const [key, value] of Object.entries(args)) {
		if (required.has(key) || !Object.hasOwn(properties, key) || !isUnusedOptionalPlaceholder(value)) {
			continue;
		}
		cleaned ??= { ...args };
		delete cleaned[key];
	}

	return cleaned ?? args;
}

/**
 * Drop the harness-internal intent field (`INTENT_FIELD`) before forwarding
 * args to an MCP server. The harness injects `i` into every tool's wire
 * schema; the direct model tool-call path strips it via `extractIntent`, but
 * the `eval` `tool.*` bridge and any other in-process caller forwards args
 * verbatim. Strict-schema servers (Linear, anything with
 * `additionalProperties:false` / Zod `.strict()`) reject every call that
 * carries `i`. The MCP boundary is the authoritative guard so callers don't
 * have to pre-strip.
 *
 * Leaves `i` in place when the server's own `inputSchema.properties` declares
 * it, so a server that legitimately uses `i` as a parameter is unaffected.
 */
function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (inputSchema.properties && Object.hasOwn(inputSchema.properties, INTENT_FIELD)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

async function resolveOutboundLocalUrlArgs(
	value: unknown,
	context: CustomToolContext,
	seen: WeakSet<object> = new WeakSet(),
): Promise<unknown> {
	if (typeof value === "string") {
		const normalized = normalizeLocalScheme(value);
		if (!normalized.startsWith("local://")) return value;
		const localFile = await resolveLocalUrlToFile(normalized, {
			cwd: context.sessionManager?.getCwd?.(),
			settings: context.settings,
			localProtocolOptions: context.localProtocolOptions,
		});
		return localFile?.path ?? value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (Array.isArray(value)) {
		let resolved: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = await resolveOutboundLocalUrlArgs(item, context, seen);
			if (next === item && !resolved) continue;
			resolved ??= value.slice();
			resolved[index] = next;
		}
		return resolved ?? value;
	}

	const input = value as Record<string, unknown>;
	let resolved: Record<string, unknown> | undefined;
	for (const key in input) {
		const item = input[key];
		const next = await resolveOutboundLocalUrlArgs(item, context, seen);
		if (next === item && !resolved) continue;
		resolved ??= { ...input };
		resolved[key] = next;
	}
	return resolved ?? value;
}

/**
 * Build one physical tools/call attempt from the untouched caller params.
 * Session-local URLs are expanded first. Only after that asynchronous local
 * work completes do we resolve the live provider transform and recursively
 * transform every outbound string key and value.
 */
async function prepareOutboundArgs(
	params: unknown,
	inputSchema: MCPToolDefinition["inputSchema"],
	context: CustomToolContext,
): Promise<MCPToolArgs> {
	const args = omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
	const localArgs = (await resolveOutboundLocalUrlArgs(args, context)) as MCPToolArgs;
	const transform = resolveProviderTextTransform(() => context.obfuscateProviderText, MCP_TOOL_CALL_BOUNDARY);
	const transformedArgs = transformProviderPayload(localArgs, transform, MCP_TOOL_CALL_BOUNDARY) as MCPToolArgs;
	return retainMCPToolArgsAttemptFactory({ ...transformedArgs }, () =>
		prepareOutboundArgs(params, inputSchema, context),
	);
}

/** Details included in MCP tool results for rendering */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}
/**
 * Format MCP content for LLM consumption.
 */
function formatMCPContent(content: MCPContent[]): string {
	const parts: string[] = [];

	for (const item of content) {
		switch (item.type) {
			case "text":
				parts.push(item.text);
				break;
			case "image":
				parts.push(`[Image: ${item.mimeType}]`);
				break;
			case "resource":
				if (item.resource.text) {
					parts.push(`[Resource: ${item.resource.uri}]\n${item.resource.text}`);
				} else {
					parts.push(`[Resource: ${item.resource.uri}]`);
				}
				break;
		}
	}

	return parts.join("\n\n");
}

function containsRawToolArgument(text: string, value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
	if (typeof value === "string") return value.length > 0 && text.includes(value);
	if (value === null || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsRawToolArgument(text, item, seen));
	return Object.entries(value).some(
		([key, item]) => (key.length > 0 && text.includes(key)) || containsRawToolArgument(text, item, seen),
	);
}

function safeMCPErrorMessage(error: unknown, rawParams: unknown): string {
	const message = errorMessage(error);
	return containsRawToolArgument(message, rawParams) ? "MCP request failed." : message;
}

/** Build a CustomToolResult from a callTool response. */
function buildResult(
	result: MCPToolCallResult,
	serverName: string,
	mcpToolName: string,
	provider: string | undefined,
	providerName: string | undefined,
	rawParams: unknown,
): CustomToolResult<MCPToolDetails> {
	const text = formatMCPContent(result.content);
	const leaksRawArgs = result.isError === true && containsRawToolArgument(text, rawParams);
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: result.isError,
		...(leaksRawArgs ? {} : { rawContent: result.content }),
		provider,
		providerName,
	};
	const contentText = result.isError ? (leaksRawArgs ? "Error: MCP tool call failed." : `Error: ${text}`) : text;
	const toolResult: CustomToolResult<MCPToolDetails> = { content: [{ type: "text", text: contentText }], details };
	if (result.isError) {
		toolResult.isError = true;
	}
	return toolResult;
}

/** Build an error CustomToolResult from a caught exception. */
function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	provider: string | undefined,
	providerName: string | undefined,
	rawParams: unknown,
): CustomToolResult<MCPToolDetails> {
	const message = safeMCPErrorMessage(error, rawParams);
	return {
		content: [{ type: "text", text: `MCP error: ${message}` }],
		details: { serverName, mcpToolName, isError: true, provider, providerName },
		isError: true,
	};
}

/**
 * Re-throw abort-related errors so they bypass error-result handling.
 *
 * The guard itself was always right: it fires before every error-to-result
 * conversion, which is why a cancelled MCP call was never quietly turned into a
 * tool result. What it used to lose was WHY. Two of its three branches minted a
 * bare `new ToolAbortError()`, so an MCP call stopped by an expired deadline, by
 * a parent tool cancelling a child, or by the call's own timeout all reached the
 * operator as the generic "Operation aborted", and the `TimeoutError` identity
 * that distinguishes a deadline from an Escape was dropped with the message.
 *
 * Both branches now go through `toolAbort` / `throwIfAborted`, the same owners
 * the tools layer uses, so the reason survives in the message and on `cause`.
 * `what` names the operation for the case where nothing else says anything.
 */
function rethrowIfAborted(error: unknown, signal?: AbortSignal, what = "MCP call"): void {
	if (error instanceof ToolAbortError) throw error;
	if (isAbortError(error)) throw toolAbort(error, what);
	throwIfAborted(signal, what);
}

async function reconnectWithAbort(reconnect: MCPReconnect, signal?: AbortSignal): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, reconnect);
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

/**
 * Create a unique tool name for an MCP tool.
 *
 * Prefixes with server name to avoid conflicts. If the tool name already
 * starts with the server name (e.g., server "puppeteer" with tool
 * "puppeteer_screenshot"), strips the redundant prefix to produce
 * "mcp__puppeteer_screenshot" instead of "mcp__puppeteer_puppeteer_screenshot".
 */
/**
 * Reduce a server or tool name to the characters a tool name may contain.
 *
 * DIGITS ARE KEPT. They used to be replaced along with everything else, which
 * made `github1` and `github2` sanitize to the same `github` — two different
 * servers producing byte-identical tool names, so one silently shadowed the
 * other in the registry and calls went wherever the lookup happened to land.
 * Numbered server names are ordinary (`mcp-server-1`, `jira2`), and every
 * provider accepts digits in a tool name, so dropping them bought nothing and
 * cost correctness.
 */
function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * The `mcp__<server>_` prefix every tool from `serverName` carries.
 *
 * One owner, because two callers need the exact same string and derived it
 * separately: `createMCPToolName` built it from the SANITIZED server name while
 * the manager's reconnect path filtered on the RAW one. For any server whose
 * name needed sanitizing the two never matched, so a reconnect failed to drop
 * the previous tools and pushed a second copy of every one of them.
 */
export function mcpToolNamePrefix(serverName: string): string {
	return `mcp__${sanitizeMCPToolNamePart(serverName, "server")}_`;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");

	// Strip redundant server name prefix from tool name if present
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return `${mcpToolNamePrefix(serverName)}${normalizedToolName}`;
}

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp__")) return null;

	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

/**
 * CustomTool wrapping an MCP tool with an active connection.
 */
export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/**
	 * MCP-backed tools opt out of strict structured-output grammar. The server
	 * owns validation, and strict mode makes OpenAI-family models over-fill
	 * mutually exclusive optional fields (#4336/#4340). Serializers preserve an
	 * explicit `false`; an omitted flag would leave nothing to preserve.
	 */
	readonly strict = false as const;

	/** Create MCPTool instances for all tools from an MCP server connection */
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
			if (this.reconnect && isRetriableConnectionError(error)) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					// Rebind so subsequent calls on this instance use the fresh connection
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

/**
 * CustomTool wrapping an MCP tool with deferred connection resolution.
 */
export class DeferredMCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/** See {@link MCPTool.strict}: MCP servers own validation, so stay non-strict. */
	readonly strict = false as const;

	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;

	/** Create DeferredMCPTool instances for all tools from an MCP server */
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
				if (this.reconnect && isRetriableConnectionError(callError)) {
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
			// getConnection() failed — server never connected or connection lost.
			// This is always worth a reconnect attempt for deferred tools, since the
			// error ("MCP server not connected") isn't a network error from callTool.
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
