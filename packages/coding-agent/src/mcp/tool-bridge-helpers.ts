import { namesDeadSocket } from "@veyyon/ai/error/flags";
import { errorMessage, isAbortError, isRecord, untilAborted } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { CustomToolContext, CustomToolResult } from "../extensibility/custom-tools/types";
import { resolveLocalUrlToFile } from "../internal-urls/local-protocol";
import { resolveProviderTextTransform, transformProviderPayload } from "../provider-boundary";
import type { OutputMeta } from "../tools/output-meta";
import { normalizeLocalScheme } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted, toolAbort } from "../tools/tool-errors";
import { retainMCPToolArgsAttemptFactory } from "./transports/http";
import { isMCPTransportStateMessage } from "./transports/transport-failure";
import type { MCPContent, MCPServerConnection, MCPToolCallParams, MCPToolCallResult, MCPToolDefinition } from "./types";

export type MCPReconnect = () => Promise<MCPServerConnection | null>;

export function mcpFailureWarrantsReconnect(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	if (/\bhttp (404|502|503)\b/.test(msg)) return true;
	if (isMCPTransportStateMessage(msg)) return true;
	return namesDeadSocket(msg);
}

export type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;
export const MCP_TOOL_CALL_BOUNDARY = "MCP tool call";

export function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (!isRecord(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

export function isUnusedOptionalPlaceholder(value: unknown): boolean {
	return value === undefined || value === "" || (isRecord(value) && Object.keys(value).length === 0);
}

export function omitUnusedOptionalArgs(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
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

export function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (inputSchema.properties && Object.hasOwn(inputSchema.properties, INTENT_FIELD)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

export async function resolveOutboundLocalUrlArgs(
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

export async function prepareOutboundArgs(
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

export interface MCPToolDetails {
	serverName: string;
	mcpToolName: string;
	isError?: boolean;
	rawContent?: MCPContent[];
	provider?: string;
	providerName?: string;
	meta?: OutputMeta;
}
export function formatMCPContent(content: MCPContent[]): string {
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

export function containsRawToolArgument(text: string, value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
	if (typeof value === "string") return value.length > 0 && text.includes(value);
	if (value === null || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsRawToolArgument(text, item, seen));
	return Object.entries(value).some(
		([key, item]) => (key.length > 0 && text.includes(key)) || containsRawToolArgument(text, item, seen),
	);
}

export const MODEL_NEXT_STEP =
	"Next step: retry this call at most once. A transport, auth or configuration failure returns the same error on every attempt, so a retry loop costs turns and changes nothing. If a second attempt fails, stop calling this tool and tell the operator what failed, which server it was on, and the fix named above.";

export function mcpToolFailureText(serverName: string, mcpToolName: string, detail: string): string {
	return `MCP tool "${mcpToolName}" on server "${serverName}" failed: ${detail}\n${MODEL_NEXT_STEP}`;
}

export function safeMCPErrorMessage(error: unknown, rawParams: unknown): string {
	const message = errorMessage(error);
	if (!containsRawToolArgument(message, rawParams)) return message;
	return "the server's error message echoed this call's arguments back, so it was withheld to keep credentials out of the transcript. Change the arguments and call again, or ask the operator to check the server's own logs for the real error.";
}

export function buildResult(
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
	const contentText = result.isError
		? mcpToolFailureText(
				serverName,
				mcpToolName,
				leaksRawArgs
					? "the server reported an error whose text echoed this call's arguments, so it was withheld to keep credentials out of the transcript. Change the arguments and call again, or ask the operator to check the server's own logs."
					: text,
			)
		: text;
	const toolResult: CustomToolResult<MCPToolDetails> = { content: [{ type: "text", text: contentText }], details };
	if (result.isError) {
		toolResult.isError = true;
	}
	return toolResult;
}

export function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	provider: string | undefined,
	providerName: string | undefined,
	rawParams: unknown,
): CustomToolResult<MCPToolDetails> {
	const message = safeMCPErrorMessage(error, rawParams);
	return {
		content: [{ type: "text", text: mcpToolFailureText(serverName, mcpToolName, message) }],
		details: { serverName, mcpToolName, isError: true, provider, providerName },
		isError: true,
	};
}

export function rethrowIfAborted(error: unknown, signal?: AbortSignal, what = "MCP call"): void {
	if (error instanceof ToolAbortError) throw error;
	if (isAbortError(error)) throw toolAbort(error, what);
	throwIfAborted(signal, what);
}

export async function reconnectWithAbort(
	reconnect: MCPReconnect,
	signal?: AbortSignal,
): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, reconnect);
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

export function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

export function mcpToolNamePrefix(serverName: string): string {
	return `mcp__${sanitizeMCPToolNamePart(serverName, "server")}_`;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");

	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return `${mcpToolNamePrefix(serverName)}${normalizedToolName}`;
}

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
