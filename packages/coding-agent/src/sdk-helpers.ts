import type { AgentMessage, AgentTelemetryConfig, AgentTool } from "@veyyon/agent-core";
import type { CredentialDisabledEvent, Model } from "@veyyon/ai";
import type { Component } from "@veyyon/tui";
import {
	$env,
	attachFaultSink,
	errorMessage,
	getAgentDir,
	getGlobalConfigRootDir,
	getProjectDir,
	logger,
	postmortem,
	prefetch,
	prompt,
	Snowflake,
} from "@veyyon/utils";
import type { ArgotSession } from "argot";
import { type DiscoveredAdvisors, discoverAdvisorConfigs, discoverWatchdogFiles } from "./advisor";
import type { AsyncJobType } from "./async";
import { type CapabilityResult, loadCapability } from "./capability";
import { type Rule, ruleCapability } from "./capability/rule";
import type { EffortSource } from "./config/effort-resolver";
import { ModelRegistry } from "./config/model-registry";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { Settings, type SkillsSettings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import { disposeAllJuliaKernelSessions } from "./eval/jl/executor";
import { disposeAllVmContexts } from "./eval/js/context-manager";
import { disposeAllKernelSessions } from "./eval/py/executor";
import { disposeAllRubyKernelSessions } from "./eval/rb/executor";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import type { ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionRunner,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensions,
	type ToolDefinition,
} from "./extensibility/extensions";
import { LEGACY_TOOL_DEFINITION_MARKER } from "./extensibility/legacy-tool-marker";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import type { HindsightSessionState } from "./hindsight/state";
import type { LocalProtocolOptions } from "./internal-urls";
import { describeLegacyPromptFile, findLegacyPromptFiles } from "./legacy-system-prompt-files";
import type { LspStartupServerInfo } from "./lsp";
import {
	discoverAndLoadMCPTools,
	type MCPLoadResult,
	type MCPManager,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import type { MnemopiSessionState } from "./mnemopi/state";
import { toolsPrompts } from "./prompts/tools/rows";
import type { AgentRegistry } from "./registry/agent-registry";
import { attachSecretsNoticeSink } from "./secrets/notices";
import { vaultKeyPath } from "./secrets/vault-crypto";
import type { AgentSession, AsyncResultEntry, PlanYolo, Prewalk, SecretRuntimeLease } from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { type CustomMessage, LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "./session/messages";
import { OperatorNotices, stderrNoticeSink } from "./session/operator-notices";
import { SessionManager } from "./session/session-manager";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import type { ConfiguredThinkingLevel } from "./thinking";
import { isMCPToolName } from "./tool-discovery/tool-index";
import type { ContextFileEntry, DeferredDiagnosticsEntry, Tool } from "./tools";
import { imageGenTool, isImageProviderPreference, setPreferredImageProvider } from "./tools/image-gen";
import { type ActiveRepoContext, resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "./web/search";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

export type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
};
export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};
export type McpNotificationEntry = {
	serverName: string;
	uri: string;
};
export function secretProtectionUnavailableMessage(globalConfigRoot: string): string {
	return [
		`Secret protection is enabled but its key at ${vaultKeyPath(globalConfigRoot)} could not be initialized, so this session cannot redact or expand secrets.`,
		`Check that ${globalConfigRoot} is a real directory you own and can write to, that it is not a symlink and not on a read-only or exotic filesystem, then retry.`,
		"To start without secret protection instead, run: veyyon config set secrets.enabled false",
	].join("\n");
}
export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => ({
		jobId: entry.jobId,
		result: entry.result,
		type: entry.job?.type,
		label: entry.job?.label,
		durationMs: entry.durationMs,
	}));
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(toolsPrompts["tools/async-result"].text, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details: { jobs },
		timestamp: Date.now(),
	};
}
export type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};
export function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<LateDiagnosticsDetails> | null {
	if (entries.length === 0) return null;
	const files = entries.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		messages: entry.messages,
		errored: entry.errored,
	}));
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(toolsPrompts["tools/lsp-late-diagnostic"].text, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details: { files },
		timestamp: Date.now(),
	};
}
export function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}
export type DeferredMCPActivation = {
	mcpDiscoveryEnabled: boolean;
	explicitlyRequestedMCPToolNames: string[];
	activateAllMCPTools: boolean;
};
export function createPendingMCPTool(name: string): Tool {
	const parsed = parseMCPToolName(name);
	const serverName = parsed?.serverName;
	const mcpToolName = parsed?.toolName ?? name;
	const label = serverName ? `${serverName}/${mcpToolName}` : name;
	const message = serverName
		? `MCP server "${serverName}" is still connecting; tool "${name}" is not yet available. Retry after the MCP connection completes.`
		: `MCP discovery is still in progress; tool "${name}" is not yet available. Retry after MCP connection completes.`;
	const tool: Tool & { mcpServerName?: string; mcpToolName?: string } = {
		name,
		label,
		description: `Pending MCP tool. ${message}`,
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: true,
		},
		approval: "write",
		intent: "omit",
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return {
				content: [{ type: "text", text: message }],
				details: { serverName, mcpToolName, isError: true },
				isError: true,
			};
		},
	};
	return tool;
}
export function collectPendingMCPToolNames(
	explicitToolNames: readonly string[] | undefined,
	restoredSelectedToolNames: readonly string[],
): string[] {
	const names = new Set<string>();
	for (const name of explicitToolNames ?? []) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	for (const name of restoredSelectedToolNames) {
		const normalized = name.toLowerCase();
		if (isMCPToolName(normalized)) names.add(normalized);
	}
	return Array.from(names);
}
export function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}
export function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}
export interface CreateAgentSessionOptions {
	cwd?: string;
	agentDir?: string;
	globalConfigRoot?: string;
	spawns?: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	model?: Model;
	modelPattern?: string | string[];
	modelPatternAuthFallback?: string;
	modelPatternFallbackRole?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	thinkingSource?: EffortSource;
	scopedModels?: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		explicitThinkingLevel?: boolean;
	}>;
	prewalk?: Prewalk;
	planYolo?: PlanYolo;
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	customSystemPrompt?: string;
	appendSystemPrompt?: string;
	titleSystemPrompt?: string;
	providerSessionId?: string;
	providerPromptCacheKey?: string;
	providerPromptCacheKeySource?: "explicit" | "fork";
	deadline?: number;
	customTools?: (CustomTool | ToolDefinition)[];
	extensions?: ExtensionFactory[];
	additionalExtensionPaths?: string[];
	disableExtensionDiscovery?: boolean;
	preloadedExtensions?: LoadExtensionsResult;
	preloadedExtensionPaths?: string[];
	preloadedNamedExtensionPaths?: string[];
	preloadedCustomToolPaths?: ToolPathWithSource[];
	eventBus?: EventBus;
	operatorNotices?: OperatorNotices;
	skills?: Skill[];
	rules?: Rule[];
	contextFiles?: Array<{ path: string; content: string }>;
	workspaceTree?: WorkspaceTree;
	promptTemplates?: PromptTemplate[];
	slashCommands?: FileSlashCommand[];
	enableMCP?: boolean;
	mcpManager?: MCPManager;
	enableLsp?: boolean;
	skipPythonPreflight?: boolean;
	toolNames?: string[];
	outputSchema?: unknown;
	requireYieldTool?: boolean;
	taskDepth?: number;
	maxNestedSpawnDepth?: number;
	parentHindsightSessionState?: HindsightSessionState;
	parentArgot?: ArgotSession;
	parentMnemopiSessionState?: MnemopiSessionState;
	agentId?: string;
	agentDisplayName?: string;
	agentRegistry?: AgentRegistry;
	parentTaskPrefix?: string;
	parentAgentId?: string;
	parentEvalSessionId?: string;
	sessionManager?: SessionManager;
	localProtocolOptions?: LocalProtocolOptions;
	settings?: Settings;
	settingsManager?: Settings | Promise<Settings>;
	hasUI?: boolean;
	telemetry?: AgentTelemetryConfig;
	onFirstChatDispatch?: () => void;
	autoApprove?: boolean;
	bypassAllApprovals?: boolean;
	parentApprovalBypassed?: () => boolean;
}
export function isSubagentSession(options: Pick<CreateAgentSessionOptions, "taskDepth" | "parentTaskPrefix">): boolean {
	return (options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix);
}
export function isInProcessChildSession(options: Pick<CreateAgentSessionOptions, "parentTaskPrefix">): boolean {
	return Boolean(options.parentTaskPrefix);
}
export interface CreateAgentSessionResult {
	session: AgentSession;
	extensionsResult: LoadExtensionsResult;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	mcpManager?: MCPManager;
	modelFallbackMessage?: string;
	lspServers?: LspStartupServerInfo[];
	eventBus: EventBus;
}
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	return discoverAndLoadExtensions([], cwd ?? getProjectDir());
}
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	agentDir?: string,
): Promise<string[]> {
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, agentDir);
}
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
	agentDir?: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings, agentDir);
	const result = await logger.time(
		"loadExtensions",
		loadExtensions,
		paths,
		cwd,
		eventBus,
		adoptSpawnedPid,
		{
			agentDir,
			configuredPaths: [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])],
		},
		gateSpawn,
	);
	reportExtensionLoadFailures(result);
	return result;
}
export function reportExtensionLoadFailures(result: LoadExtensionsResult, operatorNotices?: OperatorNotices): void {
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
		operatorNotices?.error("extensions", `${path}: ${error}`);
	}
	for (const { path, reason } of result.withheld) {
		logger.warn("Withheld project extension", { path, reason });
		operatorNotices?.warn("extensions", reason);
	}
}
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}
export async function discoverSkills(
	cwd?: string,
	agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}
export async function discoverRules(cwd?: string, agentDir?: string): Promise<CapabilityResult<Rule>> {
	return await loadCapability<Rule>(ruleCapability.id, {
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}
export async function discoverContextFiles(cwd?: string, agentDir?: string): Promise<ContextFileEntry[]> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}
export async function discoverSlashCommands(cwd?: string, agentDir?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir(), agentDir: agentDir ?? getAgentDir() });
}
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	return loadCustomCommandsInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	return discoverAndLoadMCPTools(cwd ?? getProjectDir());
}
export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	agentDir?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
}
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		agentDir: options.agentDir,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		toolNames: options.tools?.map(tool => tool.name),
		tools: toolMap ? buildSystemPromptToolMetadata(toolMap) : undefined,
	});
}
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
export const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");
export function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	const marked = tool as unknown as { [TOOL_DEFINITION_MARKER]?: true; [LEGACY_TOOL_DEFINITION_MARKER]?: true };
	return marked[TOOL_DEFINITION_MARKER] !== true && marked[LEGACY_TOOL_DEFINITION_MARKER] !== true;
}
export function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__veyyonLegacyBuiltinTool" in tool && tool.__veyyonLegacyBuiltinTool === true;
}
export const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;
export let sshCleanupRegistered = false;
export async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}
export function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}
export let evalCleanupRegistered = false;
export function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
	postmortem.register("ruby-cleanup", disposeAllRubyKernelSessions);
	postmortem.register("julia-cleanup", disposeAllJuliaKernelSessions);
	postmortem.register("js-eval-cleanup", disposeAllVmContexts);
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
			? (result, options, theme): Component => {
					const component = tool.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme,
					);
					return component ?? ({ render: () => [] } as unknown as Component);
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

		api.on("session_start", (_event, ctx) => runOnSession({ reason: "start", previousSessionFile: undefined }, ctx));
		api.on("session_switch", (event, ctx) =>
			runOnSession({ reason: "switch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_branch", (event, ctx) =>
			runOnSession({ reason: "branch", previousSessionFile: event.previousSessionFile }, ctx),
		);
		api.on("session_tree", (_event, ctx) => runOnSession({ reason: "tree", previousSessionFile: undefined }, ctx));
		api.on("session_shutdown", (_event, ctx) =>
			runOnSession({ reason: "shutdown", previousSessionFile: undefined }, ctx),
		);
		api.on("auto_compaction_start", (event, ctx) =>
			runOnSession({ reason: "auto_compaction_start", trigger: event.reason, action: event.action }, ctx),
		);
		api.on("auto_compaction_end", (event, ctx) =>
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
		api.on("auto_retry_start", (event, ctx) =>
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
		api.on("auto_retry_end", (event, ctx) =>
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
		api.on("ttsr_triggered", (event, ctx) => runOnSession({ reason: "ttsr_triggered", rules: event.rules }, ctx));
		api.on("todo_reminder", (event, ctx) =>
			runOnSession(
				{ reason: "todo_reminder", todos: event.todos, attempt: event.attempt, maxAttempts: event.maxAttempts },
				ctx,
			),
		);
	};
}
export function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}
export function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {}
}
export interface SessionInfrastructure {
	cwd: string;
	agentDir: string;
	globalConfigRoot: string;
	eventBus: EventBus;
	modelRegistry: ModelRegistry;
	ownsAuthStorage: boolean;
	authStorage: AuthStorage;
	setCredentialDisabledTarget: (target: ExtensionRunner) => void;
	unsubscribeCredentialDisabled?: () => void;
	settings: Settings;
	operatorNotices: OperatorNotices;
	sessionManager: SessionManager;
	providerSessionId: string;
	providerPromptCacheKey?: string;
	providerPromptCacheKeySource?: "explicit" | "fork";
	detachSecretsNoticeSink?: () => void;
	detachFaultSink?: () => void;
	evalKernelOwnerId: string;
}
export async function setupSessionInfrastructure(options: CreateAgentSessionOptions): Promise<SessionInfrastructure> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}

	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			void credentialDisabledTarget.emitCredentialDisabled(event).catch(error => {
				logger.warn("Failed to deliver a credential-disabled event to extensions", {
					error: errorMessage(error),
				});
			});
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});

	const setCredentialDisabledTarget = (target: ExtensionRunner) => {
		credentialDisabledTarget = target;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			void target.emitCredentialDisabled(event).catch(error => {
				logger.warn("Failed to deliver a buffered credential-disabled event to extensions", {
					error: errorMessage(error),
				});
			});
		}
	};

	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}

	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
	}
	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}
	const imageProvider = settings.get("providers.image");
	if (isImageProviderPreference(imageProvider)) {
		setPreferredImageProvider(imageProvider);
	}

	const operatorNotices = options.operatorNotices ?? new OperatorNotices(stderrNoticeSink);
	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir), undefined, {
				operatorNotices,
				instrumentation: settings.get("session.instrumentation"),
			}),
		);
	sessionManager.setOperatorNotices(operatorNotices);
	sessionManager.setInstrumentationLevel(settings.get("session.instrumentation"));

	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const forkCacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined ||
		options.toolNames !== undefined ||
		options.customTools !== undefined;
	const inheritedPromptCacheKey = forkCacheShapeChanged
		? undefined
		: sessionManager.getHeader()?.providerPromptCacheKey;
	const providerPromptCacheKey = options.providerPromptCacheKey ?? inheritedPromptCacheKey;
	const providerPromptCacheKeySource =
		options.providerPromptCacheKey !== undefined
			? (options.providerPromptCacheKeySource ?? "explicit")
			: providerPromptCacheKey !== undefined
				? "fork"
				: undefined;

	const detachSecretsNoticeSink = attachSecretsNoticeSink(message => operatorNotices.warn("secrets", message));
	for (const legacyFile of await findLegacyPromptFiles({ cwd, agentDir })) {
		operatorNotices.warn("system-prompt", describeLegacyPromptFile(legacyFile));
	}
	const detachFaultSink = attachFaultSink(fault => operatorNotices.warn(fault.source, fault.text));
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;

	return {
		cwd,
		agentDir,
		globalConfigRoot,
		eventBus,
		modelRegistry,
		ownsAuthStorage,
		authStorage,
		setCredentialDisabledTarget,
		unsubscribeCredentialDisabled,
		settings,
		operatorNotices,
		sessionManager,
		providerSessionId,
		providerPromptCacheKey,
		providerPromptCacheKeySource,
		detachSecretsNoticeSink,
		detachFaultSink,
		evalKernelOwnerId,
	};
}
export interface SessionEnvironment {
	contextFiles: ContextFileEntry[];
	resolvedWorkspaceTree: WorkspaceTree | undefined;
	workspaceTreePromise: Promise<WorkspaceTree>;
	activeRepoContext: ActiveRepoContext | null;
	watchdogFiles: string[];
	discoveredAdvisors: DiscoveredAdvisors;
	promptTemplatesPromise: Promise<PromptTemplate[]>;
	slashCommandsPromise: Promise<FileSlashCommand[]>;
	skills: Skill[];
}
export const STARTUP_SCAN_DEADLINE_MS = 5000;
export async function discoverSessionEnvironment(params: {
	cwd: string;
	agentDir: string;
	settings: Settings;
	options: CreateAgentSessionOptions;
	operatorNotices: OperatorNotices;
}): Promise<SessionEnvironment> {
	const { cwd, agentDir, settings, options, operatorNotices } = params;

	const startupIncludeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
	const workspaceTreePromise: Promise<WorkspaceTree> = prefetch(
		options.workspaceTree !== undefined
			? Promise.resolve(options.workspaceTree)
			: startupIncludeWorkspaceTree
				? logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }))
				: Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] }),
	);

	const contextFilesResolvedByCaller = options.contextFiles !== undefined;
	if (contextFilesResolvedByCaller && options.contextFiles?.length === 0) {
		logger.warn("Context file discovery disabled: caller supplied an empty resolved list", { cwd, agentDir });
	}
	const contextFilesPromise = prefetch(
		contextFilesResolvedByCaller
			? Promise.resolve(options.contextFiles ?? [])
			: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir),
	);
	const activeRepoContextPromise = logger.time("resolveActiveRepoContext", async () => {
		try {
			return await resolveActiveRepoContext(cwd);
		} catch (err) {
			logger.warn("Failed to resolve active repo context", { err: String(err) });
			return null;
		}
	});
	const watchdogFilesPromise = prefetch(
		logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir)),
	);
	const advisorConfigsPromise = prefetch(
		logger.time("discoverAdvisorConfigs", () => discoverAdvisorConfigs(cwd, agentDir)),
	);
	const promptTemplatesPromise = prefetch(
		options.promptTemplates !== undefined
			? Promise.resolve(options.promptTemplates)
			: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir),
	);
	const slashCommandsPromise = prefetch(
		options.slashCommands !== undefined
			? Promise.resolve(options.slashCommands)
			: logger.time("discoverSlashCommands", discoverSlashCommands, cwd, agentDir),
	);
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise: Promise<{ skills: Skill[]; warnings: SkillWarning[] }> =
		options.skills === undefined
			? prefetch(
					logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
						...skillsSettings,
						disabledExtensions: disabledExtensionIds,
					}),
				)
			: Promise.resolve({ skills: options.skills, warnings: [] });

	const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
		let timedOut = false;
		const result = await Promise.race([
			work,
			Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
				timedOut = true;
				return undefined;
			}),
		]);
		if (timedOut) {
			logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
				name,
				timeoutMs: STARTUP_SCAN_DEADLINE_MS,
				cwd,
			});
		}
		return result;
	};

	const [contextFiles, resolvedWorkspaceTree, activeRepoContext, watchdogFiles, discoveredAdvisors, discovered] =
		await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
			activeRepoContextPromise,
			watchdogFilesPromise,
			advisorConfigsPromise,
			discoveredSkillsPromise,
		]);

	for (const warning of discovered.warnings) {
		operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
	}

	return {
		contextFiles,
		resolvedWorkspaceTree,
		workspaceTreePromise,
		activeRepoContext,
		watchdogFiles,
		discoveredAdvisors,
		promptTemplatesPromise,
		slashCommandsPromise,
		skills: discovered.skills,
	};
}
export interface UnreadableVaultReport {
	readonly authority: SecretRuntimeLease;
	readonly broken: string;
	readonly repair: string;
}
