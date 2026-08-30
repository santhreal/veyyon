/**
 * Custom tools: the context one executes against, the definition a declaration
 * converts to, and the extension that registers them with a session.
 */

import type { AgentTool } from "@veyyon/agent-core";
import { LEGACY_TOOL_DEFINITION_MARKER } from "@veyyon/kernel/registry/legacy-tool-marker";
import { logger } from "@veyyon/utils";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "../extensibility/custom-tools/types";
import type { ExtensionContext, ExtensionFactory, ToolDefinition } from "../extensibility/extensions";
import { imageGenTool } from "../tools/image-gen";

export const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

export function createCustomToolContext(
	ctx: ExtensionContext,
	obfuscateProviderText?: (text: string) => string,
): CustomToolContext {
	return {
		sessionManager: ctx.sessionManager,
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		isIdle: ctx.isIdle,
		hasQueuedMessages: ctx.hasPendingMessages,
		abort: ctx.abort,
		obfuscateProviderText: obfuscateProviderText ?? ctx.obfuscateProviderText,
		localProtocolOptions: ctx.localProtocolOptions,
	};
}

export function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// Converted tools carry a hidden marker: the sdk's symbol
	// (customToolToDefinition) or the legacy shim's string prop. Anything
	// unmarked is a CustomTool that still needs conversion — checking only one
	// marker would double-convert the other kind, scrambling execute()'s
	// argument order.
	const marked = tool as { [TOOL_DEFINITION_MARKER]?: true; [LEGACY_TOOL_DEFINITION_MARKER]?: true };
	return marked[TOOL_DEFINITION_MARKER] !== true && marked[LEGACY_TOOL_DEFINITION_MARKER] !== true;
}

export function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__veyyonLegacyBuiltinTool" in tool && tool.__veyyonLegacyBuiltinTool === true;
}

export function customToolToDefinition(
	tool: CustomTool,
	obfuscateProviderText?: (text: string) => string,
): ToolDefinition {
	const definition: ToolDefinition & { [TOOL_DEFINITION_MARKER]: true } = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		hidden: tool.hidden,
		deferrable: tool.deferrable,
		approval: typeof tool.approval === "function" ? tool.approval.bind(tool) : tool.approval,
		mcpServerName: tool.mcpServerName,
		mcpToolName: tool.mcpToolName,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			tool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx, obfuscateProviderText), signal),
		onSession: tool.onSession
			? (event, ctx) => tool.onSession?.(event, createCustomToolContext(ctx, obfuscateProviderText))
			: undefined,
		renderCall: tool.renderCall,
		renderResult: tool.renderResult
			? (result, options, theme) => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					// A renderer that returns nothing still yields a node that draws nothing, which
					// is what the host has always been handed here.
					return component ?? { render: () => [] };
				}
			: undefined,
		[TOOL_DEFINITION_MARKER]: true,
	};
	if (tool === imageGenTool) {
		(definition as typeof definition & Pick<AgentTool, "loadMode">).loadMode = imageGenTool.loadMode;
	}
	return definition;
}

export function createCustomToolsExtension(
	tools: CustomTool[],
	obfuscateProviderText: (text: string) => string,
): ExtensionFactory {
	return api => {
		for (const tool of tools) {
			api.registerTool(customToolToDefinition(tool, obfuscateProviderText));
		}

		const runOnSession = async (event: CustomToolSessionEvent, ctx: ExtensionContext) => {
			for (const tool of tools) {
				if (!tool.onSession) continue;
				try {
					await tool.onSession(event, createCustomToolContext(ctx, obfuscateProviderText));
				} catch (err) {
					logger.warn("Custom tool onSession error", { tool: tool.name, error: String(err) });
				}
			}
		};

		api.on("session_start", async (_event, ctx) =>
			runOnSession({ reason: "start", previousSessionFile: undefined }, ctx),
		);
		api.on("session_switch", async (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", async (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", async (_event, ctx) =>
			runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx),
		);
		api.on("session_shutdown", async (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", async (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_compaction_end",
					action: event.action,
					result: event.result,
					aborted: event.aborted,
					willRetry: event.willRetry,
					errorMessage: event.errorMessage,
				},
				ctx,
			),
		);
		api.on("auto_retry_start", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					errorId: event.errorId,
					mode: event.mode,
				},
				ctx,
			),
		);
		api.on("auto_retry_end", async (event, ctx) =>
			runOnSession(
				{
					reason: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					mode: event.mode,
					recoveredErrors: event.recoveredErrors,
				},
				ctx,
			),
		);
		api.on("ttsr_triggered", async (event, ctx) =>
			runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx),
		);
		api.on("todo_reminder", async (event, ctx) =>
			runOnSession(
				{
					reason: "todo_reminder",
					todos: event.todos,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
				},
				ctx,
			),
		);
	};
}
