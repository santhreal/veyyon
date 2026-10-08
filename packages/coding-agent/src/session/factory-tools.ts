/**
 * Tools a session registers beyond the built-ins: the custom tools it force-activates, the
 * context one executes against, the definition a declaration converts to, the extension that
 * registers them, and the registry the session starts with.
 */

import type { AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { LEGACY_TOOL_DEFINITION_MARKER } from "@veyyon/kernel/registry/legacy-tool-marker";
import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { logger } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { getExaMcpTools } from "../exa/tools";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "../extensibility/custom-tools/types";
import {
	type BuiltinExtensionFactory,
	type ExtensionContext,
	type ExtensionRunner,
	ExtensionToolWrapper,
	type RegisteredTool,
	type ToolDefinition,
} from "../extensibility/extensions";
import { HIDDEN_TOOLS, type Tool, type ToolSession } from "../tools";
import { queueResolveHandler } from "../tools/agent/resolve";
import { TOOL } from "../tools/core/builtin-names";
import { wrapToolWithMetaNotice } from "../tools/core/output-meta";
import { getImageGenTools, imageGenTool } from "../tools/web/image-gen";
import { getSearchTools } from "../tools/web/search";
import { ttsTool } from "../tools/web/tts";
import type { SessionCpuExecHooks } from "./cpu-limit";
import { createPendingMCPTool } from "./factory-mcp";
import type { CreateAgentSessionOptions } from "./factory-options";

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
		view: tool.view,
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

/** The caller's SDK custom tools as definitions registered under `<sdk>`, legacy built-in definitions excluded. */
export function registerSdkCustomTools(
	customTools: readonly (CustomTool | ToolDefinition)[] | undefined,
	obfuscateProviderText: (text: string) => string,
): RegisteredTool[] {
	if (!customTools) return [];
	return customTools
		.filter(tool => !isLegacyBuiltinToolDefinition(tool))
		.map(tool => ({
			definition: isCustomTool(tool) ? customToolToDefinition(tool, obfuscateProviderText) : tool,
			extensionPath: "<sdk>",
		}));
}

export function createCustomToolsExtension(
	tools: CustomTool[],
	obfuscateProviderText: (text: string) => string,
): BuiltinExtensionFactory {
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

/** What {@link loadSessionCustomTools} reads. */
export interface SessionCustomToolsInput {
	options: Pick<CreateAgentSessionOptions, "toolNames" | "preloadedCustomToolPaths">;
	settings: Settings;
	modelRegistry: ModelRegistry;
	model: Model | undefined;
	cwd: string;
	agentDir: string;
	/** Names of the built-in tools, which a discovered tool may not take. */
	builtInToolNames: string[];
	toolSession: ToolSession;
	cpuExec: SessionCpuExecHooks;
	operatorNotices: OperatorNotices;
}

/** The custom tools a session registers, and the discovered source paths a spawned agent reuses. */
export interface SessionCustomTools {
	tools: CustomTool[];
	paths: ToolPathWithSource[];
}

/**
 * The custom tools a session force-activates through `alwaysInclude`: image generation, speech,
 * web search and Exa's hosted MCP tools when their settings enable them, then every tool discovered
 * under `.veyyon/tools/`, `.claude/tools/` and plugins.
 *
 * An explicit tool whitelist drops each optional tool it does not name, or `--no-tools` would let
 * them past every filter (issue #5305); web search joins only when a whitelist names it.
 * `exa.enabled` is the master switch the search provider honors, so it covers Exa's tools too.
 *
 * Discovered tools are always bound to THIS session's `CustomToolAPI` (cwd, exec, pending actions,
 * UI). A spawned agent reuses its parent's path scan through `preloadedCustomToolPaths`, never its
 * loaded tools, which would route execution back through the parent. A tool that fails to load,
 * from a syntax error, a bad default export or a taken name, is reported on the operator channel.
 */
export async function loadSessionCustomTools(input: SessionCustomToolsInput): Promise<SessionCustomTools> {
	const { options, settings, cwd, agentDir } = input;
	const whitelist = options.toolNames;
	const requested = (name: string): boolean => !whitelist || whitelist.includes(name);
	const tools: CustomTool[] = [];
	if (settings.get("generate_image.enabled") && requested("generate_image")) {
		const imageGenTools = await logger.time("getImageGenTools", () =>
			getImageGenTools(input.modelRegistry, input.model),
		);
		tools.push(...(imageGenTools as unknown as CustomTool[]));
	}
	if (settings.get("speechgen.enabled") && requested(ttsTool.name)) {
		tools.push(ttsTool as unknown as CustomTool);
	}
	if (whitelist?.includes(TOOL.web_search)) {
		tools.push(...getSearchTools());
	}
	if (settings.get("exa.enabled")) {
		const exaTools = await logger.time("getExaMcpTools", () =>
			getExaMcpTools({
				researcher: settings.get("exa.enableResearcher"),
				websets: settings.get("exa.enableWebsets"),
			}),
		);
		tools.push(...(exaTools.filter(tool => requested(tool.name)) as unknown as CustomTool[]));
	}

	const paths =
		options.preloadedCustomToolPaths ??
		(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd, agentDir)));
	const loaded = await logger.time("loadCustomTools", () =>
		loadCustomTools(
			paths,
			cwd,
			input.builtInToolNames,
			action => queueResolveHandler(input.toolSession, action),
			input.cpuExec.adoptPid,
			input.cpuExec.gate,
		),
	);
	for (const { path, error } of loaded.errors) {
		logger.error("Custom tool load failed", { path, error });
		input.operatorNotices.error("tools", `${path}: ${error}`);
	}
	for (const { tool } of loaded.tools) tools.push(tool);
	return { tools, paths };
}

/** What {@link assembleToolRegistry} builds the registry from. */
export interface ToolRegistryInput {
	builtinTools: Tool[];
	/** Extension, SDK-custom, image-gen, TTS and startup MCP tools, already wrapped for output spill. */
	extensionTools: Tool[];
	/** MCP tools a deferred discovery reserves a placeholder for until it connects. */
	pendingMCPToolNames: Iterable<string>;
	extensionRunner: ExtensionRunner;
	settings: Settings;
	toolSession: ToolSession;
}

/** A session's tool registry, and the names in it that are built-ins by provenance. */
export interface SessionToolRegistry {
	tools: Map<string, Tool>;
	builtInNames: Set<string>;
}

/**
 * The tool registry a session starts with.
 *
 * Built-ins first, `goal` when enabled and not already built, then the extension tools, each of
 * which replaces a built-in of the same name, then a placeholder for each MCP tool a deferred
 * discovery has not connected yet. Every one of them is wrapped in `ExtensionToolWrapper`, the only
 * place the per-tool approval check runs, whether or not any extension is loaded. `resolve` is
 * hidden but stays whenever a code path can invoke it: a deferrable tool stages a preview action,
 * or plan mode consumes `resolve { action: "apply" }` to submit its plan (issue #1428).
 */
export async function assembleToolRegistry(input: ToolRegistryInput): Promise<SessionToolRegistry> {
	const tools = new Map<string, Tool>();
	const builtInNames = new Set<string>();
	const addBuiltIn = (tool: Tool): void => {
		tools.set(tool.name, tool);
		builtInNames.add(tool.name);
	};
	for (const tool of input.builtinTools) addBuiltIn(tool);
	if (!tools.has(TOOL.goal) && input.settings.get("goal.enabled")) {
		const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, input.toolSession);
		if (goalTool) addBuiltIn(wrapToolWithMetaNotice(goalTool));
	}
	for (const tool of input.extensionTools) {
		tools.set(tool.name, tool);
		builtInNames.delete(tool.name);
	}
	for (const name of input.pendingMCPToolNames) {
		if (!tools.has(name)) tools.set(name, createPendingMCPTool(name));
	}
	for (const tool of tools.values()) {
		tools.set(tool.name, new ExtensionToolWrapper(tool, input.extensionRunner));
	}

	const hasDeferrableTools = Array.from(tools.values()).some(tool => tool.deferrable === true);
	if (!hasDeferrableTools && !input.settings.get("plan.enabled")) {
		tools.delete(TOOL.resolve);
		builtInNames.delete(TOOL.resolve);
	} else if (!tools.has(TOOL.resolve)) {
		const resolveTool = await logger.time("createTools:resolve:session", HIDDEN_TOOLS.resolve, input.toolSession);
		if (resolveTool) addBuiltIn(wrapToolWithMetaNotice(resolveTool));
	}
	return { tools, builtInNames };
}
