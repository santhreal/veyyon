import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type ThinkingLevel,
} from "@veyyon/agent-core";
import type { Context, CredentialDisabledEvent, Message, Model } from "@veyyon/ai";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
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
	setProjectDir,
} from "@veyyon/utils";
import { type ArgotGate, type ArgotSession, renderPreamble, shouldEncode } from "argot";
import type { DiscoveredAdvisors } from "./advisor";
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
} from "./advisor";
import {
	armArgotAfterStartup,
	collectArgotLoadedRoots,
	createArgotSession,
	rearmArgotForDecode,
	shouldAutoloadArgotAtStartup,
} from "./argot-cache";
import { buildArgotGate, expandToolArguments } from "./argot-wire";
import { AsyncJobManager, type AsyncJobType } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { createAutoresearchExtension } from "./autoresearch";
import { type CapabilityResult, loadCapability } from "./capability";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules, type RuleBuckets } from "./capability/rule-buckets";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { isAuthenticated, kNoAuth } from "./config/auth-state";
import { resolveDialect } from "./config/dialect-format";
import { type EffortSource, resolveEffort, withLegacyDefaultEffort } from "./config/effort-resolver";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { ModelRegistry } from "./config/model-registry";
import { modelResolutionFailureMessage } from "./config/model-resolution-failure";
import type { ModelMatchPreferences, ResolvedModelRoleValue } from "./config/model-resolver";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "./config/model-roles";
import { optionalNumber } from "./config/optional-number";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers, cursorContextFileRules, usesCursorRuleDelivery } from "./cursor";
import { initializeWithSettings } from "./discovery";
import { disposeAllJuliaKernelSessions, disposeJuliaKernelSessionsByOwner } from "./eval/jl/executor";
import { disposeAllVmContexts, disposeVmContextsByOwner } from "./eval/js/context-manager";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { disposeAllRubyKernelSessions, disposeRubyKernelSessionsByOwner } from "./eval/rb/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import { getExaMcpTools } from "./exa/tools";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext, CustomToolSessionEvent } from "./extensibility/custom-tools/types";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionTrustOptions,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import type { RegisteredTool } from "./extensibility/extensions/types";
import { LEGACY_TOOL_DEFINITION_MARKER } from "./extensibility/legacy-tool-marker";
import {
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import { resolveHarnessProfileForModel, resolvePromptSectionOrderForModel } from "./harness/model-profile";
import type { HindsightSessionState } from "./hindsight/state";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import { type JsonWithOptionalFields, mapJsonStrings } from "./json-transform";
import { describeLegacyPromptFile, findLegacyPromptFiles } from "./legacy-system-prompt-files";
import { discoverStartupLspServers, type LspStartupServerInfo, warmupLspServers } from "./lsp";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import {
	discoverAndLoadMCPTools,
	type MCPLoadResult,
	MCPManager,
	MCPToolCache,
	type MCPToolsLoadResult,
	parseMCPToolName,
} from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import type { MnemopiSessionState } from "./mnemopi/state";
import { DEFAULT_PLAN_FILE_URL } from "./plan-mode/plan-file-url";
import { toolsPrompts } from "./prompts/tools/rows";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, mainAgentIdFor } from "./registry/agent-registry";
import { createRepairToolCallArgumentsHook } from "./repair/agent-hook";
import {
	collectEnvSecrets,
	deobfuscateToolArguments,
	describeSecretRejection,
	loadSecrets,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./secrets";
import { buildExpansionRecord, SecretAuditLog, secretAuditPath } from "./secrets/audit";
import { buildEnvSecretPattern, loadEnvSecretKeywords } from "./secrets/env-keywords";
import { attachSecretsNoticeSink, SECRET_SPEND_NOTICE_SOURCE } from "./secrets/notices";
import { describeSecretExpiry } from "./secrets/obfuscator";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "./secrets/placeholder";
import { expiryWarnings } from "./secrets/secret-command";
import { secretSpendMarker } from "./secrets/spend-marker";
import { resolveVaultLocations, type ScopedVaultEntry, SecretVault, vaultPathFor } from "./secrets/vault";
import { loadOrCreateVaultKey, vaultKeyPath } from "./secrets/vault-crypto";
import {
	AgentSession,
	type AsyncResultEntry,
	obfuscateProviderPayload,
	type PlanYolo,
	type Prewalk,
	type SecretRuntimeLease,
} from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { sessionCpuExecHooks } from "./session/cpu-limit";
import { abortDetached } from "./session/detached-abort";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "./session/messages";
import { OperatorNotices, stderrNoticeSink } from "./session/operator-notices";
import type { SessionContext } from "./session/session-context";
import { getRestorableSessionModels } from "./session/session-context";
import type { SessionEntry } from "./session/session-entries";
import { SessionManager } from "./session/session-manager";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { wrapSteeringForModel } from "./session/steering-envelope";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { resolveGateInputs, resolveIntentField } from "./system-prompt-builder/gate-inputs";
import { renderSecretInventory } from "./system-prompt-builder/secret-inventory";
import { ARGOT_HANDLES_BANNER } from "./system-prompt-builder/section-registry";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import { delegationStrength } from "./task/subagent-settings";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import type { EffectiveToolDiscoveryMode } from "./tool-discovery/mode";
import { countToolsForAutoDiscovery, resolveEffectiveToolDiscoveryMode } from "./tool-discovery/mode";
import {
	collectDiscoverableTools,
	type DiscoverableTool,
	filterBySource,
	formatDiscoverableToolServerSummary,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
	summarizeDiscoverableTools,
} from "./tool-discovery/tool-index";
import {
	BUILTIN_TOOLS,
	type ContextFileEntry,
	computeEssentialBuiltinNames,
	createTools,
	type DeferredDiagnosticsEntry,
	HIDDEN_TOOLS,
	type Tool,
	type ToolSession,
} from "./tools";
import { normalizeToolNames, TOOL } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import {
	getImageGenTools,
	imageGenTool,
	isImageProviderPreference,
	setPreferredImageProvider,
} from "./tools/image-gen";
import { resolveDiscoveryAllForceActive, resolveInitialActiveToolNames } from "./tools/loading";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { queueResolveHandler } from "./tools/resolve";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "./tools/search-tool-bm25";
import { loadSshTool } from "./tools/ssh";
import { ttsTool } from "./tools/tts";
import { createVibeTools } from "./tools/vibe";
import type { ActiveRepoContext } from "./utils/active-repo-context";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { buildNamedToolChoice } from "./utils/tool-choice";
import {
	getSearchTools,
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "./web/search";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
};

type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

function secretProtectionUnavailableMessage(globalConfigRoot: string): string {
	return [
		`Secret protection is enabled but its key at ${vaultKeyPath(globalConfigRoot)} could not be initialized, so this session cannot redact or expand secrets.`,
		`Check that ${globalConfigRoot} is a real directory you own and can write to, that it is not a symlink and not on a read-only or exotic filesystem, then retry.`,
		"To start without secret protection instead, run: veyyon config set secrets.enabled false",
	].join("\n");
}

function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
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

type LateDiagnosticsDetails = {
	files: Array<{ path: string; summary: string; errored: boolean; messages: string[] }>;
};

function buildLateDiagnosticsBatchMessage(
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

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
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

type DeferredMCPActivation = {
	mcpDiscoveryEnabled: boolean;
	explicitlyRequestedMCPToolNames: string[];
	activateAllMCPTools: boolean;
};

function createPendingMCPTool(name: string): Tool {
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

function collectPendingMCPToolNames(
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

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
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

export { type DialectFormat, resolveDialect } from "./config/dialect-format";
export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type { CustomCommand, CustomCommandFactory } from "./extensibility/custom-commands/types";
export type { CustomTool, CustomToolFactory } from "./extensibility/custom-tools/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type { MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult } from "./mcp";
export type { Tool } from "./tools";
export { buildDirectoryTree, buildWorkspaceTree, type DirectoryTree, type WorkspaceTree } from "./workspace-tree";
export { BUILTIN_TOOLS, createTools, discoverAuthStorage, HIDDEN_TOOLS, type ToolSession };

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

function reportExtensionLoadFailures(result: LoadExtensionsResult, operatorNotices?: OperatorNotices): void {
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

function createCustomToolContext(
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

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	const marked = tool as unknown as { [TOOL_DEFINITION_MARKER]?: true; [LEGACY_TOOL_DEFINITION_MARKER]?: true };
	return marked[TOOL_DEFINITION_MARKER] !== true && marked[LEGACY_TOOL_DEFINITION_MARKER] !== true;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__veyyonLegacyBuiltinTool" in tool && tool.__veyyonLegacyBuiltinTool === true;
}

const MAX_MCP_INSTRUCTIONS_LENGTH = 4000;
let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

let evalCleanupRegistered = false;

function registerEvalCleanup(): void {
	if (evalCleanupRegistered) return;
	evalCleanupRegistered = true;
	postmortem.register("python-cleanup", disposeAllKernelSessions);
	postmortem.register("ruby-cleanup", disposeAllRubyKernelSessions);
	postmortem.register("julia-cleanup", disposeAllJuliaKernelSessions);
	postmortem.register("js-eval-cleanup", disposeAllVmContexts);
}

function customToolToDefinition(tool: CustomTool, obfuscateProviderText?: (text: string) => string): ToolDefinition {
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

function createCustomToolsExtension(
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

function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
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

function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}

interface SessionInfrastructure {
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

async function setupSessionInfrastructure(options: CreateAgentSessionOptions): Promise<SessionInfrastructure> {
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

interface SessionEnvironment {
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

const STARTUP_SCAN_DEADLINE_MS = 5000;

async function discoverSessionEnvironment(params: {
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

interface UnreadableVaultReport {
	readonly authority: SecretRuntimeLease;
	readonly broken: string;
	readonly repair: string;
}

class SecretRuntimeController {
	readonly #globalConfigRoot: string;
	readonly #agentDir: string;
	readonly #settings: Settings;
	readonly #operatorNotices: OperatorNotices;
	readonly #sessionManager: SessionManager;

	#obfuscator: SecretObfuscator | undefined;
	#redactionObfuscator: SecretObfuscator | undefined;
	#secretVault: SecretVault | undefined;
	#capturedVaultRevision: string | undefined;
	#secretAuditLog: SecretAuditLog | undefined;
	#secretRuntimeCwd: string;
	#latestSecretRuntimeRequest = 0;
	#pendingSecretRuntime: { revision: number; cwd: string; work: Promise<SecretRuntimeLease | undefined> } | undefined;
	#secretRuntimeLease: SecretRuntimeLease;
	#activeMainRequestRuntime: SecretRuntimeLease;
	#session?: AgentSession;

	readonly #auditLogBySecretLease = new WeakMap<object, SecretAuditLog | undefined>();
	readonly #vaultBySecretLease = new WeakMap<object, SecretVault>();
	readonly #secretRuntimeByObject = new WeakMap<object, SecretRuntimeLease>();

	constructor(params: {
		cwd: string;
		agentDir: string;
		globalConfigRoot: string;
		settings: Settings;
		operatorNotices: OperatorNotices;
		sessionManager: SessionManager;
		initialRuntime: {
			obfuscator?: SecretObfuscator;
			vault?: SecretVault;
			vaultRevision?: string;
			auditLog?: SecretAuditLog;
		};
	}) {
		this.#globalConfigRoot = params.globalConfigRoot;
		this.#agentDir = params.agentDir;
		this.#settings = params.settings;
		this.#operatorNotices = params.operatorNotices;
		this.#sessionManager = params.sessionManager;

		this.#obfuscator = params.initialRuntime.obfuscator;
		this.#redactionObfuscator = this.#obfuscator;
		this.#secretVault = params.initialRuntime.vault;
		this.#capturedVaultRevision = params.initialRuntime.vaultRevision;
		this.#secretAuditLog = params.initialRuntime.auditLog;
		this.#secretRuntimeCwd = path.resolve(params.cwd);

		this.#secretRuntimeLease = this.#createSecretRuntimeLease(
			0,
			params.cwd,
			this.#obfuscator,
			this.#redactionObfuscator,
			this.#secretVault,
			this.#capturedVaultRevision,
			this.#secretAuditLog,
		);
		this.#activeMainRequestRuntime = this.#secretRuntimeLease;
	}

	setSession(session: AgentSession): void {
		this.#session = session;
	}

	getLease(): SecretRuntimeLease {
		return this.#secretRuntimeLease;
	}

	getObfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	getRedactor(): SecretObfuscator | undefined {
		return this.#redactionObfuscator;
	}

	getVault(): SecretVault | undefined {
		return this.#secretVault;
	}

	getActiveMainRequestRuntime(): SecretRuntimeLease {
		return this.#activeMainRequestRuntime;
	}

	setActiveMainRequestRuntime(runtime: SecretRuntimeLease): void {
		this.#activeMainRequestRuntime = runtime;
	}

	async flushAuditLog(): Promise<void> {
		await this.#secretAuditLog?.flush();
	}

	bindSecretRuntime(value: unknown, runtime: SecretRuntimeLease): void {
		if (typeof value !== "object" || value === null) return;
		this.#secretRuntimeByObject.set(value, runtime);
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "object" && item !== null) this.#secretRuntimeByObject.set(item, runtime);
			}
		}
	}

	resolveSecretRuntimeForContext(context: Context): SecretRuntimeLease | undefined {
		const direct = this.#secretRuntimeByObject.get(context) ?? this.#secretRuntimeByObject.get(context.messages);
		if (direct) return direct;
		for (const message of context.messages) {
			const runtime = this.#secretRuntimeByObject.get(message);
			if (runtime) return runtime;
		}
		return undefined;
	}

	#scheduleStaleSecretRefresh(normalizedCwd: string): void {
		if (path.resolve(this.#sessionManager.getCwd()) !== normalizedCwd) return;
		if (this.#pendingSecretRuntime?.cwd === normalizedCwd) return;
		if (this.#secretRuntimeLease.cwd === normalizedCwd && this.#secretRuntimeLease.isFreshForExpansion()) return;
		void this.refreshSecretRuntime(normalizedCwd).catch(error => {
			logger.warn("Failed to refresh a stale secret runtime", {
				cwd: normalizedCwd,
				error: errorMessage(error),
			});
		});
	}

	#resolveFreshExpansionAuthority(requested: SecretRuntimeLease): SecretRuntimeLease | undefined {
		if (requested.isFreshForExpansion()) return requested;
		const live = this.#secretRuntimeLease;
		if (live === requested || live.cwd !== requested.cwd) return undefined;
		if (live.expansionObfuscator?.hasSecrets() !== true) return undefined;
		return live.isFreshForExpansion() ? live : undefined;
	}

	#unreadableVaultReport(requested: SecretRuntimeLease): UnreadableVaultReport | undefined {
		const live = this.#secretRuntimeLease;
		const authority = live.cwd === requested.cwd ? live : requested;
		const unreadable = this.#vaultBySecretLease.get(authority)?.unreadableScopes() ?? [];
		if (unreadable.length === 0) return undefined;
		const locations = resolveVaultLocations({
			globalConfigRoot: this.#globalConfigRoot,
			agentDir: this.#agentDir,
			cwd: authority.cwd,
		});
		const broken = unreadable.map(scope => `${scope} (${vaultPathFor(locations, scope)})`).join(", ");
		const commands = unreadable.map(scope => `/secret discard ${scope}`).join(" and ");
		return {
			authority,
			broken,
			repair: `Run ${commands} to move the unreadable file aside. Then store the secrets it held again.`,
		};
	}

	#assertNoOrphanPlaceholderWhileVaultUnreadable(requested: SecretRuntimeLease, args: Record<string, unknown>): void {
		const report = this.#unreadableVaultReport(requested);
		if (report === undefined) return;
		const scan = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
		let orphan: string | undefined;
		mapJsonStrings(args as JsonWithOptionalFields, text => {
			if (orphan !== undefined || !text.includes("#")) return text;
			scan.lastIndex = 0;
			for (;;) {
				const match = scan.exec(text);
				if (match === null) break;
				const token = match[0];
				if (isSecretPlaceholder(token) && report.authority.expansionObfuscator?.knowsPlaceholder(token) !== true) {
					orphan = token;
					break;
				}
			}
			return text;
		});
		if (orphan === undefined) return;
		throw new Error(
			`Secret expansion was refused because ${orphan} does not resolve and the vault could not be read, so there is no way to tell whether it is a credential this session should have expanded. Unreadable: ${report.broken}. ${report.repair} Nothing was run.`,
		);
	}

	#createSecretRuntimeLease(
		revision: number,
		runtimeCwd: string,
		expansionObfuscator: SecretObfuscator | undefined,
		redactor: SecretObfuscator | undefined,
		vault: SecretVault | undefined,
		vaultRevision: string | undefined,
		auditLog: SecretAuditLog | undefined,
	): SecretRuntimeLease {
		const normalizedCwd = path.resolve(runtimeCwd);
		const settledForExpansion = (text: string | undefined): boolean => {
			if (!vault || vaultRevision === undefined) return true;
			if (text !== undefined && expansionObfuscator?.containsLivePlaceholder(text) !== true) return true;
			return vault.revision() === vaultRevision;
		};
		const lease: SecretRuntimeLease = Object.freeze({
			revision,
			cwd: normalizedCwd,
			expansionObfuscator,
			redactionObfuscator: redactor,
			hasRedactions: redactor?.hasSecrets() ?? false,
			obfuscateText: (text: string) => redactor?.obfuscate(text) ?? text,
			obfuscateMessages: (messages: Message[]) => (redactor ? obfuscateMessages(redactor, messages) : messages),
			obfuscateContext: (context: Context) => (redactor ? obfuscateProviderContext(redactor, context) : context),
			obfuscatePayload: (payload: unknown) => obfuscateProviderPayload(payload, redactor),
			isFreshForExpansion: (text?: string) => settledForExpansion(text),
			ensureFreshForExpansion: async (text?: string) => {
				if (settledForExpansion(text)) return;
				if (path.resolve(this.#sessionManager.getCwd()) !== normalizedCwd) {
					await this.#pendingSecretRuntime?.work.catch(() => undefined);
					if (settledForExpansion(text)) return;
					throw new Error(
						`Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left, so that project's vault cannot be reloaded for it. Retry once the directory change has finished.`,
					);
				}
				let refreshed: SecretRuntimeLease | undefined;
				let reloadError: unknown;
				try {
					refreshed = await this.refreshSecretRuntime(normalizedCwd);
				} catch (error) {
					reloadError = error;
				}
				if (refreshed?.isFreshForExpansion(text) === true) return;
				if (settledForExpansion(text)) return;
				const detail = reloadError === undefined ? "" : ` Reload failed: ${errorMessage(reloadError)}.`;
				throw new Error(
					`Secret expansion was refused: reloading the secret vault for ${normalizedCwd} did not produce a runtime that can resolve this text's placeholders, so no current value is available.${detail} Check what is stored with /secret list, then retry.`,
				);
			},
			assertFreshForExpansion: (text?: string) => {
				if (settledForExpansion(text)) return;
				this.#scheduleStaleSecretRefresh(normalizedCwd);
				throw new Error(
					path.resolve(this.#sessionManager.getCwd()) === normalizedCwd
						? "Secret expansion was refused because the vault on disk no longer matches the snapshot this request is pinned to, so a placeholder could resolve to a value the vault has already replaced. A reload is under way; retry this call, and check what is stored with /secret list if it keeps failing."
						: `Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left; the destination's own reload is the authority. Retry once the directory change has finished.`,
				);
			},
		});
		this.#auditLogBySecretLease.set(lease, auditLog);
		if (vault) this.#vaultBySecretLease.set(lease, vault);
		return lease;
	}

	async #loadSecretRuntime(
		runtimeCwd: string,
		runtimeSettings: Settings = this.#settings,
		onUnreadableVault: "degrade" | "throw" = "throw",
	) {
		if (!runtimeSettings.get("secrets.enabled")) {
			return {
				obfuscator: undefined,
				vault: undefined,
				auditLog: undefined,
				vaultRevision: undefined,
			};
		}
		const placeholderKeyResultPromise = logger
			.time("loadSecretPlaceholderKey", () => loadOrCreateVaultKey(this.#globalConfigRoot))
			.then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);

		const fileEntries = await logger.time("loadSecrets", loadSecrets, runtimeCwd, this.#agentDir);
		const envKeywords = await logger.time("loadEnvSecretKeywords", () =>
			loadEnvSecretKeywords({ cwd: runtimeCwd, agentDir: this.#agentDir }),
		);
		const envEntries = collectEnvSecrets(buildEnvSecretPattern(envKeywords));
		const vaultLocations = resolveVaultLocations({
			globalConfigRoot: this.#globalConfigRoot,
			agentDir: this.#agentDir,
			cwd: runtimeCwd,
		});
		const vault = new SecretVault(vaultLocations);
		const auditLog = runtimeSettings.get("secrets.auditLog")
			? new SecretAuditLog(secretAuditPath(vaultLocations), this.#operatorNotices)
			: undefined;

		let liveVaultEntries: ScopedVaultEntry[] = [];
		try {
			liveVaultEntries = await logger.time("loadVault", () => vault.load());
		} catch (error) {
			await vault.noteFailedLoad(error);
			if (onUnreadableVault === "throw") throw error;
		}
		const vaultEntries: SecretEntry[] = liveVaultEntries.map(secret => ({
			type: "plain",
			content: secret.value,
			name: secret.name,
			expiresAt: secret.expiresAt,
			origin: "vault",
		}));

		const warnAboutExpiry = runtimeSettings.get("secrets.expiryWarnings");
		if (warnAboutExpiry) {
			for (const warning of expiryWarnings(liveVaultEntries, Date.now())) {
				this.#operatorNotices.warn("secrets", warning);
			}
		}

		const placeholderKeyResult = await placeholderKeyResultPromise;
		if (!placeholderKeyResult.ok) {
			throw new Error(secretProtectionUnavailableMessage(this.#globalConfigRoot), {
				cause: placeholderKeyResult.error,
			});
		}
		const placeholderKey = placeholderKeyResult.value;
		const vaultRevision = vault.revision();
		const nextObfuscator = new SecretObfuscator(envEntries.concat(fileEntries, vaultEntries), {
			placeholderKey,
			onRejection: rejection => this.#operatorNotices.warn("secrets", describeSecretRejection(rejection)),
			onExpiry: warnAboutExpiry
				? expiry => this.#operatorNotices.warn("secrets", describeSecretExpiry(expiry))
				: undefined,
		});
		return { obfuscator: nextObfuscator, vault, vaultRevision, auditLog };
	}

	async leaseSecretRuntime(): Promise<SecretRuntimeLease> {
		for (;;) {
			const pending = this.#pendingSecretRuntime;
			if (pending) {
				await pending.work;
				if (this.#pendingSecretRuntime !== pending) continue;
			}
			if (
				this.#secretVault &&
				this.#capturedVaultRevision !== undefined &&
				this.#secretVault.revision() !== this.#capturedVaultRevision
			) {
				return await this.refreshSecretRuntime(this.#sessionManager.getCwd());
			}
			return this.#secretRuntimeLease;
		}
	}

	refreshSecretRuntime = (runtimeCwd: string): Promise<SecretRuntimeLease> => {
		const revision = ++this.#latestSecretRuntimeRequest;
		const normalizedRuntimeCwd = path.resolve(runtimeCwd);
		const work = (async (): Promise<SecretRuntimeLease | undefined> => {
			const runtimeSettings =
				normalizedRuntimeCwd === this.#secretRuntimeCwd ||
				path.resolve(this.#settings.getCwd()) === normalizedRuntimeCwd
					? this.#settings
					: await this.#settings.cloneForCwd(normalizedRuntimeCwd);
			const next = await this.#loadSecretRuntime(normalizedRuntimeCwd, runtimeSettings);

			const isAuthoritative = (): boolean =>
				revision === this.#latestSecretRuntimeRequest &&
				path.resolve(this.#sessionManager.getCwd()) === normalizedRuntimeCwd;
			if (!isAuthoritative()) return undefined;

			if (next.obfuscator && this.#redactionObfuscator) {
				next.obfuscator.retainRedactionsFrom(this.#redactionObfuscator);
			} else if (this.#redactionObfuscator) {
				this.#redactionObfuscator.markAllPlaceholdersRetired();
			}
			await this.#secretAuditLog?.flush();
			if (!isAuthoritative()) return undefined;

			const nextRedactor = next.obfuscator ?? this.#redactionObfuscator;
			const nextLease = this.#createSecretRuntimeLease(
				revision,
				normalizedRuntimeCwd,
				next.obfuscator,
				nextRedactor,
				next.vault,
				next.vaultRevision,
				next.auditLog,
			);

			this.#obfuscator = next.obfuscator;
			this.#redactionObfuscator = nextRedactor;
			this.#secretVault = next.vault;
			this.#capturedVaultRevision = next.vaultRevision;
			this.#secretAuditLog = next.auditLog;
			this.#secretRuntimeCwd = normalizedRuntimeCwd;
			this.#secretRuntimeLease = nextLease;
			if (this.#session) this.#session.installSecretRuntime(nextLease);
			return nextLease;
		})();
		const pending = { revision, cwd: normalizedRuntimeCwd, work };
		this.#pendingSecretRuntime = pending;

		return (async () => {
			try {
				const committed = await work;
				if (committed) return committed;
				if (this.#pendingSecretRuntime === pending) this.#pendingSecretRuntime = undefined;
				return await this.leaseSecretRuntime();
			} catch (error) {
				if (revision !== this.#latestSecretRuntimeRequest) return await this.leaseSecretRuntime();
				throw error;
			} finally {
				if (this.#pendingSecretRuntime === pending) this.#pendingSecretRuntime = undefined;
			}
		})();
	};

	transformToolCallArguments(
		args: Record<string, unknown>,
		toolName: string,
		argot: ArgotSession | undefined,
		sessionId: string,
		emitNotice?: (level: "info" | "warning" | "error", message: string, source?: string) => void,
	): { execution: Record<string, unknown>; display: Record<string, unknown> } {
		let display = args;
		const maxTimeout = this.#settings.get("tools.maxTimeout");
		if (maxTimeout > 0 && typeof display.timeout === "number") {
			display = {
				...display,
				timeout: Math.min(display.timeout, maxTimeout),
			};
		}
		let execution = display;
		const requestRuntime = this.#activeMainRequestRuntime;
		const requestObfuscator = requestRuntime.expansionObfuscator;
		if (requestObfuscator === undefined && requestRuntime.redactionObfuscator) {
			mapJsonStrings(display as JsonWithOptionalFields, text => {
				requestRuntime.redactionObfuscator?.assertNoRetiredPlaceholder(text);
				return text;
			});
		}
		this.#assertNoOrphanPlaceholderWhileVaultUnreadable(requestRuntime, display);
		if (requestObfuscator?.hasSecrets()) {
			let expansionLease = requestRuntime;
			let expansionObfuscator = requestObfuscator;
			let carries = false;
			mapJsonStrings(display as JsonWithOptionalFields, text => {
				if (!carries && requestObfuscator.containsLivePlaceholder(text)) carries = true;
				return text;
			});
			if (!requestRuntime.isFreshForExpansion() && carries) {
				const fresh = this.#resolveFreshExpansionAuthority(requestRuntime);
				if (fresh === undefined) {
					requestRuntime.assertFreshForExpansion();
				} else {
					expansionLease = fresh;
					expansionObfuscator = fresh.expansionObfuscator ?? requestObfuscator;
				}
			}
			const requestAuditLog = this.#auditLogBySecretLease.get(expansionLease);
			if (requestAuditLog !== undefined) {
				const record = buildExpansionRecord({
					args: display,
					tool: toolName,
					session: sessionId,
					at: Date.now(),
					known: placeholder => expansionObfuscator.knowsPlaceholder(placeholder),
					obfuscate: value => requestRuntime.obfuscateText(value),
				});
				if (record !== null) requestAuditLog.record(record);
			}
			const spend = secretSpendMarker(display, toolName, placeholder =>
				expansionObfuscator.knowsPlaceholder(placeholder),
			);
			if (spend !== undefined) emitNotice?.("info", spend, SECRET_SPEND_NOTICE_SOURCE);
			execution = deobfuscateToolArguments(expansionObfuscator, display);
		}
		if (argot?.loaded) {
			const expandedDisplay = expandToolArguments(argot, display);
			execution = execution === display ? expandedDisplay : expandToolArguments(argot, execution);
			display = expandedDisplay;
		}
		return { execution, display };
	}

	async transformContext(messages: AgentMessage[], extensionRunner: ExtensionRunner): Promise<AgentMessage[]> {
		const runtime = await this.leaseSecretRuntime();
		this.#activeMainRequestRuntime = runtime;
		this.bindSecretRuntime(messages, runtime);
		const withContext = await extensionRunner.emitContext(messages);
		const transformed = wrapSteeringForModel(withContext);
		this.bindSecretRuntime(withContext, runtime);
		this.bindSecretRuntime(transformed, runtime);
		return transformed;
	}

	convertToLlmFinal(messages: AgentMessage[]): Message[] {
		const runtime = this.#secretRuntimeByObject.get(messages) ?? this.#activeMainRequestRuntime;
		const converted = filterProviderReplayMessages(convertToLlm(messages));
		const redacted = runtime.obfuscateMessages(converted);
		this.bindSecretRuntime(converted, runtime);
		this.bindSecretRuntime(redacted, runtime);
		return redacted;
	}

	async transformProviderContext(context: Context, requestRuntime?: SecretRuntimeLease): Promise<Context> {
		const runtime = requestRuntime ?? this.resolveSecretRuntimeForContext(context) ?? this.#activeMainRequestRuntime;
		const transformed = runtime.obfuscateContext(context);
		this.bindSecretRuntime(context, runtime);
		this.bindSecretRuntime(transformed, runtime);
		this.bindSecretRuntime(transformed.messages, runtime);
		return transformed;
	}
}

async function setupSecretRuntime(params: {
	cwd: string;
	agentDir: string;
	globalConfigRoot: string;
	settings: Settings;
	operatorNotices: OperatorNotices;
	sessionManager: SessionManager;
}): Promise<SecretRuntimeController> {
	let initialRuntime = {
		obfuscator: undefined as SecretObfuscator | undefined,
		vault: undefined as SecretVault | undefined,
		auditLog: undefined as SecretAuditLog | undefined,
		vaultRevision: undefined as string | undefined,
	};
	if (params.settings.get("secrets.enabled")) {
		const placeholderKeyResultPromise = logger
			.time("loadSecretPlaceholderKey", () => loadOrCreateVaultKey(params.globalConfigRoot))
			.then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			);
		const fileEntries = await logger.time("loadSecrets", loadSecrets, params.cwd, params.agentDir);
		const envKeywords = await logger.time("loadEnvSecretKeywords", () =>
			loadEnvSecretKeywords({ cwd: params.cwd, agentDir: params.agentDir }),
		);
		const envEntries = collectEnvSecrets(buildEnvSecretPattern(envKeywords));
		const vaultLocations = resolveVaultLocations({
			globalConfigRoot: params.globalConfigRoot,
			agentDir: params.agentDir,
			cwd: params.cwd,
		});
		const vault = new SecretVault(vaultLocations);
		const auditLog = params.settings.get("secrets.auditLog")
			? new SecretAuditLog(secretAuditPath(vaultLocations), params.operatorNotices)
			: undefined;

		let liveVaultEntries: ScopedVaultEntry[] = [];
		try {
			liveVaultEntries = await logger.time("loadVault", () => vault.load());
		} catch (error) {
			await vault.noteFailedLoad(error);
		}
		const vaultEntries: SecretEntry[] = liveVaultEntries.map(secret => ({
			type: "plain",
			content: secret.value,
			name: secret.name,
			expiresAt: secret.expiresAt,
			origin: "vault",
		}));
		const warnAboutExpiry = params.settings.get("secrets.expiryWarnings");
		if (warnAboutExpiry) {
			for (const warning of expiryWarnings(liveVaultEntries, Date.now())) {
				params.operatorNotices.warn("secrets", warning);
			}
		}
		const placeholderKeyResult = await placeholderKeyResultPromise;
		if (!placeholderKeyResult.ok) {
			throw new Error(secretProtectionUnavailableMessage(params.globalConfigRoot), {
				cause: placeholderKeyResult.error,
			});
		}
		const placeholderKey = placeholderKeyResult.value;
		const vaultRevision = vault.revision();
		const nextObfuscator = new SecretObfuscator(envEntries.concat(fileEntries, vaultEntries), {
			placeholderKey,
			onRejection: rejection => params.operatorNotices.warn("secrets", describeSecretRejection(rejection)),
			onExpiry: warnAboutExpiry
				? expiry => params.operatorNotices.warn("secrets", describeSecretExpiry(expiry))
				: undefined,
		});
		initialRuntime = { obfuscator: nextObfuscator, vault, vaultRevision, auditLog };
	}

	return new SecretRuntimeController({
		cwd: params.cwd,
		agentDir: params.agentDir,
		globalConfigRoot: params.globalConfigRoot,
		settings: params.settings,
		operatorNotices: params.operatorNotices,
		sessionManager: params.sessionManager,
		initialRuntime,
	});
}

interface SessionModelAndThinking {
	existingBranch: SessionEntry[];
	existingSession: SessionContext;
	hasExistingSession: boolean;
	hasThinkingEntry: boolean;
	hasServiceTierEntry: boolean;
	ttsrManager: TtsrManager;
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
	allRules: Rule[];
	argot?: ArgotSession;
	argotEnabled: boolean;
	argotGate: ArgotGate;
	sessionIsSubagent: boolean;
	deferredModelPatterns: string[];
	hasExplicitModel: boolean;
	defaultRoleSpec: ResolvedModelRoleValue;
	model?: Model;
	modelFallbackMessage?: string;
	thinkingSource: EffortSource;
	thinkingLevel?: ConfiguredThinkingLevel;
	autoThinking: boolean;
	effectiveThinkingLevel?: ThinkingLevel;
	restoredSessionModelIndex: number;
	sessionModelStrings: string[];
	pickInitialThinkingLevel: (selectedModel: Model | undefined) => ConfiguredThinkingLevel | undefined;
	modelMatchPreferences: ModelMatchPreferences;
}

async function resolveSessionModelAndThinking(params: {
	options: CreateAgentSessionOptions;
	cwd: string;
	agentDir: string;
	settings: Settings;
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
}): Promise<SessionModelAndThinking> {
	const { options, cwd, agentDir, settings, sessionManager, modelRegistry } = params;

	const argotEnabled = settings.get("argot.enabled") === true;
	const sessionIsSubagent = isSubagentSession(options);
	const argot = createArgotSession({
		enabled: argotEnabled,
		isSubagent: sessionIsSubagent,
		subagentMode: settings.get("argot.subagents"),
		parentArgot: options.parentArgot,
	});
	const argotGate: ArgotGate = buildArgotGate(
		argotEnabled,
		settings.get("argot.encode.models") ?? [],
		settings.get("argot.encode.disableAboveTokens"),
	);

	let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const interruptedTurnAbort = createInterruptedTurnAbortMessage(existingBranch);
	if (interruptedTurnAbort) {
		sessionManager.appendMessage(interruptedTurnAbort);
		existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
	}
	const existingSession = logger.time("loadSessionContext", () => sessionManager.buildSessionContext());

	const ttsrRulesResultPromise = logger
		.time("discoverTtsrRules", async () => {
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings, { getCwd: () => sessionManager.getCwd() });
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await discoverRules(cwd, agentDir);
			const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
				builtinRules: ttsrSettings.builtinRules,
				disabledRules: ttsrSettings.disabledRules,
				experimentalRules: ttsrSettings.experimentalRules,
			});
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return { ttsrManager, rulebookRules, alwaysApplyRules, allRules: rulesResult.items };
		})
		.then(
			value => ({ ok: true as const, value }),
			error => ({ ok: false as const, error }),
		);

	if (argot !== undefined && existingBranch.length > 0) {
		const argotRoots = collectArgotLoadedRoots(
			existingBranch.flatMap(entry => (entry.type === "message" ? [entry.message] : [])),
		);
		if (argotRoots.length > 0) {
			await rearmArgotForDecode(argot, argotRoots, undefined, settings.get("argot.tokenBudget"));
		}
	}
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const deferredModelPatterns = Array.isArray(options.modelPattern)
		? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
		: options.modelPattern?.trim()
			? [options.modelPattern.trim()]
			: [];
	const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const allowedModels = await logger.time("resolveAllowedModels", () =>
		resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	const defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole(DEFAULT_MODEL_SLOT), allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
		}),
	);

	let model = options.model;
	let modelFallbackMessage: string | undefined;
	const sessionModelStrings =
		!hasExplicitModel && hasExistingSession
			? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
			: [];
	let restoredSessionModelIndex = -1;
	let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;

	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					allowAutoAlias: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) {
					failedSessionModel ??= sessionModelStr;
					continue;
				}

				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					break;
				}
				failedSessionModel ??= sessionModelStr;
			}
			if (failedSessionModel) {
				modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			model = settingsDefaultModel;
		});
	}

	let thinkingSource: EffortSource = "model-default";
	const pickInitialThinkingLevel = (selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined => {
		if (options.thinkingLevel !== undefined) {
			thinkingSource = options.thinkingSource ?? "session";
			return options.thinkingLevel;
		}
		if (hasExistingSession && hasThinkingEntry) {
			thinkingSource = "session";
			return (
				parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel)
			);
		}
		if (!hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
			thinkingSource = "session";
			return restoredSessionThinkingLevel;
		}
		if (!hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
			thinkingSource = "selector";
			return defaultRoleSpec.thinkingLevel;
		}
		const saved = resolveEffort({
			modelSelector: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined,
			defaultEffort: withLegacyDefaultEffort(
				settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
				settings.get("defaultThinkingLevel"),
			),
		});
		thinkingSource = saved.source;
		return saved.level ?? selectedModel?.thinking?.defaultLevel;
	};

	const thinkingLevel = pickInitialThinkingLevel(model);
	const autoThinking = thinkingLevel === AUTO_THINKING;
	let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
	if (model) {
		const resolvedModel = model;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			autoThinking
				? resolveProvisionalAutoLevel(resolvedModel)
				: resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
		);
		preconnectModelHost(model.baseUrl);
	}

	const ttsrRulesResult = await ttsrRulesResultPromise;
	if (!ttsrRulesResult.ok) throw ttsrRulesResult.error;
	const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = ttsrRulesResult.value;

	return {
		existingBranch,
		existingSession,
		hasExistingSession,
		hasThinkingEntry,
		hasServiceTierEntry,
		ttsrManager,
		rulebookRules,
		alwaysApplyRules,
		allRules,
		argot,
		argotEnabled,
		argotGate,
		sessionIsSubagent,
		deferredModelPatterns,
		hasExplicitModel,
		defaultRoleSpec,
		model,
		modelFallbackMessage,
		thinkingSource,
		thinkingLevel,
		autoThinking,
		effectiveThinkingLevel,
		restoredSessionModelIndex,
		sessionModelStrings,
		pickInitialThinkingLevel,
		modelMatchPreferences,
	};
}

interface SessionToolsAndExtensions {
	asyncJobManager?: AsyncJobManager;
	scopedAsyncJobManager?: AsyncJobManager;
	toolSession: ToolSession;
	mcpManager?: MCPManager;
	deferMCPDiscoveryForUI: boolean;
	startDeferredMCPDiscovery?: (liveSession: AgentSession, activation: DeferredMCPActivation) => void;
	extensionsResult: LoadExtensionsResult;
	extensionRunner: ExtensionRunner;
	customCommandsResult: CustomCommandsLoadResult;
	toolRegistry: Map<string, Tool>;
	builtInRegistryToolNames: Set<string>;
	effectiveDiscoveryMode: EffectiveToolDiscoveryMode;
	mcpDiscoveryEnabled: boolean;
	enableDeferredMCPDiscoveryForTools: (liveSession: AgentSession, mcpTools: CustomTool[]) => Promise<boolean>;
	cursorExecHandlers: CursorExecHandlers;
	reloadSshTool: () => Promise<AgentTool | null>;
	model?: Model;
	modelFallbackMessage?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	autoThinking: boolean;
	effectiveThinkingLevel?: ThinkingLevel;
	thinkingSource: EffortSource;
	registeredTools: RegisteredTool[];
	sdkCustomTools: (CustomTool | ToolDefinition)[];
	toolContextStore: ToolContextStore;
	fileMutationVersions: Map<string, number>;
	activeToolNames: Set<string>;
	setActiveToolNames: (names: Iterable<string>) => void;
}

async function setupSessionToolsAndExtensions(params: {
	options: CreateAgentSessionOptions;
	infra: SessionInfrastructure;
	env: SessionEnvironment;
	secrets: SecretRuntimeController;
	modelState: SessionModelAndThinking;
	sessionRef: { session?: AgentSession; agent?: Agent };
}): Promise<SessionToolsAndExtensions> {
	const { options, infra, env, secrets, modelState, sessionRef } = params;
	const { cwd, agentDir, settings, sessionManager, modelRegistry, operatorNotices, eventBus } = infra;

	const enableLsp = options.enableLsp ?? true;
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
	const ASYNC_PREVIEW_MAX_CHARS = 4_000;

	const formatAsyncResultForFollowUp = async (result: string): Promise<string> => {
		if (result.length <= ASYNC_INLINE_RESULT_MAX_CHARS) {
			return result;
		}
		const preview = `${result.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		try {
			const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
			if (artifactPath && artifactId) {
				await Bun.write(artifactPath, result);
				return `${preview}\nFull output: artifact://${artifactId}`;
			}
		} catch (error) {
			logger.warn("Failed to persist async follow-up artifact", {
				error: errorMessage(error),
			});
		}
		return preview;
	};

	let asyncJobManager: AsyncJobManager | undefined;
	if (!isInProcessChildSession(options) && !AsyncJobManager.instance()) {
		asyncJobManager = new AsyncJobManager({
			maxRunningJobs: asyncMaxJobs,
			onJobComplete: async (jobId, result, job) => {
				if (!sessionRef.session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
				const formattedResult = await formatAsyncResultForFollowUp(result);
				if (asyncJobManager!.isDeliverySuppressed(jobId)) return;
				sessionRef.session.deliverAsyncJobResult(jobId, formattedResult, job);
			},
		});
	}

	const scopedAsyncJobManager =
		asyncJobManager ?? (isInProcessChildSession(options) ? AsyncJobManager.instance() : undefined);

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const conversationId = sessionManager.getSessionId?.();
	const resolvedAgentId =
		options.agentId ??
		options.parentTaskPrefix ??
		(!modelState.sessionIsSubagent && conversationId ? mainAgentIdFor(conversationId) : MAIN_AGENT_ID);

	const fileMutationVersions = new Map<string, number>();
	const activeToolNames = new Set<string>();
	const setActiveToolNames = (names: Iterable<string>): void => {
		activeToolNames.clear();
		for (const name of names) {
			activeToolNames.add(name);
		}
	};

	const setCwdBeforeSessionExists: NonNullable<ToolSession["setCwd"]> = async (resolvedPath, setOptions) => {
		const previous = sessionManager.getCwd();
		const nextCwd = await sessionManager.setCwd(resolvedPath, setOptions);
		if (nextCwd !== previous) {
			if (!modelState.sessionIsSubagent) setProjectDir(nextCwd);
			const note = `Session working directory changed: ${previous} → ${nextCwd}`;
			sessionManager.appendCustomMessageEntry("cwd_changed", note, true, { previous, cwd: nextCwd }, "agent");
		}
		return nextCwd;
	};

	const getActiveModelString = (): string | undefined => {
		const activeModel = sessionRef.agent?.state.model;
		if (activeModel) return formatModelString(activeModel);
		if (modelState.model) return formatModelString(modelState.model);
		return undefined;
	};

	const toolSession: ToolSession = {
		get cwd() {
			return sessionManager.getCwd();
		},
		setCwd: async (resolvedPath, setOptions) =>
			sessionRef.session
				? sessionRef.session.setCwd(resolvedPath, setOptions)
				: setCwdBeforeSessionExists(resolvedPath, setOptions),
		obfuscateProviderText: text => secrets.getLease().obfuscateText(text),
		get sideComplete() {
			return sessionRef.session?.sideComplete;
		},
		isToolActive: name => activeToolNames.has(name),
		setActiveToolNames,
		hasUI: options.hasUI ?? false,
		enableLsp,
		get hasEditTool() {
			const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
			return !requestedToolNames || requestedToolNames.includes(TOOL.edit);
		},
		skipPythonPreflight: options.skipPythonPreflight,
		contextFiles: env.contextFiles,
		workspaceTree: env.resolvedWorkspaceTree,
		skills: env.skills,
		rules: modelState.allRules,
		eventBus,
		outputSchema: options.outputSchema,
		requireYieldTool: options.requireYieldTool,
		taskDepth: options.taskDepth ?? 0,
		maxNestedSpawnDepth: options.maxNestedSpawnDepth,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getEvalKernelOwnerId: () => infra.evalKernelOwnerId,
		getEvalSessionId: () =>
			sessionRef.session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
		assertEvalExecutionAllowed: () => sessionRef.session?.assertEvalExecutionAllowed(),
		trackEvalExecution: (execution, abortController) =>
			sessionRef.session ? sessionRef.session.trackEvalExecution(execution, abortController) : execution,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
		getTurnIndex: () => sessionRef.session?.getTurnIndex() ?? 0,
		getHindsightSessionState: () => sessionRef.session?.getHindsightSessionState(),
		getMnemopiSessionState: () => sessionRef.session?.getMnemopiSessionState(),
		getAgentId: () => resolvedAgentId,
		getToolByName: name => sessionRef.session?.getToolByName(name),
		agentRegistry,
		getSessionSpawns: () => options.spawns ?? "*",
		getModelString: () =>
			modelState.hasExplicitModel && modelState.model ? formatModelString(modelState.model) : undefined,
		getActiveModelString,
		getActiveThinkingLevel: () => sessionRef.session?.configuredThinkingLevel() ?? options.thinkingLevel,
		getActiveModel: () => sessionRef.agent?.state.model ?? modelState.model,
		getServiceTierByFamily: () => sessionRef.session?.serviceTierByFamily,
		getImageAttachments: () => sessionRef.session?.getImageAttachments() ?? [],
		getPlanModeState: () => sessionRef.session?.getPlanModeState(),
		getPlanReferencePath: () => sessionRef.session?.getPlanReferencePath() ?? DEFAULT_PLAN_FILE_URL,
		getGoalModeState: () => sessionRef.session?.getGoalModeState(),
		getGoalRuntime: () => sessionRef.session?.goalRuntime,
		getUsageStatistics: () => sessionManager.getUsageStatistics(),
		getTurnBudget: () => sessionManager.getTurnBudget(),
		recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
		getClientBridge: () => sessionRef.session?.clientBridge,
		queueDeferredDiagnostics: entry =>
			sessionRef.session?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
		bumpFileMutationVersion: filePath => {
			const next = (fileMutationVersions.get(filePath) ?? 0) + 1;
			fileMutationVersions.set(filePath, next);
			return next;
		},
		getFileMutationVersion: filePath => fileMutationVersions.get(filePath) ?? 0,
		getTodoPhases: () => sessionRef.session!.getTodoPhases(),
		setTodoPhases: phases => sessionRef.session!.setTodoPhases(phases),
		isMCPDiscoveryEnabled: () => sessionRef.session!.isMCPDiscoveryEnabled(),
		getSelectedMCPToolNames: () => sessionRef.session!.getSelectedMCPToolNames(),
		activateDiscoveredMCPTools: toolNames => sessionRef.session!.activateDiscoveredMCPTools(toolNames),
		isToolDiscoveryEnabled: () => sessionRef.session!.isToolDiscoveryEnabled(),
		getDiscoverableTools: filter => sessionRef.session!.getDiscoverableTools(filter),
		getDiscoverableToolSearchIndex: () => sessionRef.session!.getDiscoverableToolSearchIndex(),
		getSelectedDiscoveredToolNames: () => sessionRef.session!.getSelectedDiscoveredToolNames(),
		activateDiscoveredTools: toolNames => sessionRef.session!.activateDiscoveredTools(toolNames),
		getCheckpointState: () => sessionRef.session!.getCheckpointState(),
		setCheckpointState: state => sessionRef.session!.setCheckpointState(state ?? undefined),
		getLastCompletedRewind: () => sessionRef.session!.getLastCompletedRewind(),
		getToolChoiceQueue: () => sessionRef.session!.toolChoiceQueue,
		buildToolChoice: name => {
			const m = sessionRef.session?.model;
			return m ? buildNamedToolChoice(name, m) : undefined;
		},
		steer: msg =>
			sessionRef.session!.agent.steer({
				role: "custom",
				customType: msg.customType,
				content: msg.content,
				display: false,
				details: msg.details,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		peekQueueInvoker: () => sessionRef.session!.peekQueueInvoker(),
		peekPendingInvoker: () => sessionRef.session!.peekPendingInvoker(),
		clearPendingInvokers: () => sessionRef.session!.clearPendingInvokers(),
		peekStandingResolveHandler: () => sessionRef.session!.peekStandingResolveHandler(),
		setStandingResolveHandler: handler => sessionRef.session!.setStandingResolveHandler(handler),
		allocateOutputArtifact: async toolType => {
			try {
				return await sessionManager.allocateArtifactPath(toolType);
			} catch (error) {
				logger.error("Artifact allocation failed; large output will be truncated without a saved copy", {
					toolType,
					error: errorMessage(error),
				});
				return {};
			}
		},
		getArtifactManager: () => sessionManager.getArtifactManager(),
		recordSubagentSpawn: record => sessionManager.appendSubagentSpawn(record),
		settings,
		authStorage: infra.authStorage,
		modelRegistry,
		getTelemetry: () => sessionRef.agent?.telemetry,
		asyncJobManager: scopedAsyncJobManager,
	};

	const getArtifactsDir = () => sessionManager.getArtifactsDir();
	if (!isInProcessChildSession(options)) {
		setActiveSkills(env.skills);
		setActiveRules(modelState.rulebookRules.concat(modelState.alwaysApplyRules, modelState.ttsrManager.getRules()));
		if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
	}
	const localProtocolOptions = options.localProtocolOptions ?? {
		getArtifactsDir,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
	};
	if (options.localProtocolOptions) {
		LocalProtocolHandler.setOverride(options.localProtocolOptions);
	}
	toolSession.getArtifactsDir = getArtifactsDir;
	toolSession.localProtocolOptions = localProtocolOptions;
	toolSession.agentOutputManager = new AgentOutputManager(
		getArtifactsDir,
		options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
	);

	const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

	let mcpManager: MCPManager | undefined = options.mcpManager;
	toolSession.mcpManager = mcpManager;
	const enableMCP = options.enableMCP ?? true;
	const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
	const customTools: CustomTool[] = [];
	let startDeferredMCPDiscovery: ((liveSession: AgentSession, activation: DeferredMCPActivation) => void) | undefined;
	const startupQuiet = settings.get("startup.quiet");
	const onMCPStatus = (event: McpConnectionStatusEvent) => {
		if (!options.hasUI || startupQuiet) return;
		if (event.type === "connecting" && event.serverNames.length === 0) return;
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
	};
	const mcpDiscoverOptions = {
		onStatus: onMCPStatus,
		filterExa: true,
		filterBrowser: settings.get("browser.enabled") ?? false,
		agentDir,
	};

	if (enableMCP && !mcpManager) {
		if (deferMCPDiscoveryForUI) {
			const cacheStorage = settings.getStorage();
			mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
			mcpManager.setAuthStorage(infra.authStorage);
			toolSession.mcpManager = mcpManager;

			if (settings.get("mcp.notifications")) {
				mcpManager.setNotificationsEnabled(true);
			}

			const deferredMCPManager = mcpManager;
			startDeferredMCPDiscovery = (liveSession, activation) => {
				void (async () => {
					try {
						const mcpResult = await logger.time("discoverAndLoadMCPTools", () =>
							deferredMCPManager.discoverAndConnect(mcpDiscoverOptions),
						);
						if (liveSession.isDisposed) {
							await deferredMCPManager.disconnectAll();
							return;
						}
						applyMCPEnvironment(mcpResult);
						logMCPLoadErrors(mcpResult.errors);
						let discoveryEnabled = activation.mcpDiscoveryEnabled;
						let activateAll = activation.activateAllMCPTools;
						if (!discoveryEnabled && (await enableDeferredMCPDiscoveryForTools(liveSession, mcpResult.tools))) {
							discoveryEnabled = true;
							activateAll = false;
						}
						await liveSession.refreshMCPTools(mcpResult.tools, { activateAll });
						if (activation.explicitlyRequestedMCPToolNames.length > 0) {
							if (discoveryEnabled && !activation.mcpDiscoveryEnabled) {
								await liveSession.activateDiscoveredMCPTools(activation.explicitlyRequestedMCPToolNames);
							} else if (!discoveryEnabled && !activateAll) {
								await liveSession.setActiveToolsByName([
									...liveSession.getActiveToolNames(),
									...activation.explicitlyRequestedMCPToolNames,
								]);
							}
						}
					} catch (error) {
						logger.error("MCP tool load failed", {
							path: ".mcp.json",
							error: errorMessage(error),
						});
					}
				})();
			};
		} else {
			const mcpResult = await logger.time("discoverAndLoadMCPTools", discoverAndLoadMCPTools, cwd, {
				...mcpDiscoverOptions,
				cacheStorage: settings.getStorage(),
				authStorage: infra.authStorage,
			});
			mcpManager = mcpResult.manager;
			toolSession.mcpManager = mcpManager;

			if (settings.get("mcp.notifications")) {
				mcpManager.setNotificationsEnabled(true);
			}
			applyMCPEnvironment(mcpResult);
			for (const { path: mcpPath, error } of mcpResult.errors) {
				logger.error("MCP tool load failed", { path: mcpPath, error });
			}
			if (mcpResult.tools.length > 0) {
				customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
			}
		}
	}
	if (mcpManager && !isInProcessChildSession(options)) MCPManager.setInstance(mcpManager);

	const imageGenRequested = options.toolNames === undefined || options.toolNames.includes("generate_image");
	if (settings.get("generate_image.enabled") && imageGenRequested) {
		const imageGenTools = await logger.time("getImageGenTools", () =>
			getImageGenTools(modelRegistry, modelState.model),
		);
		if (imageGenTools.length > 0) {
			customTools.push(...(imageGenTools as unknown as CustomTool[]));
		}
	}

	const speechRequested = options.toolNames === undefined || options.toolNames.includes(ttsTool.name);
	if (settings.get("speechgen.enabled") && speechRequested) {
		customTools.push(ttsTool as unknown as CustomTool);
	}

	if (options.toolNames?.includes(TOOL.web_search)) {
		customTools.push(...getSearchTools());
	}

	if (settings.get("exa.enabled")) {
		const exaTools = await logger.time("getExaMcpTools", () =>
			getExaMcpTools({
				researcher: settings.get("exa.enableResearcher"),
				websets: settings.get("exa.enableWebsets"),
			}),
		);
		const whitelist = options.toolNames;
		const requestedExaTools = whitelist
			? exaTools.filter(tool => whitelist.includes((tool as { name: string }).name))
			: exaTools;
		if (requestedExaTools.length > 0) {
			customTools.push(...(requestedExaTools as unknown as CustomTool[]));
		}
	}

	const builtInToolNames = builtinTools.map(t => t.name);
	const cpuExec = sessionCpuExecHooks(() => toolSession.getSessionId?.() ?? null);
	const adoptSpawnedPid = cpuExec.adoptPid;
	const gateSpawn = cpuExec.gate;
	const customToolPaths: ToolPathWithSource[] =
		options.preloadedCustomToolPaths ??
		(await logger.time("discoverCustomToolPaths", () => discoverCustomToolPaths([], cwd, agentDir)));
	const customToolsLoadResult = await logger.time("loadCustomTools", () =>
		loadCustomTools(
			customToolPaths,
			cwd,
			builtInToolNames,
			action => queueResolveHandler(toolSession, action),
			adoptSpawnedPid,
			gateSpawn,
		),
	);
	for (const { path: toolErrPath, error } of customToolsLoadResult.errors) {
		logger.error("Custom tool load failed", { path: toolErrPath, error });
	}
	if (customToolsLoadResult.tools.length > 0) {
		customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
	}
	toolSession.customToolPaths = customToolPaths;

	const inlineExtensions: ExtensionFactory[] = options.extensions ? options.extensions.slice() : [];
	inlineExtensions.push(createAutoresearchExtension);
	if (customTools.length > 0) {
		inlineExtensions.push(createCustomToolsExtension(customTools, text => secrets.getLease().obfuscateText(text)));
	}

	let extensionPaths: string[];
	let extensionsResult: LoadExtensionsResult;
	const namedExtensionPaths = [
		...(options.additionalExtensionPaths ?? []),
		...(options.preloadedNamedExtensionPaths ?? []),
		...(settings.get("extensions") ?? []),
	];
	const extensionTrustOptions: ExtensionTrustOptions = {
		agentDir,
		configuredPaths: namedExtensionPaths,
	};
	if (options.preloadedExtensions) {
		extensionsResult = {
			...options.preloadedExtensions,
			extensions: options.preloadedExtensions.extensions.slice(),
		};
		extensionPaths = extensionsResult.extensions.map(ext => ext.resolvedPath).filter(p => !p.startsWith("<inline"));
		reportExtensionLoadFailures(extensionsResult, operatorNotices);
	} else if (options.preloadedExtensionPaths) {
		extensionPaths = options.preloadedExtensionPaths;
		extensionsResult = await logger.time(
			"loadExtensions",
			loadExtensions,
			extensionPaths,
			cwd,
			eventBus,
			adoptSpawnedPid,
			extensionTrustOptions,
			gateSpawn,
		);
		reportExtensionLoadFailures(extensionsResult, operatorNotices);
	} else {
		extensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
			discoverSessionExtensionPaths(options, cwd, settings, agentDir),
		);
		extensionsResult = await logger.time(
			"loadExtensions",
			loadExtensions,
			extensionPaths,
			cwd,
			eventBus,
			adoptSpawnedPid,
			extensionTrustOptions,
			gateSpawn,
		);
		reportExtensionLoadFailures(extensionsResult, operatorNotices);
	}
	toolSession.extensionPaths = extensionPaths;
	toolSession.namedExtensionPaths = namedExtensionPaths;

	if (inlineExtensions.length > 0) {
		for (let i = 0; i < inlineExtensions.length; i++) {
			const factory = inlineExtensions[i];
			const loaded = await loadExtensionFromFactory(
				factory,
				cwd,
				eventBus,
				extensionsResult.runtime,
				`<inline-${i}>`,
				adoptSpawnedPid,
				gateSpawn,
			);
			extensionsResult.extensions.push(loaded);
		}
	}

	const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeExtensionSources);
	for (const sourceId of new Set(activeExtensionSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
		for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
			modelRegistry.registerProvider(name, config, sourceId);
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
	}
	await modelRegistry.refreshRuntimeProviders("offline");
	void modelRegistry.refreshRuntimeProviders().catch(error => {
		logger.warn("runtime provider discovery failed", {
			error: errorMessage(error),
		});
	});

	let model = modelState.model;
	let modelFallbackMessage = modelState.modelFallbackMessage;
	let thinkingLevel = modelState.thinkingLevel;
	let autoThinking = modelState.autoThinking;
	let effectiveThinkingLevel = modelState.effectiveThinkingLevel;
	const thinkingSource = modelState.thinkingSource;
	let restoredSessionModelIndex = modelState.restoredSessionModelIndex;

	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);
	const sessionRetryLimit =
		restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : modelState.sessionModelStrings.length;
	if (!modelState.hasExplicitModel && sessionRetryLimit > 0) {
		for (let i = 0; i < sessionRetryLimit; i++) {
			const sessionModelStr = modelState.sessionModelStrings[i];
			const parsedModel = parseModelString(sessionModelStr, {
				allowMaxSuffix: true,
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
			});
			if (!parsedModel) continue;
			const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
			if (restoredModel && hasModelAuth(restoredModel)) {
				model = restoredModel;
				modelFallbackMessage = undefined;
				restoredSessionModelIndex = i;
				thinkingLevel = modelState.pickInitialThinkingLevel(restoredModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(restoredModel)
						: resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
				);
				preconnectModelHost(restoredModel.baseUrl);
				break;
			}
		}
	}

	if (!model && modelState.deferredModelPatterns.length > 0) {
		const expandedModelPatterns = resolveConfiguredModelPatterns(modelState.deferredModelPatterns, settings);
		const availableModels = modelRegistry.getAll();
		const matchPreferences = getModelMatchPreferences(settings);
		for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
			const pattern = expandedModelPatterns[patternIndex];
			const primary = parseModelPattern(pattern, availableModels, matchPreferences);
			if (!primary.model) continue;
			let selectedModel = primary.model;
			let selectedThinkingLevel = primary.thinkingLevel;
			let selectedExplicitThinkingLevel = primary.explicitThinkingLevel;
			let authFallbackUsed = false;
			if (options.modelPatternAuthFallback) {
				const primaryKey = await modelRegistry.getApiKey(primary.model);
				if (primaryKey !== kNoAuth && !isAuthenticated(primaryKey)) {
					const fallback = parseModelPattern(options.modelPatternAuthFallback, availableModels, matchPreferences);
					if (fallback.model) {
						const fallbackKey = await modelRegistry.getApiKey(fallback.model);
						if (isAuthenticated(fallbackKey)) {
							selectedModel = fallback.model;
							selectedThinkingLevel = fallback.thinkingLevel;
							selectedExplicitThinkingLevel = fallback.explicitThinkingLevel;
							authFallbackUsed = true;
						}
					}
				}
			}
			if (!authFallbackUsed && options.modelPatternFallbackRole) {
				const primarySelector = formatModelSelectorValue(
					formatModelStringWithRouting(primary.model),
					primary.thinkingLevel,
				);
				const seenSelectors = new Set<string>([primarySelector]);
				const fallbackSelectors: string[] = [];
				for (const fallbackPattern of expandedModelPatterns.slice(patternIndex + 1)) {
					const fallback = parseModelPattern(fallbackPattern, availableModels, matchPreferences);
					if (!fallback.model) continue;
					const fallbackSelector = formatModelSelectorValue(
						formatModelStringWithRouting(fallback.model),
						fallback.thinkingLevel,
					);
					if (seenSelectors.has(fallbackSelector)) continue;
					seenSelectors.add(fallbackSelector);
					fallbackSelectors.push(fallbackSelector);
				}
				if (fallbackSelectors.length > 0) {
					const modelRoles: Record<string, string> = {};
					const existingRoles = settings.getModelRoles();
					for (const role in existingRoles) {
						const selector = existingRoles[role];
						if (selector) {
							modelRoles[role] = selector;
						}
					}
					modelRoles[options.modelPatternFallbackRole] = primarySelector;
					settings.override("modelRoles", modelRoles);
					const fallbackChains: Record<string, string[]> = {
						[options.modelPatternFallbackRole]: fallbackSelectors,
					};
					const existingFallbackChains = settings.get("retry.fallbackChains");
					for (const role in existingFallbackChains) {
						if (role !== options.modelPatternFallbackRole) {
							fallbackChains[role] = existingFallbackChains[role];
						}
					}
					settings.override("retry.fallbackChains", fallbackChains);
				}
			}
			model = selectedModel;
			modelFallbackMessage = undefined;
			if (selectedExplicitThinkingLevel) {
				thinkingLevel = selectedThinkingLevel;
			} else {
				thinkingLevel = modelState.pickInitialThinkingLevel(selectedModel);
			}
			autoThinking = thinkingLevel === AUTO_THINKING;
			effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
			effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
				autoThinking
					? resolveProvisionalAutoLevel(selectedModel)
					: resolveThinkingLevelForModel(selectedModel, effectiveThinkingLevel),
			);
			preconnectModelHost(selectedModel.baseUrl);
			break;
		}
		if (!model) {
			modelFallbackMessage = modelResolutionFailureMessage(modelState.deferredModelPatterns, modelRegistry);
		}
	}

	if (!model && modelState.deferredModelPatterns.length === 0) {
		const tryResolveDefaultRole = async (): Promise<boolean> => {
			if (modelState.hasExplicitModel) return false;
			const fallbackCandidates = await resolveAllowedModels(
				modelRegistry,
				settings,
				modelState.modelMatchPreferences,
			);
			const reResolvedRoleSpec = resolveModelRoleValue(
				settings.getModelRole(DEFAULT_MODEL_SLOT),
				fallbackCandidates,
				{
					settings,
					matchPreferences: modelState.modelMatchPreferences,
				},
			);
			if (!reResolvedRoleSpec.model) return false;
			const resolvedDefaultModel = reResolvedRoleSpec.model;
			model = resolvedDefaultModel;
			modelFallbackMessage = undefined;
			thinkingLevel = modelState.pickInitialThinkingLevel(resolvedDefaultModel);
			autoThinking = thinkingLevel === AUTO_THINKING;
			effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
			effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
				autoThinking
					? resolveProvisionalAutoLevel(resolvedDefaultModel)
					: resolveThinkingLevelForModel(resolvedDefaultModel, effectiveThinkingLevel),
			);
			preconnectModelHost(resolvedDefaultModel.baseUrl);
			return true;
		};

		await tryResolveDefaultRole();

		if (!model) {
			const fallbackCandidates = await resolveAllowedModels(
				modelRegistry,
				settings,
				modelState.modelMatchPreferences,
			);
			let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));
			const defaultRoleConfigured = Boolean(settings.getModelRole(DEFAULT_MODEL_SLOT));
			if (
				!modelState.hasExplicitModel &&
				(defaultRoleConfigured || !pick) &&
				modelRegistry.getDiscoverableProviders().length > 0
			) {
				await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
				if (!(await tryResolveDefaultRole()) && !model) {
					const refreshedCandidates = await resolveAllowedModels(
						modelRegistry,
						settings,
						modelState.modelMatchPreferences,
					);
					pick = pickDefaultAvailableModel(refreshedCandidates.filter(hasModelAuth));
				}
			}

			if (!model && pick) {
				model = pick;
			}
		}
		if (model) {
			if (modelFallbackMessage) {
				modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
		} else {
			const patterns = settings.get("enabledModels");
			modelFallbackMessage =
				patterns && patterns.length > 0
					? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
					: modelResolutionFailureMessage([], modelRegistry);
		}
	}

	if (model) {
		const selectedModel = model;
		const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
			modelRegistry.refreshSelectedModelMetadata(selectedModel),
		);
		if (refreshedModel !== selectedModel) {
			model = refreshedModel;
			thinkingLevel = modelState.pickInitialThinkingLevel(refreshedModel);
			autoThinking = thinkingLevel === AUTO_THINKING;
			effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
			effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
				autoThinking
					? resolveProvisionalAutoLevel(refreshedModel)
					: resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
			);
		}
	}

	if (model) {
		const selectedModelAbort = createInterruptedTurnAbortMessage(modelState.existingBranch, {
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		if (selectedModelAbort) {
			sessionManager.appendMessage(selectedModelAbort);
			modelState.existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
			modelState.existingSession = logger.time("loadRecoveredUserTailContext", () =>
				sessionManager.buildSessionContext(),
			);
		}
	}

	const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
		? { commands: [], errors: [] }
		: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, {
				cwd,
				agentDir,
				adoptSpawnedPid,
				gateSpawn,
			});
	if (!options.disableExtensionDiscovery) {
		for (const { path: cmdPath, error } of customCommandsResult.errors) {
			logger.error("Failed to load custom command", { path: cmdPath, error });
		}
	}

	const extensionRunner: ExtensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		cwd,
		sessionManager,
		modelRegistry,
		() => (sessionRef.session ? createSessionMemoryRuntimeContext(sessionRef.session, agentDir, cwd) : undefined),
		settings,
		localProtocolOptions,
	);
	infra.setCredentialDisabledTarget(extensionRunner);

	const getSessionContext = (): CustomToolContext => ({
		sessionManager,
		modelRegistry,
		model: sessionRef.agent?.state.model,
		isIdle: () => (sessionRef.session ? !sessionRef.session.isStreaming : true),
		hasQueuedMessages: () => (sessionRef.session ? sessionRef.session.queuedMessageCount > 0 : false),
		abort: () => {
			if (sessionRef.session) abortDetached(sessionRef.session, "sdk.agentControl.abort", USER_INTERRUPT_LABEL);
		},
		settings,
		obfuscateProviderText: (text: string) => secrets.getLease().obfuscateText(text),
		localProtocolOptions,
		autoApprove: options.autoApprove ?? false,
		bypassAllApprovals: sessionRef.session ? sessionRef.session.isApprovalBypassed() : false,
		sessionApprovals: sessionRef.session ? sessionRef.session.sessionToolApprovals() : undefined,
	});
	const toolContextStore = new ToolContextStore(getSessionContext);
	toolSession.getToolContext = toolCall => toolContextStore.getContext(toolCall);

	const registeredTools = extensionRunner.getAllRegisteredTools();
	const sdkCustomTools = options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? [];
	const allCustomTools = [
		...registeredTools,
		...sdkCustomTools.map(tool => {
			const definition = isCustomTool(tool)
				? customToolToDefinition(tool, text => secrets.getLease().obfuscateText(text))
				: tool;
			return { definition, extensionPath: "<sdk>" };
		}),
	];
	const wrappedExtensionTools: Tool[] = wrapRegisteredTools(allCustomTools, extensionRunner).map(
		wrapToolWithMetaNotice,
	);

	const builtInRegistryToolNames = new Set<string>();
	const toolRegistry = new Map<string, Tool>();
	for (const tool of builtinTools) {
		toolRegistry.set(tool.name, tool);
		builtInRegistryToolNames.add(tool.name);
	}
	if (!toolRegistry.has(TOOL.goal) && settings.get("goal.enabled")) {
		const goalTool = await logger.time("createTools:goal:session", HIDDEN_TOOLS.goal, toolSession);
		if (goalTool) {
			toolRegistry.set(goalTool.name, wrapToolWithMetaNotice(goalTool));
			builtInRegistryToolNames.add(goalTool.name);
		}
	}
	for (const tool of wrappedExtensionTools) {
		toolRegistry.set(tool.name, tool);
		builtInRegistryToolNames.delete(tool.name);
	}
	if (deferMCPDiscoveryForUI && mcpManager) {
		for (const name of collectPendingMCPToolNames(
			options.toolNames,
			modelState.existingSession.selectedMCPToolNames,
		)) {
			if (!toolRegistry.has(name)) {
				toolRegistry.set(name, createPendingMCPTool(name));
			}
		}
	}

	for (const tool of toolRegistry.values()) {
		toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
	}

	const hasDeferrableTools = Array.from(toolRegistry.values()).some(tool => tool.deferrable === true);
	const planModeAvailable = settings.get("plan.enabled");
	const needsResolveTool = hasDeferrableTools || planModeAvailable;
	if (!needsResolveTool) {
		toolRegistry.delete(TOOL.resolve);
		builtInRegistryToolNames.delete(TOOL.resolve);
	} else if (!toolRegistry.has(TOOL.resolve)) {
		const resolveTool = await logger.time("createTools:resolve:session", HIDDEN_TOOLS.resolve, toolSession);
		if (resolveTool) {
			toolRegistry.set(resolveTool.name, wrapToolWithMetaNotice(resolveTool));
			builtInRegistryToolNames.add(resolveTool.name);
		}
	}

	let effectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
		settings,
		countToolsForAutoDiscovery(toolRegistry.keys()),
	);
	if (effectiveDiscoveryMode !== "off" && !toolRegistry.has(TOOL.search_tool_bm25)) {
		const searchTool: Tool = new SearchToolBm25Tool(toolSession);
		toolRegistry.set(
			searchTool.name,
			new ExtensionToolWrapper(wrapToolWithMetaNotice(searchTool), extensionRunner) as Tool,
		);
		builtInRegistryToolNames.add(searchTool.name);
	}
	let mcpDiscoveryEnabled = effectiveDiscoveryMode !== "off";

	async function enableDeferredMCPDiscoveryForTools(
		liveSession: AgentSession,
		mcpTools: CustomTool[],
	): Promise<boolean> {
		if (mcpDiscoveryEnabled) return true;
		const nonMCPToolNames = Array.from(toolRegistry.keys()).filter(name => !isMCPToolName(name));
		const projectedMode = resolveEffectiveToolDiscoveryMode(
			settings,
			countToolsForAutoDiscovery(nonMCPToolNames.concat(mcpTools.map(tool => tool.name))),
		);
		if (projectedMode === "off") return false;

		effectiveDiscoveryMode = projectedMode;
		mcpDiscoveryEnabled = true;
		liveSession.enableMCPDiscovery();
		if (!toolRegistry.has(TOOL.search_tool_bm25)) {
			const searchTool: Tool = new SearchToolBm25Tool(toolSession);
			toolRegistry.set(
				searchTool.name,
				new ExtensionToolWrapper(wrapToolWithMetaNotice(searchTool), extensionRunner) as Tool,
			);
		}
		if (!liveSession.getActiveToolNames().includes(TOOL.search_tool_bm25)) {
			await liveSession.setActiveToolsByName(liveSession.getActiveToolNames().concat([TOOL.search_tool_bm25]));
		}
		return true;
	}

	let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
	const cursorExecHandlers = new CursorExecHandlers({
		cwd,
		tools: toolRegistry,
		getToolContext: () => toolContextStore.getContext(),
		emitEvent: event => cursorEventEmitter?.(event),
	});

	const reloadSshTool = async (): Promise<AgentTool | null> => {
		const requestedToolNames = options.toolNames
			? normalizeToolNames(options.toolNames)
			: Array.from(toolRegistry.keys());
		if (!requestedToolNames.includes(TOOL.ssh)) return null;
		const sshTool = (await loadSshTool({
			...toolSession,
			cwd: sessionManager.getCwd(),
		})) as unknown as AgentTool | null;
		if (!sshTool) return null;
		const wrapped = wrapToolWithMetaNotice(sshTool);
		return new ExtensionToolWrapper(wrapped, extensionRunner) as AgentTool;
	};

	return {
		asyncJobManager,
		scopedAsyncJobManager,
		toolSession,
		mcpManager,
		deferMCPDiscoveryForUI,
		startDeferredMCPDiscovery,
		extensionsResult,
		extensionRunner,
		customCommandsResult,
		toolRegistry,
		builtInRegistryToolNames,
		effectiveDiscoveryMode,
		mcpDiscoveryEnabled,
		enableDeferredMCPDiscoveryForTools,
		cursorExecHandlers,
		reloadSshTool,
		model,
		modelFallbackMessage,
		thinkingLevel,
		autoThinking,
		effectiveThinkingLevel,
		thinkingSource,
		registeredTools,
		sdkCustomTools,
		toolContextStore,
		fileMutationVersions,
		activeToolNames,
		setActiveToolNames,
	};
}

interface SessionPromptAndToolSelection {
	initialToolNames: string[];
	initialSelectedMCPToolNames: string[];
	defaultSelectedMCPToolNames: string[];
	explicitlyRequestedMCPToolNames: string[];
	systemPrompt: string[];
	promptTemplates: PromptTemplate[];
	slashCommands: FileSlashCommand[];
	resolvedAgentId: string;
	resolvedAgentDisplayName: string;
	agentKind: "main" | "sub";
	unregisterUnlessParked: () => void;
	discoveryDefaultServers: Set<string>;
	setArgotContextTokens: (tokens: number) => void;
	rebuildSystemPrompt: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<BuildSystemPromptResult>;
	refreshProjectPromptInputs: () => Promise<void>;
}

async function setupSystemPromptAndToolSelection(params: {
	options: CreateAgentSessionOptions;
	infra: SessionInfrastructure;
	env: SessionEnvironment;
	secrets: SecretRuntimeController;
	modelState: SessionModelAndThinking;
	toolsExt: SessionToolsAndExtensions;
	sessionRef: { session?: AgentSession; agent?: Agent };
}): Promise<SessionPromptAndToolSelection> {
	const { options, infra, env, secrets, modelState, toolsExt, sessionRef } = params;
	const { cwd, agentDir, settings, sessionManager, operatorNotices } = infra;
	const { toolRegistry, builtInRegistryToolNames, toolSession, toolContextStore } = toolsExt;

	let promptInputCwd = cwd;
	let promptContextFiles = env.contextFiles;
	let promptWorkspaceTree: WorkspaceTree | Promise<WorkspaceTree> = env.workspaceTreePromise;
	let promptActiveRepoContext = env.activeRepoContext;
	let promptSkills = env.skills;
	let promptRulebookRules = modelState.rulebookRules;
	let promptAlwaysApplyRules = modelState.alwaysApplyRules;
	let argotContextTokens = 0;

	let projectInputRefresh: Promise<void> = Promise.resolve();
	const refreshProjectPromptInputs = async (): Promise<void> => {
		const requestedCwd = path.resolve(sessionManager.getCwd());
		if (requestedCwd === promptInputCwd) return;

		const refresh = projectInputRefresh
			.catch(() => undefined)
			.then(async () => {
				const liveCwd = path.resolve(sessionManager.getCwd());
				if (liveCwd === promptInputCwd) return;

				const currentSkillsSettings = settings.getGroup("skills");
				const currentDisabledExtensionIds = settings.get("disabledExtensions") ?? [];
				const nextWorkspaceTreePromise: Promise<WorkspaceTree> =
					options.workspaceTree !== undefined
						? Promise.resolve(options.workspaceTree)
						: (settings.get("includeWorkspaceTree") ?? false)
							? buildWorkspaceTree(liveCwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS })
							: Promise.resolve({
									rootPath: liveCwd,
									rendered: "",
									truncated: false,
									totalLines: 0,
									agentsMdFiles: [],
								});
				const nextActiveRepoContextPromise = (async () => {
					try {
						return await resolveActiveRepoContext(liveCwd);
					} catch (error) {
						logger.warn("Failed to resolve active repo context after cwd change", {
							cwd: liveCwd,
							error: errorMessage(error),
						});
						return null;
					}
				})();
				const nextSkillsPromise =
					options.skills !== undefined
						? Promise.resolve({ skills: options.skills, warnings: [] as SkillWarning[] })
						: discoverSkills(liveCwd, agentDir, {
								...currentSkillsSettings,
								disabledExtensions: currentDisabledExtensionIds,
							});
				const nextRulesPromise =
					options.rules !== undefined
						? Promise.resolve({ items: options.rules })
						: discoverRules(liveCwd, agentDir);
				const nextWatchdogFilesPromise = discoverWatchdogFiles(liveCwd, agentDir);
				const nextAdvisorConfigsPromise = discoverAdvisorConfigs(liveCwd, agentDir);

				const [
					nextContextFiles,
					nextWorkspaceTree,
					nextActiveRepoContext,
					nextSkillsResult,
					nextRulesResult,
					nextWatchdogFiles,
					nextAdvisorConfigs,
				] = await Promise.all([
					options.contextFiles !== undefined
						? Promise.resolve(options.contextFiles)
						: discoverContextFiles(liveCwd, agentDir),
					nextWorkspaceTreePromise,
					nextActiveRepoContextPromise,
					nextSkillsPromise,
					nextRulesPromise,
					nextWatchdogFilesPromise,
					nextAdvisorConfigsPromise,
				]);

				if (path.resolve(sessionManager.getCwd()) !== liveCwd) return;

				const previousTtsrRules = modelState.ttsrManager.getRules();
				modelState.ttsrManager.clearRules();
				let nextBuckets: RuleBuckets;
				try {
					const ttsrSettings = settings.getGroup("ttsr");
					nextBuckets = bucketRules(nextRulesResult.items, modelState.ttsrManager, {
						builtinRules: ttsrSettings.builtinRules,
						disabledRules: ttsrSettings.disabledRules,
						experimentalRules: ttsrSettings.experimentalRules,
					});
				} catch (error) {
					modelState.ttsrManager.clearRules();
					for (const rule of previousTtsrRules) modelState.ttsrManager.addRule(rule);
					throw error;
				}

				const nextAdvisorWatchdogPrompts = nextWatchdogFiles.slice();
				if (nextActiveRepoContext) {
					nextAdvisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(nextActiveRepoContext));
				}
				const nextAdvisorWatchdogPrompt =
					nextAdvisorWatchdogPrompts.length > 0 ? nextAdvisorWatchdogPrompts.join("\n\n") : undefined;
				const nextAdvisorContextPrompt = formatAdvisorContextPrompt(nextContextFiles);

				promptInputCwd = liveCwd;
				promptContextFiles = nextContextFiles;
				promptWorkspaceTree = nextWorkspaceTree;
				promptActiveRepoContext = nextActiveRepoContext;
				promptSkills = nextSkillsResult.skills;
				promptRulebookRules = nextBuckets.rulebookRules;
				promptAlwaysApplyRules = nextBuckets.alwaysApplyRules;

				toolSession.contextFiles = nextContextFiles;
				toolSession.workspaceTree = nextWorkspaceTree;
				toolSession.skills = nextSkillsResult.skills;
				toolSession.rules = nextRulesResult.items;
				if (sessionRef.session) sessionRef.session.replaceSkills(nextSkillsResult.skills);
				if (sessionRef.session) {
					sessionRef.session.replaceProjectAdvisorScope({
						advisorWatchdogPrompt: nextAdvisorWatchdogPrompt,
						advisorContextPrompt: nextAdvisorContextPrompt,
						advisorSharedInstructions: nextAdvisorConfigs.sharedInstructions,
						advisorConfigs: nextAdvisorConfigs.advisors,
					});
				}
				for (const warning of nextSkillsResult.warnings ?? []) {
					operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
				}
				modelState.ttsrManager.reportUnknownToolScopes(toolRegistry.keys());
				if (!isInProcessChildSession(options)) {
					setActiveSkills(nextSkillsResult.skills);
					setActiveRules([
						...nextBuckets.rulebookRules,
						...nextBuckets.alwaysApplyRules,
						...modelState.ttsrManager.getRules(),
					]);
				}
			});
		projectInputRefresh = refresh;
		await refresh;

		if (path.resolve(sessionManager.getCwd()) !== promptInputCwd) {
			await refreshProjectPromptInputs();
		}
	};

	const agentKind = modelState.sessionIsSubagent ? ("sub" as const) : ("main" as const);
	const getActiveModelString = (): string | undefined => {
		const activeModel = sessionRef.agent?.state.model;
		if (activeModel) return formatModelString(activeModel);
		if (toolsExt.model) return formatModelString(toolsExt.model);
		return undefined;
	};

	const rebuildSystemPrompt = async (
		toolNames: string[],
		tools: Map<string, AgentTool>,
	): Promise<BuildSystemPromptResult> => {
		await refreshProjectPromptInputs();
		toolContextStore.setToolNames(toolNames);
		const discoverableMCPTools: DiscoverableTool[] = toolsExt.mcpDiscoveryEnabled
			? filterBySource(collectDiscoverableTools(tools.values()), "mcp")
			: [];
		const activeToolNamesSet = new Set(toolNames);
		const discoverableLocalTools: DiscoverableTool[] =
			toolsExt.effectiveDiscoveryMode === "all"
				? Array.from(tools.values()).flatMap(tool => {
						if (tool.loadMode !== "discoverable" || activeToolNamesSet.has(tool.name)) return [];
						return collectDiscoverableTools([tool], {
							source: builtInRegistryToolNames.has(tool.name) ? "builtin" : "custom",
						});
					})
				: [];
		const discoverableToolsForDesc: DiscoverableTool[] = discoverableLocalTools.concat(discoverableMCPTools);
		const discoverableToolSummary = summarizeDiscoverableTools(discoverableToolsForDesc);
		const hasDiscoverableTools =
			toolsExt.mcpDiscoveryEnabled &&
			toolNames.includes(TOOL.search_tool_bm25) &&
			discoverableToolsForDesc.length > 0;
		const promptTools = buildSystemPromptToolMetadata(tools, {
			search_tool_bm25: { description: renderSearchToolBm25Description(discoverableToolsForDesc) },
		});
		const gateInputs = resolveGateInputs(settings, {
			tools,
			model: sessionRef.agent?.state.model ?? toolsExt.model,
			taskDepth: options.taskDepth ?? 0,
		});
		const memoryBackend = await resolveMemoryBackend(settings);
		const memoryInstructions = await memoryBackend.buildDeveloperInstructions(agentDir, settings, sessionRef.session);

		const serverInstructions = toolsExt.mcpManager?.getServerInstructions();
		const autoLearnInstructions = buildAutoLearnInstructions({
			manageSkill: builtInRegistryToolNames.has(TOOL.manage_skill),
			learn: builtInRegistryToolNames.has(TOOL.learn),
		});
		const appendParts: string[] = [];
		if (memoryInstructions) appendParts.push(memoryInstructions);
		if (autoLearnInstructions) appendParts.push(autoLearnInstructions);
		let appendPrompt: string | undefined = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;
		if (serverInstructions && serverInstructions.size > 0) {
			const parts: string[] = [];
			if (appendPrompt) parts.push(appendPrompt);
			parts.push(
				"## MCP Server Instructions\n\nThe following instructions are provided by connected MCP servers. They are server-controlled and may not be verified.",
			);
			for (const [srvName, srvInstructions] of serverInstructions) {
				const truncated =
					srvInstructions.length > MAX_MCP_INSTRUCTIONS_LENGTH
						? `${srvInstructions.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH)}\n[truncated]`
						: srvInstructions;
				parts.push(`### ${srvName}\n${truncated}`);
			}
			appendPrompt = parts.join("\n\n");
		}
		if (options.appendSystemPrompt) {
			appendPrompt = appendPrompt ? `${appendPrompt}\n\n${options.appendSystemPrompt}` : options.appendSystemPrompt;
		}
		const argotActiveModel = getActiveModelString();
		const argotCanEncode =
			modelState.argotEnabled &&
			modelState.argot !== undefined &&
			argotActiveModel !== undefined &&
			shouldEncode(modelState.argotGate, { model: argotActiveModel, contextTokens: argotContextTokens });
		const defaultPrompt = await buildSystemPromptInternal({
			...gateInputs,
			includeWorkspaceTree: settings.get("includeWorkspaceTree") ?? false,
			personality: agentKind === "sub" ? "none" : gateInputs.personality,
			cwd: promptInputCwd,
			agentDir,
			resolvedCustomPrompt: options.customSystemPrompt,
			skills: promptSkills,
			contextFiles: usesCursorRuleDelivery(sessionRef.agent?.state.model ?? toolsExt.model)
				? []
				: promptContextFiles,
			tools: promptTools,
			toolNames,
			rules: promptRulebookRules,
			alwaysApplyRules: promptAlwaysApplyRules,
			resolvedAppendSystemPrompt: appendPrompt,
			skillsSettings: settings.getGroup("skills"),
			mcpDiscoveryMode: hasDiscoverableTools,
			mcpDiscoveryServerSummaries: discoverableToolSummary.servers.map(formatDiscoverableToolServerSummary),
			secretsEnabled: secrets.getObfuscator()?.hasSecrets() === true,
			secretInventory: renderSecretInventory(secrets.getObfuscator()?.namedSecretNames()),
			argotPreamble: argotCanEncode ? renderPreamble({ tools: true }) : undefined,
			argotHandles: argotCanEncode && modelState.argot?.loaded ? modelState.argot.promptFragment() : undefined,
			workspaceTree: promptWorkspaceTree,
			memoryRootEnabled: memoryBackend.id === "local",
			model: getActiveModelString(),
			activeRepoContext: promptActiveRepoContext,
			sectionOrder: resolvePromptSectionOrderForModel(settings, sessionRef.agent?.state.model ?? toolsExt.model),
		});

		if (options.systemPrompt === undefined) {
			return defaultPrompt;
		}
		const customPrompt =
			typeof options.systemPrompt === "function"
				? options.systemPrompt(defaultPrompt.systemPrompt)
				: options.systemPrompt;
		return {
			systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			statementContext: null,
			statementOverrides: null,
			replacedStatementSections: [],
		};
	};

	const toolNamesFromRegistry = Array.from(toolRegistry.keys());
	const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
	if (
		options.requireYieldTool === true &&
		explicitlyRequestedToolNames &&
		!explicitlyRequestedToolNames.includes(TOOL.yield)
	) {
		explicitlyRequestedToolNames.push(TOOL.yield);
	}
	if (explicitlyRequestedToolNames) {
		for (const name of [TOOL.manage_skill, TOOL.learn]) {
			if (builtInRegistryToolNames.has(name) && !explicitlyRequestedToolNames.includes(name)) {
				explicitlyRequestedToolNames.push(name);
			}
		}
	}
	const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
	const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));

	modelState.ttsrManager.reportUnknownToolScopes(toolRegistry.keys());
	const defaultInactiveToolNames = new Set(
		toolsExt.registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
	);
	const discoveryDefaultServers = new Set(
		(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
	);
	const discoveryDefaultServerToolNames = toolsExt.mcpDiscoveryEnabled
		? selectDiscoverableToolNamesByServer(
				filterBySource(collectDiscoverableTools(toolRegistry.values()), "mcp"),
				discoveryDefaultServers,
			)
		: [];
	const alwaysInclude: string[] = [
		...toolsExt.sdkCustomTools.map(t => (isCustomTool(t) ? t.name : t.name)),
		...toolsExt.registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
	];

	const {
		initialToolNames,
		initialSelectedMCPToolNames,
		defaultSelectedMCPToolNames,
		explicitlyRequestedMCPToolNames,
	} = resolveInitialActiveToolNames({
		explicitToolNames: options.toolNames ? normalizeToolNames(options.toolNames) : undefined,
		requestedToolNames: normalizedRequested,
		goalEnabled: settings.get("goal.enabled"),
		defaultInactiveToolNames,
		hasRegistryTool: name => toolRegistry.has(name),
		mcpDiscoveryEnabled: toolsExt.mcpDiscoveryEnabled,
		discoveryDefaultServerToolNames,
		persistedSelectedMCPToolNames: modelState.existingSession.selectedMCPToolNames,
		hasPersistedMCPToolSelection: modelState.existingSession.hasPersistedMCPToolSelection,
		alwaysIncludeToolNames: alwaysInclude,
		effectiveDiscoveryMode: toolsExt.effectiveDiscoveryMode,
		loadModeOf: name => toolRegistry.get(name)?.loadMode,
		essentialToolNames: computeEssentialBuiltinNames(settings),
		forceActiveToolNames: resolveDiscoveryAllForceActive({
			todoEager: settings.get("todo.eager"),
			todoEnabled: settings.get("todo.enabled"),
			hasTodoTool: toolRegistry.has(TOOL.todo),
			delegationStrength: delegationStrength(settings),
			hasTaskTool: toolRegistry.has(TOOL.task),
		}),
		harnessToolAllowlist: resolveHarnessProfileForModel(settings, toolsExt.model)?.tools,
	});

	const conversationId = sessionManager.getSessionId?.();
	const resolvedAgentId =
		options.agentId ??
		options.parentTaskPrefix ??
		(!modelState.sessionIsSubagent && conversationId ? mainAgentIdFor(conversationId) : MAIN_AGENT_ID);
	const resolvedAgentDisplayName = options.agentDisplayName ?? (modelState.sessionIsSubagent ? "sub" : "main");

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	agentRegistry.register({
		id: resolvedAgentId,
		displayName: resolvedAgentDisplayName,
		kind: agentKind,
		parentId: options.parentAgentId,
		session: null,
		sessionFile: sessionManager.getSessionFile() ?? null,
		scope: options.parentAgentId ? undefined : (sessionManager.getSessionId?.() ?? undefined),
		status: "running",
		model: getActiveModelString(),
	});

	const unregisterUnlessParked = (): void => {
		if (agentRegistry.get(resolvedAgentId)?.status === "parked") return;
		if (AgentLifecycleManager.global().isParking(resolvedAgentId)) return;
		agentRegistry.unregister(resolvedAgentId);
	};

	toolsExt.setActiveToolNames(initialToolNames);
	const { systemPrompt } = await logger.time("buildSystemPrompt", rebuildSystemPrompt, initialToolNames, toolRegistry);

	const promptTemplates = await env.promptTemplatesPromise;
	toolSession.promptTemplates = promptTemplates;
	const slashCommands = await env.slashCommandsPromise;

	return {
		initialToolNames,
		initialSelectedMCPToolNames,
		defaultSelectedMCPToolNames,
		explicitlyRequestedMCPToolNames,
		systemPrompt,
		promptTemplates,
		slashCommands,
		resolvedAgentId,
		resolvedAgentDisplayName,
		agentKind,
		unregisterUnlessParked,
		discoveryDefaultServers,
		setArgotContextTokens: (tokens: number) => {
			argotContextTokens = tokens;
		},
		rebuildSystemPrompt,
		refreshProjectPromptInputs,
	};
}

async function initializeAgentAndSession(params: {
	options: CreateAgentSessionOptions;
	infra: SessionInfrastructure;
	env: SessionEnvironment;
	secrets: SecretRuntimeController;
	modelState: SessionModelAndThinking;
	toolsExt: SessionToolsAndExtensions;
	promptState: SessionPromptAndToolSelection;
	sessionRef: { session?: AgentSession; agent?: Agent };
}): Promise<CreateAgentSessionResult> {
	const { options, infra, env, secrets, modelState, toolsExt, promptState, sessionRef } = params;
	const { cwd, agentDir, settings, sessionManager, operatorNotices, eventBus, modelRegistry, providerSessionId } =
		infra;

	const initialTools = promptState.initialToolNames
		.map(name => toolsExt.toolRegistry.get(name))
		.filter((tool): tool is AgentTool => tool !== undefined);

	const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "auto";
	const preferOpenAICodexWebsockets =
		openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
	const initialServiceTierByFamily = modelState.hasServiceTierEntry
		? (modelState.existingSession.serviceTier ?? {})
		: buildServiceTierByFamily(
				settings.get("tier.openai"),
				settings.get("tier.anthropic"),
				settings.get("tier.google"),
			);

	let notifyFirstChatDispatch = options.onFirstChatDispatch;
	const settingsAwareStreamFn = wrapStreamFnWithProviderConcurrency(settings, createSettingsAwareStreamFn(settings));
	const callerTelemetryTextSanitizer = options.telemetry?.textSanitizer;
	const telemetry: AgentTelemetryConfig = {
		...(options.telemetry ?? {}),
		textSanitizer: text =>
			secrets.getLease().obfuscateText(callerTelemetryTextSanitizer ? callerTelemetryTextSanitizer(text) : text),
	};

	const notifiedDialectFallbackModels = new Set<string>();
	const agent = new Agent({
		initialState: {
			systemPrompt: promptState.systemPrompt,
			model: toolsExt.model,
			thinkingLevel: toReasoningEffort(toolsExt.effectiveThinkingLevel),
			disableReasoning: shouldDisableReasoning(toolsExt.effectiveThinkingLevel),
			tools: initialTools,
		},
		cwd,
		cwdResolver: () => sessionManager.getCwd(),
		convertToLlm: messages => secrets.convertToLlmFinal(messages),
		onPayload: async (payload, _model) =>
			(await toolsExt.extensionRunner.emitBeforeProviderRequest(payload)) ?? payload,
		onResponse: async (response, model) => {
			await toolsExt.extensionRunner.emitAfterProviderResponse(response, model);
		},
		sessionId: providerSessionId,
		promptCacheKey: infra.providerPromptCacheKey,
		deadline: options.deadline,
		transformContext: messages => secrets.transformContext(messages, toolsExt.extensionRunner),
		transformProviderContext: (context: Context, _transformModel: Model, requestRuntime?: SecretRuntimeLease) =>
			secrets.transformProviderContext(context, requestRuntime),
		steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
		followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
		interruptMode: settings.get("interruptMode") ?? "immediate",
		thinkingBudgets: settings.getGroup("thinkingBudgets"),
		temperature: optionalNumber(settings.get("temperature")),
		topP: optionalNumber(settings.get("topP")),
		topK: optionalNumber(settings.get("topK")),
		minP: optionalNumber(settings.get("minP")),
		presencePenalty: optionalNumber(settings.get("presencePenalty")),
		repetitionPenalty: optionalNumber(settings.get("repetitionPenalty")),
		hideThinkingSummary: settings.get("omitThinking"),
		kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
		preferWebsockets: preferOpenAICodexWebsockets,
		getToolContext: tc => toolsExt.toolContextStore.getContext(tc),
		getApiKey: requestModel => modelRegistry.resolver(requestModel, agent.sessionId ?? ""),
		streamFn: async (streamModel, context, streamOptions) => {
			if (notifyFirstChatDispatch) {
				const cb = notifyFirstChatDispatch;
				notifyFirstChatDispatch = undefined;
				try {
					cb();
				} catch (err) {
					logger.warn("onFirstChatDispatch hook threw", {
						error: errorMessage(err),
					});
				}
			}
			const runtime = secrets.resolveSecretRuntimeForContext(context) ?? secrets.getActiveMainRequestRuntime();
			const optionsForRequest = streamOptions ?? {};
			const requestOnPayload = optionsForRequest.onPayload;
			const leasedOnPayload =
				runtime.hasRedactions || requestOnPayload
					? async (payload: unknown, payloadModel?: Model) => {
							const replacement = requestOnPayload ? await requestOnPayload(payload, payloadModel) : undefined;
							return runtime.obfuscatePayload(replacement ?? payload);
						}
					: undefined;
			return settingsAwareStreamFn(streamModel, context, {
				...optionsForRequest,
				onPayload: leasedOnPayload,
			});
		},
		cursorExecHandlers: toolsExt.cursorExecHandlers,
		cursorRulesResolver: () => cursorContextFileRules(env.contextFiles),
		transformToolCallArguments: (args, toolName) =>
			secrets.transformToolCallArguments(
				args,
				toolName,
				modelState.argot,
				agent.sessionId ?? "",
				(level, msg, src) => sessionRef.session?.emitNotice(level, msg, src),
			),
		repairToolCallArguments: createRepairToolCallArgumentsHook(settings, () => agent.state.model),
		intentTracing: () => resolveIntentField(settings) !== undefined,
		instrumentation: settings.get("session.instrumentation"),
		pruneToolDescriptions: (requestModel: Model) =>
			shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), requestModel.id),
		dialect: requestModel => {
			const dialect = resolveDialect(settings.get("tools.format"), requestModel);
			if (dialect !== undefined && requestModel.supportsTools === false) {
				const modelKey = `${requestModel.provider}/${requestModel.id}`;
				if (!notifiedDialectFallbackModels.has(modelKey)) {
					notifiedDialectFallbackModels.add(modelKey);
					sessionRef.session?.emitNotice(
						"warning",
						`${modelKey} is cataloged as non-tool-calling; tools are delivered through the "${dialect}" text dialect instead of the native tools parameter.`,
						"tools.format",
					);
				}
			}
			return dialect;
		},
		abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
		getToolChoice: () => sessionRef.session?.nextToolChoiceDirective(),
		telemetry,
		appendOnlyContext: toolsExt.model
			? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), toolsExt.model)
				? new AppendOnlyContextManager()
				: undefined
			: undefined,
	});
	sessionRef.agent = agent;

	if (modelState.argotEnabled && modelState.argotGate.disableAboveTokens > 0) {
		agent.subscribe(event => {
			if (event.type !== "turn_end") return;
			const usage = (event.message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage;
			if (usage) {
				// Usage context tokens update
			}
		});
	}

	if (modelState.hasExistingSession) {
		agent.replaceMessages(modelState.existingSession.messages);
	} else {
		if (toolsExt.model) {
			sessionManager.appendModelChange(`${toolsExt.model.provider}/${toolsExt.model.id}`);
		}
		if (!toolsExt.autoThinking) {
			sessionManager.appendThinkingLevelChange(toolsExt.effectiveThinkingLevel);
		}
		if (Object.keys(initialServiceTierByFamily).length > 0) {
			sessionManager.appendServiceTierChange(initialServiceTierByFamily);
		}
	}

	const advisorToolSession: ToolSession = {
		...toolsExt.toolSession,
		get cwd() {
			return sessionManager.getCwd();
		},
		setCwd: async (resolvedPath, setOptions) =>
			sessionRef.session
				? sessionRef.session.setCwd(resolvedPath, setOptions)
				: sessionManager.setCwd(resolvedPath, setOptions),
		hasEditTool: true,
		requireYieldTool: false,
		getSessionId: () => {
			const id = sessionManager.getSessionId?.();
			return id ? `${id}-advisor` : null;
		},
		getAgentId: () => "advisor",
	};
	const advisorToolBuilds: Array<Tool | null | Promise<Tool | null>> = [];
	for (const name in BUILTIN_TOOLS) {
		advisorToolBuilds.push(BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS](advisorToolSession));
	}
	const builtAdvisorTools = await Promise.all(advisorToolBuilds);
	const advisorTools: Tool[] = builtAdvisorTools
		.filter((tool): tool is Tool => tool != null)
		.map(wrapToolWithMetaNotice);

	const advisorWatchdogPrompts = env.watchdogFiles.slice();
	if (env.activeRepoContext) {
		advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(env.activeRepoContext));
	}
	const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
	const advisorContextPrompt = formatAdvisorContextPrompt(env.contextFiles);
	const ownedMcpManager = options.mcpManager ? undefined : toolsExt.mcpManager;

	const session = new AgentSession({
		advisorWatchdogPrompt,
		advisorContextPrompt,
		advisorSharedInstructions: env.discoveredAdvisors.sharedInstructions,
		advisorConfigs: env.discoveredAdvisors.advisors,
		agent,
		pruneToolDescriptions: (requestModel: Model) =>
			shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), requestModel.id),
		thinkingLevel: toolsExt.autoThinking ? AUTO_THINKING : toolsExt.effectiveThinkingLevel,
		thinkingSource: toolsExt.thinkingSource,
		prewalk: options.prewalk,
		planYolo: options.planYolo,
		serviceTierByFamily: initialServiceTierByFamily,
		sessionManager,
		settings,
		autoApprove: options.autoApprove,
		bypassAllApprovals: options.bypassAllApprovals,
		parentApprovalBypassed: options.parentApprovalBypassed,
		evalKernelOwnerId: infra.evalKernelOwnerId,
		ownedAsyncJobManager: toolsExt.asyncJobManager,
		asyncJobManager: toolsExt.scopedAsyncJobManager,
		scopedModels: options.scopedModels,
		promptTemplates: promptState.promptTemplates,
		slashCommands: promptState.slashCommands,
		extensionRunner: toolsExt.extensionRunner,
		customCommands: toolsExt.customCommandsResult.commands,
		skills: env.skills,
		operatorNotices,
		skillsSettings: settings.getGroup("skills"),
		modelRegistry,
		toolRegistry: toolsExt.toolRegistry,
		createVibeTools: modelState.sessionIsSubagent ? undefined : () => createVibeTools(toolsExt.toolSession),
		isSubagent: modelState.sessionIsSubagent,
		builtInToolNames: toolsExt.builtInRegistryToolNames,
		transformContext: messages => secrets.transformContext(messages, toolsExt.extensionRunner),
		transformProviderContext: context => secrets.transformProviderContext(context),
		onPayload: async (payload, _model) =>
			(await toolsExt.extensionRunner.emitBeforeProviderRequest(payload)) ?? payload,
		onResponse: async (response, model) => {
			await toolsExt.extensionRunner.emitAfterProviderResponse(response, model);
		},
		sideStreamFn: settingsAwareStreamFn,
		preferWebsockets: preferOpenAICodexWebsockets,
		convertToLlm: messages => secrets.convertToLlmFinal(messages),
		rebuildSystemPrompt: promptState.rebuildSystemPrompt,
		reloadSshTool: toolsExt.reloadSshTool,
		requestedToolNames: new Set(promptState.initialToolNames),
		setActiveToolNames: toolsExt.setActiveToolNames,
		getMcpServerInstructions: toolsExt.mcpManager
			? () => {
					const raw = toolsExt.mcpManager!.getServerInstructions();
					if (!raw || raw.size === 0) return raw;
					const out = new Map<string, string>();
					for (const [name, text] of raw) {
						out.set(
							name,
							text.length > MAX_MCP_INSTRUCTIONS_LENGTH ? text.slice(0, MAX_MCP_INSTRUCTIONS_LENGTH) : text,
						);
					}
					return out;
				}
			: undefined,
		disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
		mcpDiscoveryEnabled: toolsExt.mcpDiscoveryEnabled,
		initialSelectedMCPToolNames: promptState.initialSelectedMCPToolNames,
		defaultSelectedMCPToolNames: promptState.defaultSelectedMCPToolNames,
		persistInitialMCPToolSelection: !modelState.hasExistingSession,
		defaultSelectedMCPServerNames: Array.from(promptState.discoveryDefaultServers),
		ttsrManager: modelState.ttsrManager,
		obfuscator: secrets.getObfuscator(),
		secretRuntime: secrets.getLease(),
		leaseSecretRuntime: () => secrets.leaseSecretRuntime(),
		resolveSecretRuntimeLeaseForContext: context => secrets.resolveSecretRuntimeForContext(context),
		refreshSecretRuntime: runtimeCwd => secrets.refreshSecretRuntime(runtimeCwd),
		argot: modelState.argot,
		agentId: promptState.resolvedAgentId,
		agentKind: promptState.agentKind,
		providerSessionId: options.providerSessionId,
		providerPromptCacheKeySource: infra.providerPromptCacheKeySource,
		parentEvalSessionId: options.parentEvalSessionId,
		advisorTools,
		titleSystemPrompt: options.titleSystemPrompt,
	});
	sessionRef.session = session;
	secrets.setSession(session);

	if (
		shouldAutoloadArgotAtStartup({
			enabled: modelState.argotEnabled,
			autoload: settings.get("argot.autoload"),
			argot: modelState.argot,
		}) &&
		modelState.argot !== undefined
	) {
		const activeArgot = modelState.argot;
		void armArgotAfterStartup({
			argot: activeArgot,
			cwd,
			tokenBudget: settings.get("argot.tokenBudget"),
			onArmed: async () => {
				const armPrompt = await session.refreshBaseSystemPrompt("argot-arm");
				const joined = armPrompt.join("\n\n");
				const taughtHandles = activeArgot.loaded ? activeArgot.vocabulary().handles.size : 0;
				const inPrompt = joined.includes(ARGOT_HANDLES_BANNER);
				sessionManager.appendCustomMessageEntry(
					"argot_taught",
					inPrompt
						? `argot: system prompt refreshed, teaching ${taughtHandles} handle${taughtHandles === 1 ? "" : "s"}`
						: "argot: system prompt refreshed but the handle table is ABSENT; the model was taught no handles",
					false,
					{ handles: taughtHandles, inPrompt, promptChars: joined.length },
					"agent",
				);
				if (!inPrompt) {
					logger.error("argot: refreshed system prompt carries no handle table; session is effectively UNARMED", {
						cwd,
						handles: taughtHandles,
					});
				}
			},
			onResolved: vocab => {
				sessionManager.appendCustomMessageEntry(
					"argot_armed",
					`argot: launch project armed with ${vocab.handles} handle${vocab.handles === 1 ? "" : "s"}`,
					false,
					vocab,
					"agent",
				);
			},
			onFailed: info => {
				sessionManager.appendCustomMessageEntry(
					"argot_arm_failed",
					`argot: launch project FAILED to arm (${info.error}); no handles taught this session`,
					false,
					info,
					"agent",
				);
			},
		});
	}

	if (promptState.agentKind === "main" && !modelState.hasExistingSession) {
		sessionManager.appendSessionInit({
			systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
			task: "",
			tools: session.getActiveToolNames(),
		});
	}

	if (!modelState.hasExistingSession) {
		sessionManager.appendSettingsSnapshot(settings.getEffectiveSnapshot());
	}

	if (toolsExt.asyncJobManager) {
		const managedJobs = toolsExt.asyncJobManager;
		session.yieldQueue.register<AsyncResultEntry>("async-result", {
			isStale: entry => managedJobs.isDeliverySuppressed(entry.jobId),
			build: buildAsyncResultBatchMessage,
		});
	}
	session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
		build: buildMcpNotificationBatchMessage,
	});
	session.yieldQueue.register<DeferredDiagnosticsEntry>(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, {
		isStale: entry => entry.isStale(),
		build: buildLateDiagnosticsBatchMessage,
	});

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	agentRegistry.attachSession(promptState.resolvedAgentId, session, sessionManager.getSessionFile() ?? null);
	session.subscribe(event => {
		if (event.type === "agent_start" || event.type === "agent_end") {
			agentRegistry.noteTurn(promptState.resolvedAgentId);
		}
	});

	{
		const originalDispose = session.dispose.bind(session);
		let disposeCall: Promise<void> | undefined;
		session.dispose = disposeOptions => {
			if (!disposeCall) {
				disposeCall = (async () => {
					try {
						session.beginDispose();
						if (promptState.agentKind === "main") {
							await AgentLifecycleManager.global().dispose();
						}
						await originalDispose(disposeOptions);
					} finally {
						try {
							await secrets.flushAuditLog();
						} finally {
							infra.detachFaultSink?.();
							infra.detachSecretsNoticeSink?.();
							promptState.unregisterUnlessParked();
							infra.unsubscribeCredentialDisabled?.();
						}
					}
				})();
			}
			return disposeCall;
		};
	}

	if (toolsExt.model?.api === "openai-codex-responses") {
		const codexModel = toolsExt.model as Model<"openai-codex-responses">;
		const codexTransport = getOpenAICodexTransportDetails(codexModel, {
			sessionId: providerSessionId,
			baseUrl: codexModel.baseUrl,
			preferWebsockets: preferOpenAICodexWebsockets,
			providerSessionState: session.providerSessionState,
		});
		if (codexTransport.websocketPreferred) {
			void (async () => {
				try {
					const codexPrewarmApiKey = await modelRegistry.getApiKey(codexModel, providerSessionId);
					if (!codexPrewarmApiKey) return;
					await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
						apiKey: codexPrewarmApiKey,
						sessionId: providerSessionId,
						preferWebsockets: preferOpenAICodexWebsockets,
						providerSessionState: session.providerSessionState,
					});
				} catch (error) {
					logger.debug("Codex websocket prewarm failed", {
						error: errorMessage(error),
						provider: codexModel.provider,
						model: codexModel.id,
					});
				}
			})();
		}
	}

	const enableLsp = options.enableLsp ?? true;
	const startupQuiet = settings.get("startup.quiet");

	let lspServers: CreateAgentSessionResult["lspServers"];
	if (enableLsp && options.hasUI && settings.get("lsp.lazy")) {
		lspServers = discoverStartupLspServers(cwd, "available");
	} else if (enableLsp && options.hasUI) {
		lspServers = discoverStartupLspServers(cwd);
		if (lspServers.length > 0) {
			void (async () => {
				try {
					const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
					const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
					for (const server of lspServers ?? []) {
						const next = serversByName.get(server.name);
						if (!next) continue;
						server.status = next.status;
						server.fileTypes = next.fileTypes;
						server.error = next.error;
					}
					const event: LspStartupEvent = {
						type: "completed",
						servers: result.servers,
					};
					if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
				} catch (error) {
					const errorText = errorMessage(error);
					logger.warn("LSP server warmup failed", { cwd, error: errorText });
					for (const server of lspServers ?? []) {
						server.status = "error";
						server.error = errorText;
					}
					const event: LspStartupEvent = {
						type: "failed",
						error: errorText,
					};
					if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
				}
			})();
		}
	}

	const taskDepth = options.taskDepth ?? 0;
	session.deferStartupWork(
		logger
			.time("startMemoryStartupTask", async () => {
				const memoryBackend = await resolveMemoryBackend(settings);
				await memoryBackend.start({
					session,
					settings,
					modelRegistry,
					agentDir,
					taskDepth,
					parentHindsightSessionState: options.parentHindsightSessionState,
					parentMnemopiSessionState: options.parentMnemopiSessionState,
				});
			})
			.catch(error => {
				logger.warn("memory backend startup failed", { error: errorMessage(error) });
			}),
	);

	if (settings.get("autolearn.enabled") && taskDepth === 0) {
		new AutoLearnController({ session, settings });
	}

	if (toolsExt.mcpManager && !options.mcpManager) {
		const reactiveMcpManager = toolsExt.mcpManager;
		const mcpCpu = sessionCpuExecHooks(() => session.sessionManager.getSessionId() ?? null);
		reactiveMcpManager.setSpawnAdoption(mcpCpu.adoptPid);
		reactiveMcpManager.setSpawnGate(mcpCpu.gate);
		reactiveMcpManager.setOnToolsChanged(tools => {
			void (async () => {
				try {
					let activateAll = toolsExt.deferMCPDiscoveryForUI && !toolsExt.mcpDiscoveryEnabled;
					if (activateAll && (await toolsExt.enableDeferredMCPDiscoveryForTools(session, tools))) {
						activateAll = false;
					}
					await session.refreshMCPTools(tools, activateAll ? { activateAll: true } : undefined);
				} catch (error) {
					logger.warn("MCP tool refresh failed", {
						error: errorMessage(error),
					});
				}
			})();
		});
		reactiveMcpManager.setOnPromptsChanged(serverName => {
			const promptCommands = buildMCPPromptCommands(reactiveMcpManager);
			session.setMCPPromptCommands(promptCommands);
			logger.debug("MCP prompt commands refreshed", { path: `mcp:${serverName}` });
		});

		const notificationDebounceTimers = new Map<string, Timer>();
		const clearDebounceTimers = () => {
			for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
			notificationDebounceTimers.clear();
		};
		postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
		reactiveMcpManager.setOnResourcesChanged((serverName, uri) => {
			logger.debug("MCP resources changed", { path: `mcp:${serverName}`, uri });
			if (!settings.get("mcp.notifications")) return;
			const debounceMs = settings.get("mcp.notificationDebounceMs");
			const key = `${serverName}:${uri}`;
			const existing = notificationDebounceTimers.get(key);
			if (existing) clearTimeout(existing);
			notificationDebounceTimers.set(
				key,
				setTimeout(() => {
					notificationDebounceTimers.delete(key);
					if (!settings.get("mcp.notifications")) return;
					session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
				}, debounceMs),
			);
		});
	}

	toolsExt.startDeferredMCPDiscovery?.(session, {
		mcpDiscoveryEnabled: toolsExt.mcpDiscoveryEnabled,
		explicitlyRequestedMCPToolNames: promptState.explicitlyRequestedMCPToolNames,
		activateAllMCPTools: !toolsExt.mcpDiscoveryEnabled,
	});

	return {
		session,
		extensionsResult: toolsExt.extensionsResult,
		setToolUIContext: (uiContext, hasUI) => toolsExt.toolContextStore.setUIContext(uiContext, hasUI),
		mcpManager: toolsExt.mcpManager,
		modelFallbackMessage: toolsExt.modelFallbackMessage,
		lspServers,
		eventBus,
	};
}

async function cleanupFailedSessionStartup(params: {
	session?: AgentSession;
	hasRegistered: boolean;
	unregisterUnlessParked: () => void;
	asyncJobManager?: AsyncJobManager;
	evalKernelOwnerId: string;
	mcpManager?: MCPManager;
	options: CreateAgentSessionOptions;
	sessionManager?: SessionManager;
	ownsAuthStorage: boolean;
	authStorage: AuthStorage;
	unsubscribeCredentialDisabled?: () => void;
	detachFaultSink?: () => void;
	detachSecretsNoticeSink?: () => void;
}): Promise<void> {
	params.unsubscribeCredentialDisabled?.();
	params.detachFaultSink?.();
	params.detachSecretsNoticeSink?.();
	try {
		if (params.session) {
			await params.session.dispose();
		} else {
			if (params.hasRegistered) params.unregisterUnlessParked();
			if (params.asyncJobManager) {
				if (AsyncJobManager.instance() === params.asyncJobManager) AsyncJobManager.setInstance(undefined);
				await params.asyncJobManager.dispose({ timeoutMs: 3_000 });
			}
			if (params.evalKernelOwnerId) {
				await disposeKernelSessionsByOwner(params.evalKernelOwnerId);
				await disposeRubyKernelSessionsByOwner(params.evalKernelOwnerId);
				await disposeJuliaKernelSessionsByOwner(params.evalKernelOwnerId);
				await disposeVmContextsByOwner(params.evalKernelOwnerId);
			}
			if (params.mcpManager && params.mcpManager !== params.options.mcpManager) {
				await params.mcpManager.disconnectAll();
			}
			if (!params.options.sessionManager) await params.sessionManager?.close();
			if (params.ownsAuthStorage) params.authStorage.close();
		}
	} catch (cleanupError) {
		logger.warn("Failed to clean up createAgentSession resources after startup error", {
			error: errorMessage(cleanupError),
		});
	}
}

/**
 * Create an AgentSession with the specified options.
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const infra = await setupSessionInfrastructure(options);
	const sessionRef: { session?: AgentSession; agent?: Agent } = {};
	let hasRegistered = false;
	let unregisterUnlessParked = (): void => {};
	let asyncJobManager: AsyncJobManager | undefined;
	let mcpManager: MCPManager | undefined = options.mcpManager;

	try {
		const env = await discoverSessionEnvironment({
			cwd: infra.cwd,
			agentDir: infra.agentDir,
			settings: infra.settings,
			options,
			operatorNotices: infra.operatorNotices,
		});
		const secrets = await setupSecretRuntime({
			cwd: infra.cwd,
			agentDir: infra.agentDir,
			globalConfigRoot: infra.globalConfigRoot,
			settings: infra.settings,
			operatorNotices: infra.operatorNotices,
			sessionManager: infra.sessionManager,
		});
		const modelState = await resolveSessionModelAndThinking({
			options,
			cwd: infra.cwd,
			agentDir: infra.agentDir,
			settings: infra.settings,
			sessionManager: infra.sessionManager,
			modelRegistry: infra.modelRegistry,
		});
		const toolsExt = await setupSessionToolsAndExtensions({ options, infra, env, secrets, modelState, sessionRef });
		asyncJobManager = toolsExt.asyncJobManager;
		mcpManager = toolsExt.mcpManager;

		const promptState = await setupSystemPromptAndToolSelection({
			options,
			infra,
			env,
			secrets,
			modelState,
			toolsExt,
			sessionRef,
		});
		hasRegistered = true;
		unregisterUnlessParked = promptState.unregisterUnlessParked;

		return await initializeAgentAndSession({
			options,
			infra,
			env,
			secrets,
			modelState,
			toolsExt,
			promptState,
			sessionRef,
		});
	} catch (error) {
		await cleanupFailedSessionStartup({
			session: sessionRef.session,
			hasRegistered,
			unregisterUnlessParked,
			asyncJobManager,
			evalKernelOwnerId: infra.evalKernelOwnerId,
			mcpManager,
			options,
			sessionManager: infra.sessionManager,
			ownsAuthStorage: infra.ownsAuthStorage,
			authStorage: infra.authStorage,
			unsubscribeCredentialDisabled: infra.unsubscribeCredentialDisabled,
			detachFaultSink: infra.detachFaultSink,
			detachSecretsNoticeSink: infra.detachSecretsNoticeSink,
		});
		throw error;
	}
}
