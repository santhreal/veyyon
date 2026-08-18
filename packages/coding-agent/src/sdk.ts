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
import type { Context, CredentialDisabledEvent, Message, Model, SimpleStreamOptions } from "@veyyon/ai";
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
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
} from "./advisor";
import { armArgotAfterStartup } from "./argot-cache";
import { type AsyncJob, AsyncJobManager, type AsyncJobType } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
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
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import { CursorExecHandlers, cursorContextFileRules, usesCursorRuleDelivery } from "./cursor";
import { DEFAULT_PLAN_FILE_URL } from "./plan-mode/plan-file-url";
import { resolveGateInputs, resolveIntentField } from "./system-prompt-builder/gate-inputs";
import "./discovery";
import { type ArgotGate, type ArgotSession, renderPreamble, shouldEncode } from "argot";
import {
	collectArgotLoadedRoots,
	createArgotSession,
	rearmArgotForDecode,
	shouldAutoloadArgotAtStartup,
} from "./argot-cache";
import { buildArgotGate, expandToolArguments } from "./argot-wire";
import { DEFAULT_MODEL_SLOT } from "./config/model-roles";
import { optionalNumber } from "./config/optional-number";
import { initializeWithSettings } from "./discovery";
import { disposeAllJuliaKernelSessions, disposeJuliaKernelSessionsByOwner } from "./eval/jl/executor";
import { disposeAllVmContexts, disposeVmContextsByOwner } from "./eval/js/context-manager";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner } from "./eval/py/executor";
import { disposeAllRubyKernelSessions, disposeRubyKernelSessionsByOwner } from "./eval/rb/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import { getExaMcpTools } from "./exa/tools";
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
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
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
import type { LspStartupServerInfo } from "./lsp";
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
import { toolsPrompts } from "./prompts/tools/rows";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
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
	obfuscateProviderPayload,
	type PlanYolo,
	type Prewalk,
	type SecretRuntimeLease,
} from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { sessionCpuAdoption } from "./session/cpu-limit";
import { abortDetached } from "./session/detached-abort";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import {
	type CustomMessage,
	convertToLlm,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "./session/messages";
import { OperatorNotices, stderrNoticeSink } from "./session/operator-notices";
import { getRestorableSessionModels } from "./session/session-context";
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
import { ttsTool } from "./tools/tts";
import { createVibeTools } from "./tools/vibe";
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

type AsyncResultEntry = {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

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

/**
 * The operator-facing text for a session that cannot initialize secret protection.
 *
 * Starting anyway was considered and rejected. Degrading to a no-secrets session
 * reads like the kind option, but it is fail-OPEN on a security control: without a
 * placeholder key there is no obfuscator, and the obfuscator is what REDACTS. Stored
 * secrets would merely be unavailable, which is survivable, but env-derived values
 * that this session would have redacted reach the model, the transcript and the
 * session file in the clear. The operator turned protection on deliberately; quietly
 * running without it is worse than not starting, because nothing on screen would say
 * the guarantee had lapsed.
 *
 * So the failure stays fatal and becomes a decision instead of a stack trace: it names
 * the key path, the causes worth checking, and the one command that starts veyyon
 * without protection if that is genuinely what the operator wants.
 */
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
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
		})),
	};
	return {
		role: "custom",
		customType: "async-result",
		content: prompt.render(toolsPrompts["tools/async-result"].text, {
			multiple: jobs.length > 1,
			jobs,
		}),
		display: true,
		attribution: "agent",
		details,
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
	const details: LateDiagnosticsDetails = {
		files: files.map(file => ({
			path: file.path,
			summary: file.summary,
			errored: file.errored,
			messages: file.messages,
		})),
	};
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(toolsPrompts["tools/lsp-late-diagnostic"].text, {
			multiple: files.length > 1,
			files,
		}),
		display: true,
		attribution: "agent",
		details,
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
		approval: "write", // not-a-tool-name: approval tier
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
	return [...names];
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

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Agent config directory for this session. Default: `getAgentDir()`, i.e. `~/.veyyon/profiles/<active profile>/agent`. */
	agentDir?: string;
	/** Cross-profile vault/key root override for isolated SDK hosts. Default: getGlobalConfigRootDir() */
	globalConfigRoot?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];
	/** Authenticated fallback selector for deferred subagent model patterns. */
	modelPatternAuthFallback?: string;
	/** Role name used to install retry fallbacks after deferred subagent patterns resolve. */
	modelPatternFallbackRole?: string;
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Internal precedence source for the initial effort selection. */
	thinkingSource?: EffortSource;
	/** Models available for cycling (Ctrl+P in interactive mode). */
	scopedModels?: Array<{
		model: Model;
		thinkingLevel?: ConfiguredThinkingLevel;
		/** True only when this entry carried an explicit `:effort` suffix. */
		explicitThinkingLevel?: boolean;
	}>;
	/** Prewalk from the starting model to a fast/cheap target at the first edit/write once the todo list exists. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve on the model's first resolve call, then switch to execute. */
	planYolo?: PlanYolo;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Custom tools to register (in addition to built-in tools). Accepts both CustomTool and ToolDefinition. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedExtensionPaths} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * This is the safe pass-through for parent → subagent forwarding.
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.veyyon/tools/`, `.claude/tools/`,
	 * plugins, etc. When provided, the filesystem-scan inside
	 * `discoverCustomToolPaths()` is skipped — subagents inherit the parent's
	 * scan result and call `loadCustomTools()` themselves so each session binds
	 * tools to its OWN `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 *
	 * Forwarding the loaded `LoadedCustomTool[]` instances directly would reuse
	 * the parent's session-bound API and route tool execution back through the
	 * parent — wrong for isolated tasks and for pending-action routing.
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/**
	 * Where non-fatal problems the operator must see are delivered.
	 *
	 * Pass one built by the surface that can render it: a TUI constructs it with no sink and
	 * attaches its own once the screen exists, so warnings raised during session startup are
	 * buffered rather than lost. Default: a collector that writes to stderr as notices arrive,
	 * which is loud in the wrong place rather than silent (Law 10).
	 */
	operatorNotices?: OperatorNotices;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/**
	 * Context files (AGENTS.md / CLAUDE.md content). Default: all three scopes via
	 * {@link discoverContextFiles}, not the project walk alone: global
	 * (`<config root>/AGENTS.md`), profile (`agentDir`'s own instruction file), and
	 * project (the walk up from `cwd`).
	 */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.veyyon/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/** Enable MCP server discovery from .mcp.json files. Default: true */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Skip subprocess-kernel availability checks and prelude warmup */
	skipPythonPreflight?: boolean;
	/** Tool names explicitly requested (enables disabled-by-default tools) */
	toolNames?: string[];

	/** Output schema for structured completion (subagents) */
	outputSchema?: unknown;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Resolved absolute spawn-depth cap for this session's agent type. */
	maxNestedSpawnDepth?: number;
	/** Parent Hindsight state to alias for subagent memory tools. */
	parentHindsightSessionState?: HindsightSessionState;
	/**
	 * Parent session's Argot codec, forked into this subagent when
	 * `argot.subagents` is `inherit`. Absent for a top-level session or when the
	 * parent has Argot off; `createArgotSession` then arms fresh (never silently
	 * empty). Correctness never depends on this: it is a token optimization.
	 */
	parentArgot?: ArgotSession;
	/** Parent Mnemopi state to alias for subagent memory tools. */
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;
	/** Inherited eval executor session id for subagents sharing parent eval state. */
	parentEvalSessionId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;

	/**
	 * Start with the full permission bypass on (the `--dangerously-skip-permissions`
	 * flag). Stronger than `autoApprove`: removes every prompt including per-tool
	 * `prompt` overrides. Explicit `deny` and plan mode still block. Default: false.
	 */
	bypassAllApprovals?: boolean;

	/**
	 * A subagent's live view of its parent's bypass. `bypassAllApprovals` above
	 * is a snapshot taken at spawn, so without this a parent that turns `/yolo`
	 * off leaves an already-running child bypassing approvals to the end of its
	 * run. Consulted on every check, and it can only narrow: a child whose own
	 * bypass is off is never granted one by its parent.
	 */
	parentApprovalBypassed?: () => boolean;
}

/**
 * Whether these options describe a SUBAGENT: a session another session spawned
 * inside this same process, rather than the top-level session the process was
 * started for.
 *
 * Both signals are needed. `taskDepth` counts task recursion and is what the task
 * executor sets; `parentTaskPrefix` names the spawning agent's artifact prefix and
 * is what the IRC and registry path sets. A session can arrive carrying one and
 * not the other, so asking about either alone misses a real subagent.
 *
 * ONE owner because the answer decides four separate things: which Argot policy
 * the session follows, whether it is displayed as "sub", whether it is given the
 * vibe tools, and whether re-rooting it may move the PROCESS working directory.
 * Those were four inline copies of this expression, which is three chances for
 * them to disagree about what a subagent is. The last of the four is the one with
 * teeth, because a subagent that re-roots the process moves the working directory
 * out from under its parent and every sibling sharing the process.
 */
export function isSubagentSession(options: Pick<CreateAgentSessionOptions, "taskDepth" | "parentTaskPrefix">): boolean {
	return (options.taskDepth ?? 0) > 0 || Boolean(options.parentTaskPrefix);
}

/**
 * Whether another session in THIS process spawned this one, and therefore already
 * owns the process-global singletons it should inherit rather than replace.
 *
 * Deliberately NOT `isSubagentSession`, and the difference is the point. That
 * predicate answers "is this a subagent", and takes `taskDepth` into account
 * because a session can be one without carrying a parent's prefix. This one
 * answers a narrower question about OWNERSHIP, and only a `parentTaskPrefix` can
 * answer it: the prefix is what names the spawning agent, so it is the only signal
 * that says a live parent exists in this process to inherit from. A `taskDepth`
 * greater than zero says the session sits at some recursion depth, which does not
 * imply anyone here owns anything.
 *
 * Swapping in `isSubagentSession` here would change behaviour for a session
 * carrying depth but no prefix. It would stop installing the skills, rules and
 * MCP singletons, and it would take `AsyncJobManager.instance()` as its scoped
 * manager, which is `undefined` when nothing installed one. That session would
 * then refuse async work with no parent to route to instead.
 *
 * No in-tree caller constructs that shape today: the task executor and
 * `persisted-revive` both set the two together, and the eval bridge reaches the
 * executor, which sets `parentTaskPrefix` at the spawn. `createAgentSession` is a
 * public SDK export, though, so an outside caller can pass depth alone, which is
 * exactly why the two questions get two named predicates rather than one shared
 * expression that happens to read the same today.
 */
export function isInProcessChildSession(options: Pick<CreateAgentSessionOptions, "parentTaskPrefix">): boolean {
	return Boolean(options.parentTaskPrefix);
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

// `DialectFormat` and `resolveDialect` moved to `config/dialect-format.ts` so
// `system-prompt-builder/gate-inputs.ts` can ask the same question without importing this
// module, which imports it. Re-exported here because both are published from this entry point.
export { type DialectFormat, resolveDialect } from "./config/dialect-format";

// Re-exports

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

// Individual tool classes (BashTool, EditTool, ...) are re-exported from the
// library entry `src/index.ts` via their implementation modules — importing
// them here would eagerly parse every tool implementation on the CLI boot path.
export {
	// Tool factories and registry
	BUILTIN_TOOLS,
	createTools,
	HIDDEN_TOOLS,
	type ToolSession,
};

// Helper Functions

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `VEYYON_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * RE-EXPORTED, NOT REDEFINED. This was a wrapper that called the function below
 * and added nothing: `session/auth-broker-config` already defaults `agentDir` to
 * `getAgentDir()`, so the two were the same function under one name in two
 * places. Callers that only wanted credential discovery had to import this
 * module, which is the whole application, and one of them (`web/search`) sat in a
 * 49-module import cycle because of it. Anything inside the package should import
 * it from `./session/auth-broker-config`; this export exists because it is part
 * of the published SDK surface.
 */
export { discoverAuthStorage };

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 *
 * `agentDir` names the profile whose hooks and extension modules load. Omitting
 * it resolves the process-booted profile, which is only correct when the caller
 * genuinely has no session profile to speak of.
 */
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

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
	agentDir?: string,
	adoptSpawnedPid?: (pid: number) => void,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings, agentDir);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus, adoptSpawnedPid);
	reportExtensionLoadFailures(result);
	return result;
}

/**
 * Say out loud that an extension the user asked for is not running.
 *
 * `logger.error` alone was the whole report, and the default transport set is
 * `{ file: true }` with no console transport — see the header of
 * `session/operator-notices.ts`, which names this exact channel as the one that
 * reaches nobody. So an extension with a syntax error, a bad import, or a
 * throwing factory was dropped, the session started clean, and the operator's
 * only symptom was that its tools, commands and flags were absent with no
 * explanation. Skill-loading failures three hundred lines below already go to
 * the operator channel; this is the same failure of the same kind and now
 * reports the same way.
 *
 * The file log keeps the record either way: raising a notice adds reach and
 * never removes it.
 */
function reportExtensionLoadFailures(result: LoadExtensionsResult, operatorNotices?: OperatorNotices): void {
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
		operatorNotices?.error("extensions", `${path}: ${error}`);
	}
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`veyyon bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.veyyon/profiles/<name>/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `veyyon models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	// No agent dir: a one-shot CLI has no session profile, so the process-booted
	// one is the right and only answer here. Stated because the same omission at
	// the session call site was the defect.
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

/**
 * Discover the skills for a session: the authored `<agentDir>/skills`, the
 * auto-learn `<agentDir>/managed-skills`, and any skills shipped by plugin packages
 * configured for the session.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. It used to be accepted
 * and dropped, which pinned the skill set to whichever profile the process booted
 * with: an agent rooted in another agent dir silently got a stranger's skills, or
 * none. Do not reintroduce that by widening the signature without threading the
 * value. {@link loadSkillsInternal} forwards it as `LoadOptions.agentDir`, which lands
 * on the `LoadContext` all three profile-rooted skill providers read.
 */
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

/**
 * Discover the rules for a session: the profile's `<agentDir>/RULES.md` and
 * `<agentDir>/rules/`, the bundled defaults, and every foreign-config and plugin
 * rule source. All of them are user-scope: a repository's own `.veyyon/rules/`
 * was dropped as a source, because a cloned repo cannot be a standing
 * instruction on every request.
 *
 * `agentDir` defaults to {@link getAgentDir} and is FORWARDED, exactly like
 * {@link discoverSkills} and {@link discoverContextFiles}. Rules were the one
 * discovered layer with no wrapper: both session call sites reached
 * `loadCapability` directly with `{ cwd }` and no agent dir, so a session rooted
 * in another profile got that profile's instructions and skills alongside the
 * BOOTED profile's rules. This wrapper exists so the default lives in one place
 * and cannot be forgotten at a call site again.
 */
export async function discoverRules(cwd?: string, agentDir?: string): Promise<CapabilityResult<Rule>> {
	return await loadCapability<Rule>(ruleCapability.id, {
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover the context files (AGENTS.md / CLAUDE.md) for a session.
 *
 * Resolves all three scopes, in resolution order global (`<config root>/AGENTS.md`)
 * → profile (`agentDir`'s own instruction file) → project (the walk up from `cwd`).
 * The array is returned in AUTHORITY order, least authoritative first so the
 * strongest file holds the last and highest-recency slot: project (farther from
 * cwd first) → profile → global, which is last and therefore wins. See
 * {@link loadProjectContextFilesWithWarnings} for why those two axes differ.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. It used to be
 * accepted and dropped, which silently pinned the profile scope to whichever
 * profile the process booted with: an agent rooted in another agent dir got
 * someone else's profile file, or none. Do not reintroduce that by widening the
 * signature without threading the value.
 */
export async function discoverContextFiles(cwd?: string, agentDir?: string): Promise<ContextFileEntry[]> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. Without it the
 * user scope came from whichever profile the process booted with, so a session
 * rooted in another agent dir got that profile's AGENTS.md, skills and prompt
 * templates but the booted profile's slash commands.
 */
export async function discoverSlashCommands(cwd?: string, agentDir?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir(), agentDir: agentDir ?? getAgentDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}

// API Key Helpers

// System Prompt

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

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
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

// Internal Helpers

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

// The sdk's own marker is a symbol, so it cannot collide with a property a user put on their tool. The
// legacy shim's string twin is its own module's, since the shim STAMPS it and this only reads it.
import { LEGACY_TOOL_DEFINITION_MARKER } from "./extensibility/legacy-tool-marker";

const TOOL_DEFINITION_MARKER = Symbol("__isToolDefinition");

function isCustomTool(tool: CustomTool | ToolDefinition): tool is CustomTool {
	// Converted tools carry a hidden marker: the sdk's symbol
	// (customToolToDefinition) or the legacy shim's string prop. Anything
	// unmarked is a CustomTool that still needs conversion — checking only one
	// marker would double-convert the other kind, scrambling execute()'s
	// argument order.
	const marked = tool as { [TOOL_DEFINITION_MARKER]?: true; [LEGACY_TOOL_DEFINITION_MARKER]?: true };
	return marked[TOOL_DEFINITION_MARKER] !== true && marked[LEGACY_TOOL_DEFINITION_MARKER] !== true;
}

function isLegacyBuiltinToolDefinition(tool: CustomTool | ToolDefinition): boolean {
	return !isCustomTool(tool) && "__veyyonLegacyBuiltinTool" in tool && tool.__veyyonLegacyBuiltinTool === true;
}

/** Matches the truncation applied to per-server instructions inside `rebuildSystemPrompt`. */
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
	// JS eval worker/subprocess: reap on hard process exit too, the same as the
	// kernels above, so it cannot outlive the process (GRAN-11).
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
					// Return empty component if undefined to match Component type requirement
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

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
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
/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getBundledModel } from '@veyyon/catalog';
 * const { session } = await createAgentSession({
 *   model: getBundledModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   tools: codingTools({ cwd: getProjectDir() }),
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();
	registerEvalCleanup();

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
	// Track whether we internally created the authStorage so we can close it
	// if construction fails before the session takes ownership.
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	// Subscribe before any getApiKey() call so startup model probes can't fire a
	// credential_disabled event past us. An embedder's constructor handler makes the
	// listener set non-empty from construction, which defeats AuthStorage's no-listener
	// buffer — so we can't rely on it to catch startup events for the extension runner.
	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled: (() => void) | undefined = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			// Discard the result: handler errors are already isolated onto runner.onError
			// listeners. The catch is for the runner itself failing, which nothing here
			// awaits, so without it the rejection reaches the process-level handler and
			// takes the whole session down over a notification.
			void credentialDisabledTarget.emitCredentialDisabled(event).catch(error => {
				logger.warn("Failed to deliver a credential-disabled event to extensions", {
					error: errorMessage(error),
				});
			});
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});
	let detachFaultSink: (() => void) | undefined;
	let detachSecretsNoticeSink: (() => void) | undefined;
	let sessionManager!: SessionManager;
	let agent!: Agent;
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	let asyncJobManager: AsyncJobManager | undefined;
	let unregisterUnlessParked = (): void => {};
	const evalKernelOwnerId = `agent-session:${Snowflake.next()}`;
	let mcpManager: MCPManager | undefined = options.mcpManager;
	try {
		const settings = await (options.settings ??
			options.settingsManager ??
			logger.time("settings", Settings.init, { cwd, agentDir }));
		logger.time("initializeWithSettings", initializeWithSettings, settings);
		if (!options.modelRegistry) {
			modelRegistry.refreshInBackground();
		}
		// Kick off workspace tree discovery early. The native workspace scan returns
		// both the rendered-tree input and the AGENTS.md directory-context index, so
		// startup does not perform a second recursive filesystem search. Subagents
		// inherit the parent's resolved values via options.
		const STARTUP_SCAN_DEADLINE_MS = 5000;
		const startupIncludeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
		const workspaceTreePromise: Promise<WorkspaceTree> = prefetch(
			options.workspaceTree !== undefined
				? Promise.resolve(options.workspaceTree)
				: startupIncludeWorkspaceTree
					? logger.time("buildWorkspaceTree", () =>
							buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }),
						)
					: Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] }),
		);

		// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
		// at their respective consumer sites. Their work can overlap with model resolution, secret loading,
		// session-context build, tool creation, MCP discovery, and extension discovery.
		// Presence, not truthiness. An empty array is truthy, so testing the value
		// itself made a caller that filtered its list down to nothing read as "already
		// resolved", which turned discovery OFF and shipped a prompt with none of the
		// operator's AGENTS.md layers. `undefined` means "not resolved, walk the
		// scopes"; `[]` means "resolved to nothing on purpose". A caller that cannot
		// resolve its own list passes undefined, never []: see task/context-inheritance.ts.
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
				// Null degrades the prompt's repo context (branch/status enrichment),
				// so the operator must be able to see WHY it vanished: warn, not debug.
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
		// Presence, not truthiness, for the same reason as `contextFiles` above: `[]` is
		// truthy, so a caller that resolved its list down to nothing read as "already
		// resolved" AND supplied nothing, silently switching discovery off. `undefined`
		// means "not resolved, discover"; `[]` means "resolved to nothing on purpose".
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
		// Resolved either way, so the consumer below never needs a fallback. It used to be
		// `undefined` when the caller supplied skills, and the consumer spelled that as
		// `?? Promise.resolve({ skills: [], warnings: [] })`: unreachable, but it wrote "no
		// skills and no warning" down as an acceptable outcome, which is the exact shape a
		// real discovery failure would then hide behind.
		const discoveredSkillsPromise: Promise<{ skills: Skill[]; warnings: SkillWarning[] }> =
			options.skills === undefined
				? prefetch(
						logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
							...skillsSettings,
							disabledExtensions: disabledExtensionIds,
						}),
					)
				: Promise.resolve({ skills: options.skills, warnings: [] });

		// Initialize provider preferences from settings
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

		// The operator-visible channel for non-fatal startup and runtime problems. Construct it
		// before the session manager so load-time recovery notices use the same surface as secrets
		// and filesystem faults. Default to stderr rather than dropping warnings.
		const operatorNotices = options.operatorNotices ?? new OperatorNotices(stderrNoticeSink);

		sessionManager =
			options.sessionManager ??
			logger.time("sessionManager", () =>
				SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir), undefined, {
					operatorNotices,
					instrumentation: settings.get("session.instrumentation"),
				}),
			);
		// A caller-supplied manager was constructed before this SDK surface existed. Attach the
		// selected session's channel now so later setSessionFile/load recovery is still visible.
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
		// Startup model *selection* only needs to know whether auth is configured for
		// a candidate's provider — never the resolved key bytes. Use the synchronous,
		// side-effect-free probe (`hasConfiguredAuth`): it refreshes no OAuth tokens,
		// executes no `!command` keys, and issues no auth-broker requests. Resolving the
		// real key here (`getApiKey`) blocks resume on those network paths — a slow or
		// unreachable OAuth/broker endpoint stalls startup for the full ~10s refresh
		// timeout per candidate (observed as a hang in `restoreSessionModel`). The real
		// key is resolved lazily per request via ModelRegistry.resolver.
		const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

		// Key and vault conditions are raised from deep inside the secrets subsystem
		// and cannot be returned. See secrets/notices.ts for why this is a sink.
		// Each registration is identity-bound: overlapping sessions all receive process-global
		// conditions, and disposing this session removes only its own notice surface.
		detachSecretsNoticeSink = attachSecretsNoticeSink(message => operatorNotices.warn("secrets", message));
		for (const legacyFile of await findLegacyPromptFiles({ cwd, agentDir })) {
			operatorNotices.warn("system-prompt", describeLegacyPromptFile(legacyFile));
		}

		// Give `@veyyon/utils` somewhere to put a filesystem fault. Those helpers are free functions a
		// layer below this one, so they cannot reach a per-session channel and had nothing but
		// `logger.warn`, which is file-only: a subagents directory that exists and cannot be listed
		// reported "no subagents" to the operator and the reason to a file nobody opens. Attached here
		// rather than in each mode because every mode wants it and forgetting it is silent.
		//
		// Detached on dispose, and on the startup-failure path below, by the handle this returns. The
		// sink closes over `operatorNotices`, so leaving it attached outlives the session it reports to.
		detachFaultSink = attachFaultSink(fault => operatorNotices.warn(fault.source, fault.text));

		// There is one loader for startup, runtime toggles, command reconciliation, and
		// cwd moves. Replacing the complete runtime prevents project-scoped names and
		// values from surviving a move into another project.
		//
		// `onUnreadableVault` is the ONE thing those callers must not share. At STARTUP a vault that
		// will not open has to degrade, because `/secret discard` repairs it and lives inside the
		// session this would otherwise abort. On a RELOAD it has to throw: the reload exists to prove
		// a captured snapshot still matches the vault before a live `#NAME#` is expanded, so a
		// swallowed failure there is a placeholder expanded against a vault nobody could read. Same
		// loader, opposite correct answers, so the caller states which one it is asking for.
		const loadSecretRuntime = async (
			runtimeCwd: string,
			runtimeSettings: Settings = settings,
			onUnreadableVault: "degrade" | "throw" = "throw",
		) => {
			if (!runtimeSettings.get("secrets.enabled")) {
				return {
					obfuscator: undefined,
					vault: undefined,
					auditLog: undefined,
					vaultRevision: undefined,
				};
			}

			const fileEntries = await logger.time("loadSecrets", loadSecrets, runtimeCwd, agentDir);
			const envKeywords = await logger.time("loadEnvSecretKeywords", () =>
				loadEnvSecretKeywords({ cwd: runtimeCwd, agentDir }),
			);
			const envEntries = collectEnvSecrets(buildEnvSecretPattern(envKeywords));
			const vaultLocations = resolveVaultLocations({
				globalConfigRoot,
				agentDir,
				cwd: runtimeCwd,
			});
			const vault = new SecretVault(vaultLocations);
			const auditLog = runtimeSettings.get("secrets.auditLog")
				? new SecretAuditLog(secretAuditPath(vaultLocations), operatorNotices)
				: undefined;
			// A VAULT THAT CANNOT BE READ MUST NOT STOP THE SESSION STARTING, because the repair for
			// one lives inside the product this throw was preventing from starting. `load()` still
			// refuses the read (its narrow catch is a security boundary and is untouched); what
			// changes is that the refusal no longer takes the process with it. `noteFailedLoad` marks
			// every scope holding a file unreadable, which is what keeps this from becoming "the
			// vault is empty": the spend seam refuses those placeholders instead of passing them
			// through, and the operator is told, with a repair that runs on this surface.
			//
			// The interactive client already survived this and a `-p` run did not, so the same broken
			// vault was a warning in one place and a fatal error in the other. One loader, one answer.
			//
			// ONLY at startup. A reload rethrows, because its caller is about to expand a live
			// placeholder and needs the failure, not an empty runtime. Absorbing it here for every
			// caller silently turned the expansion lease's fail-closed refusal into a successful
			// expansion; the reload rows in the lease suite catch that and must stay red for it.
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
				// Stored in the vault precisely so the value is never shown. `mayRestoreForDisplay`
				// restores only `type: "regex"` + `origin: "config"`, so declaring the true
				// provenance here is what keeps a stored credential from being painted back onto
				// the screen out of model-authored prose or a tool-call argument.
				origin: "vault",
			}));

			// Both unprompted expiry warnings answer to this one setting: the startup sweep below and
			// the obfuscator's mid-session `onExpiry` (gated at its own site further down). Gating one
			// and not the other would leave the session still interrupting about expiry with the
			// warnings switched off, which is the same defect under a different trigger.
			//
			// `/secret list` and the status-line chip are NOT gated: the operator asked for those by
			// opening the list or by looking at the line, and answering a question with silence is a
			// different feature from not interrupting.
			const warnAboutExpiry = runtimeSettings.get("secrets.expiryWarnings");
			if (warnAboutExpiry) {
				for (const warning of expiryWarnings(liveVaultEntries, Date.now())) {
					operatorNotices.warn("secrets", warning);
				}
			}

			let placeholderKey: Buffer;
			try {
				placeholderKey = await logger.time("loadSecretPlaceholderKey", () =>
					loadOrCreateVaultKey(globalConfigRoot),
				);
			} catch (error) {
				throw new Error(secretProtectionUnavailableMessage(globalConfigRoot), { cause: error });
			}
			const vaultRevision = vault.revision();
			const nextObfuscator = new SecretObfuscator([...envEntries, ...fileEntries, ...vaultEntries], {
				placeholderKey,
				onRejection: rejection => operatorNotices.warn("secrets", describeSecretRejection(rejection)),
				// A notice only. The placeholder is already forgotten by the time this fires, so
				// silencing it withdraws the interruption and nothing else.
				onExpiry: warnAboutExpiry
					? expiry => operatorNotices.warn("secrets", describeSecretExpiry(expiry))
					: undefined,
			});
			return { obfuscator: nextObfuscator, vault, vaultRevision, auditLog };
		};

		// "degrade": the only caller that may start without a vault. See `onUnreadableVault`.
		const initialSecretRuntime = await loadSecretRuntime(cwd, settings, "degrade");
		let obfuscator = initialSecretRuntime.obfuscator;
		let redactionObfuscator = obfuscator;
		let secretVault = initialSecretRuntime.vault;
		let capturedVaultRevision = initialSecretRuntime.vaultRevision;
		let secretAuditLog = initialSecretRuntime.auditLog;
		let secretRuntimeCwd = path.resolve(cwd);
		let latestSecretRuntimeRequest = 0;
		let pendingSecretRuntime:
			| {
					revision: number;
					cwd: string;
					work: Promise<SecretRuntimeLease | undefined>;
			  }
			| undefined;
		let refreshSecretRuntime!: (runtimeCwd: string) => Promise<SecretRuntimeLease>;

		const auditLogBySecretLease = new WeakMap<object, SecretAuditLog | undefined>();
		/**
		 * The vault each lease was built from, so the spend seam can ask whether a scope
		 * is currently unreadable. Keyed like the audit log because it answers the same
		 * kind of question: which load produced the authority about to be used.
		 */
		const vaultBySecretLease = new WeakMap<object, SecretVault>();

		/**
		 * Schedule the reload a stale lease needs, honouring the two rules that keep
		 * refreshes from fighting each other.
		 *
		 * A lease may outlive a cwd transition because one admitted request keeps its
		 * immutable authority. Such an old lease must not supersede the destination
		 * refresh by scheduling work for the directory being left. And once the
		 * committed lease already answers correctly there is nothing left to fix: a
		 * revision that moved because THIS session wrote the vault therefore cannot
		 * feed a reload storm, because the write is already reflected in the lease
		 * every later request reads.
		 */
		const scheduleStaleSecretRefresh = (normalizedCwd: string): void => {
			if (path.resolve(sessionManager.getCwd()) !== normalizedCwd) return;
			if (pendingSecretRuntime?.cwd === normalizedCwd) return;
			if (secretRuntimeLease.cwd === normalizedCwd && secretRuntimeLease.isFreshForExpansion()) return;
			void refreshSecretRuntime(normalizedCwd).catch(error => {
				logger.warn("Failed to refresh a stale secret runtime", {
					cwd: normalizedCwd,
					error: errorMessage(error),
				});
			});
		};

		/**
		 * The lease that may expand right now, or undefined when no fresh authority
		 * exists yet.
		 *
		 * A request pins one immutable lease so that a disable or a scope move cannot
		 * change what an already-admitted request uses. That rule protects redaction.
		 * For EXPANSION a reload that already landed on the same directory is strictly
		 * better authority: it resolves the placeholder against the vault as it is now
		 * instead of against a snapshot a rotation has moved past. Preferring it is how
		 * a stale revision recovers instead of refusing.
		 */
		const resolveFreshExpansionAuthority = (requested: SecretRuntimeLease): SecretRuntimeLease | undefined => {
			if (requested.isFreshForExpansion()) return requested;
			const live = secretRuntimeLease;
			if (live === requested || live.cwd !== requested.cwd) return undefined;
			if (live.expansionObfuscator?.hasSecrets() !== true) return undefined;
			return live.isFreshForExpansion() ? live : undefined;
		};

		/**
		 * Whether any string inside a tool call's arguments would actually be expanded.
		 *
		 * The same bounded JSON walk `deobfuscateToolArguments` uses, with the mapper
		 * replaced by the non-throwing predicate that mirrors `deobfuscate`'s rule. The
		 * identity return keeps the walk allocation-free: `mapJsonStrings` hands back
		 * the original reference when no string changed.
		 */
		const toolArgumentsCarryLivePlaceholder = (
			expansion: SecretObfuscator,
			args: Record<string, unknown>,
		): boolean => {
			let carries = false;
			mapJsonStrings(args as JsonWithOptionalFields, text => {
				if (!carries && expansion.containsLivePlaceholder(text)) carries = true;
				return text;
			});
			return carries;
		};

		/**
		 * The first placeholder-shaped token in a tool call's arguments that this
		 * runtime cannot resolve, or `undefined` when every one of them resolves.
		 *
		 * Only consulted while a vault scope is unreadable. An unparseable vault never
		 * says which names it held, so there is no list to check a token against and
		 * the shape is the only signal available. `isSecretPlaceholder` is the gate
		 * rather than the looser `PLACEHOLDER_RE` alone, so a four-character token
		 * like `#TODO#` is not mistaken for a name (names start with a letter and run
		 * at least five characters).
		 *
		 * A private regex, not the shared `PLACEHOLDER_RE`: that one is global and
		 * carries `lastIndex` across every module that touches it, so borrowing it
		 * here would couple this walk to whether some other caller reset it.
		 */
		const firstUnresolvedPlaceholder = (
			expansion: SecretObfuscator | undefined,
			args: Record<string, unknown>,
		): string | undefined => {
			const scan = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
			let orphan: string | undefined;
			mapJsonStrings(args as JsonWithOptionalFields, text => {
				if (orphan !== undefined || !text.includes("#")) return text;
				scan.lastIndex = 0;
				for (;;) {
					const match = scan.exec(text);
					if (match === null) break;
					const token = match[0];
					if (isSecretPlaceholder(token) && expansion?.knowsPlaceholder(token) !== true) {
						orphan = token;
						break;
					}
				}
				return text;
			});
			return orphan;
		};

		/** An unreadable-scope condition, described in the words an operator is shown. */
		interface UnreadableVaultReport {
			/** The lease whose vault was consulted, which is the live one whenever it still applies. */
			readonly authority: SecretRuntimeLease;
			/** Every unreadable scope with its path, for a message that has to say WHICH file. */
			readonly broken: string;
			/** The repair, worded to match the notice `noteUnreadableVault` prints for the same state. */
			readonly repair: string;
		}

		/**
		 * The unreadable scopes that currently speak for `requested`'s directory, and the words that
		 * tell an operator how to fix them.
		 *
		 * Split out from its one caller so the repair is worded in ONE place. The same condition is
		 * also reported by `noteUnreadableVault` in vault.ts, and an operator hitting a corrupt vault
		 * sees both within a minute of each other; two descriptions of one repair is how someone
		 * concludes there are two problems. Keep this clause and that notice's in step.
		 */
		const unreadableVaultReport = (requested: SecretRuntimeLease): UnreadableVaultReport | undefined => {
			// A repaired vault stops refusing the moment its reload lands: the live lease
			// holds a different SecretVault whose own load found every scope readable.
			const live = secretRuntimeLease;
			const authority = live.cwd === requested.cwd ? live : requested;
			const unreadable = vaultBySecretLease.get(authority)?.unreadableScopes() ?? [];
			if (unreadable.length === 0) return undefined;
			const locations = resolveVaultLocations({ globalConfigRoot, agentDir, cwd: authority.cwd });
			const broken = unreadable.map(scope => `${scope} (${vaultPathFor(locations, scope)})`).join(", ");
			// MOVES the file, so say "aside" rather than "delete": it still holds real credentials
			// sealed with a key that is still on disk, the damage may be a truncated tail with
			// recoverable entries behind it, and someone told it was deleted finds out otherwise at
			// the worst possible moment.
			const commands = unreadable.map(scope => `/secret discard ${scope}`).join(" and ");
			return {
				authority,
				broken,
				repair: `Run ${commands} to move the unreadable file aside. Then store the secrets it held again.`,
			};
		};

		/**
		 * THE FOURTH REFUSAL CONDITION: an unreadable vault scope plus a placeholder
		 * nothing can resolve.
		 *
		 * A vault whose bytes exist but do not parse is skipped by `load()` so launch
		 * survives, which leaves this hole: `revision()` fingerprints file STATS and
		 * never parses, so the corrupt file's revision matches the captured one and the
		 * freshness conditions are all satisfied. `containsLivePlaceholder` is false
		 * too, because the obfuscator never learned the name the file held. Every guard
		 * says yes and `bash echo #TOKEN#` RUNS, passing the literal characters
		 * `#TOKEN#` where a credential belongs. That is worse than the crash it
		 * replaced: a dead TUI is loud, a command that quietly executes against a live
		 * endpoint with a placeholder for its credential is not.
		 *
		 * The rule cannot be name-specific. An unparseable vault never says which names
		 * it held, so there is no list to check against; while ANY scope is unreadable,
		 * a placeholder-shaped token that does not resolve is refused instead of passed
		 * through. With every scope healthy this does nothing at all, so an unknown
		 * `#WORD#` keeps behaving exactly as it does today.
		 *
		 * Deliberately OUTSIDE the `hasSecrets()` gate that guards the rest of the spend
		 * seam. In the case this exists for, the corrupt scope is often the only source
		 * of secrets, so the obfuscator holds nothing, `hasSecrets()` is false, and a
		 * check placed inside that gate would never run.
		 */
		const assertNoOrphanPlaceholderWhileVaultUnreadable = (
			requested: SecretRuntimeLease,
			args: Record<string, unknown>,
		): void => {
			const report = unreadableVaultReport(requested);
			if (report === undefined) return;
			const orphan = firstUnresolvedPlaceholder(report.authority.expansionObfuscator, args);
			if (orphan === undefined) return;
			throw new Error(
				`Secret expansion was refused because ${orphan} does not resolve and the vault could not be read, so there is no way to tell whether it is a credential this session should have expanded. Unreadable: ${report.broken}. ${report.repair} Nothing was run.`,
			);
		};

		const createSecretRuntimeLease = (
			revision: number,
			runtimeCwd: string,
			expansionObfuscator: SecretObfuscator | undefined,
			redactor: SecretObfuscator | undefined,
			vault: SecretVault | undefined,
			vaultRevision: string | undefined,
			auditLog: SecretAuditLog | undefined,
		): SecretRuntimeLease => {
			const normalizedCwd = path.resolve(runtimeCwd);
			/**
			 * Nothing this lease could get wrong about `text`.
			 *
			 * A moved vault revision is a cache miss, not a security event, and it is
			 * only a miss at all for text carrying a placeholder this snapshot would
			 * substitute. `deobfuscate` leaves every other string byte-identical, so a
			 * payload without a live placeholder is safe whatever the vault did on
			 * disk. The payload gate runs BEFORE the revision compare because
			 * `revision()` costs a stat per vault path and almost every payload
			 * expands to itself.
			 */
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
					if (path.resolve(sessionManager.getCwd()) !== normalizedCwd) {
						// Pinned to a directory the session has left. Scheduling a reload
						// here would supersede the destination refresh, so wait for
						// whatever is already in flight and re-ask instead.
						await pendingSecretRuntime?.work.catch(() => undefined);
						if (settledForExpansion(text)) return;
						throw new Error(
							`Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left, so that project's vault cannot be reloaded for it. Retry once the directory change has finished.`,
						);
					}
					let refreshed: SecretRuntimeLease | undefined;
					let reloadError: unknown;
					try {
						refreshed = await refreshSecretRuntime(normalizedCwd);
					} catch (error) {
						reloadError = error;
					}
					// Exactly one attempt. A reload that keeps losing to a revision that
					// will not settle must surface as one actionable refusal rather than
					// spin the loader.
					if (refreshed?.isFreshForExpansion(text) === true) return;
					if (settledForExpansion(text)) return;
					const detail = reloadError === undefined ? "" : ` Reload failed: ${errorMessage(reloadError)}.`;
					throw new Error(
						`Secret expansion was refused: reloading the secret vault for ${normalizedCwd} did not produce a runtime that can resolve this text's placeholders, so no current value is available.${detail} Check what is stored with /secret list, then retry.`,
					);
				},
				assertFreshForExpansion: (text?: string) => {
					if (settledForExpansion(text)) return;
					scheduleStaleSecretRefresh(normalizedCwd);
					throw new Error(
						path.resolve(sessionManager.getCwd()) === normalizedCwd
							? "Secret expansion was refused because the vault on disk no longer matches the snapshot this request is pinned to, so a placeholder could resolve to a value the vault has already replaced. A reload is under way; retry this call, and check what is stored with /secret list if it keeps failing."
							: `Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left; the destination's own reload is the authority. Retry once the directory change has finished.`,
					);
				},
			});
			auditLogBySecretLease.set(lease, auditLog);
			if (vault) vaultBySecretLease.set(lease, vault);
			return lease;
		};
		let secretRuntimeLease = createSecretRuntimeLease(
			0,
			cwd,
			obfuscator,
			redactionObfuscator,
			secretVault,
			capturedVaultRevision,
			secretAuditLog,
		);

		// Argot per-project shorthand codec (experimental). The launch project's
		// dictionary auto-loads at startup (the adoption loop: works out of the
		// box); additional projects are agent-driven through the argot_load tool.
		// The dictionary lives in a local cache under the config root, never
		// committed. The notation and the load-yourself instruction are taught
		// through the system prompt (see argotPreamble below), the loaded handles
		// through promptFragment. Expansion runs at the same two seams as secret
		// deobfuscation — tool-call arguments before execution and assistant
		// content before display — so the cheap handle stays in history (the
		// token win) while everything outside history sees full text.
		const argotEnabled = settings.get("argot.enabled") === true;
		// A subagent (task-spawned child) follows the `argot.subagents` policy instead
		// of always starting empty: `off` gets no codec, `fresh` gets its own empty
		// session and loads its task's project itself, `inherit` forks the parent's
		// codec. Correctness never rests on this (the boundary rule expands every
		// emitted seam); the policy trades tokens.
		const sessionIsSubagent = isSubagentSession(options);
		const argot = createArgotSession({
			enabled: argotEnabled,
			isSubagent: sessionIsSubagent,
			subagentMode: settings.get("argot.subagents"),
			parentArgot: options.parentArgot,
		});
		// Encode gate: which models may WRITE shorthand and an optional context-size
		// cutoff. Decoding (argot.expand at the tool-arg and display seams) is
		// unconditional and lossless whatever this holds; the gate governs only
		// whether the notation preamble is taught this turn. The policy itself lives
		// in the argot SDK (shouldEncode) so every harness gates the same way.
		const argotGate: ArgotGate = buildArgotGate(
			argotEnabled,
			settings.get("argot.encode.models") ?? [],
			settings.get("argot.encode.disableAboveTokens"),
		);
		// Live context size (prompt tokens the model last saw), refreshed each turn
		// from usage so the cutoff tracks the growing context. 0 until the first
		// response, which keeps encoding on for a small starting context.
		let argotContextTokens = 0;

		// An abnormal process exit after a non-terminal message tail is durable
		// evidence that the old process can no longer finish that turn. Preserve the
		// partial transcript and append one terminal aborted assistant record before
		// rebuilding runtime context. The helper is idempotent once that record exists.
		let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
		const interruptedTurnAbort = createInterruptedTurnAbortMessage(existingBranch);
		if (interruptedTurnAbort) {
			sessionManager.appendMessage(interruptedTurnAbort);
			existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
		}
		let existingSession = logger.time("loadSessionContext", () => sessionManager.buildSessionContext());
		// Decode-only re-arm on resume. Persisted history keeps cheap handles (the
		// token win), so a resumed branch can hold `§handle` tokens from argot_load
		// calls in earlier sessions; the display/export seams can only expand them
		// with those dictionaries loaded. The branch's own argot_load tool results
		// name the exact projects the model chose, so resume re-arms those roots
		// with teach:false — no walking, no guessing, and teaching stays
		// agent-driven (the model re-decides by calling argot_load again).
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
		let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
			resolveModelRoleValue(settings.getModelRole(DEFAULT_MODEL_SLOT), allowedModels, {
				settings,
				matchPreferences: modelMatchPreferences,
			}),
		);
		let model = options.model;
		let modelFallbackMessage: string | undefined;
		// Identify session model strings to restore in fallback order. We do an
		// initial pass here so model-dependent setup (thinking-level resolution,
		// host preconnect) can use the restored model; extension-registered
		// providers aren't visible yet, so we retry the preferred candidates once
		// extensions register below.
		const sessionModelStrings =
			!hasExplicitModel && hasExistingSession
				? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
				: [];
		let restoredSessionModelIndex = -1;
		let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;
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

		// If still no model, try settings default.
		// Skip settings fallback when an explicit model was requested.
		if (!hasExplicitModel && !model && defaultRoleSpec.model) {
			const settingsDefaultModel = defaultRoleSpec.model;
			logger.time("resolveSettingsDefaultModel", () => {
				// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
				// so re-validating auth here just repeats the expensive lookup path.
				model = settingsDefaultModel;
			});
		}

		const taskDepth = options.taskDepth ?? 0;

		// Resolve one effort axis and remember its source so model switches can
		// preserve session overrides while re-evaluating per-model defaults.
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
		let thinkingLevel = pickInitialThinkingLevel(model);
		let autoThinking = thinkingLevel === AUTO_THINKING;
		// Concrete level the agent/session start with. With `auto` this is the
		// provisional level shown until the first per-turn classification resolves;
		// `auto` itself stays a session-only concept handled by AgentSession.
		let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
		if (model) {
			const resolvedModel = model;
			effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
				autoThinking
					? resolveProvisionalAutoLevel(resolvedModel)
					: resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
			);
			// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps
			// with the rest of session setup (extension/skill load, tool registry,
			// system prompt build). Without this, the first `fetch(...)` pays the
			// full handshake serially — 100–300 ms transcontinental for
			// api.anthropic.com from a residential IP. Every mode benefits
			// (interactive, print, rpc, acp).
			preconnectModelHost(model.baseUrl);
		}

		const discovered = await discoveredSkillsPromise;
		const skills: Skill[] = discovered.skills;
		// Straight into the operator channel. These used to be collected into
		// `AgentSession.skillWarnings`, a getter no production code read, so a skill that failed to
		// load was discarded in silence and the channel looked live from the outside.
		for (const warning of discovered.warnings) {
			operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
		}

		// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
		const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = await logger.time(
			"discoverTtsrRules",
			async () => {
				const { TtsrManager } = await import("./export/ttsr");
				const ttsrSettings = settings.getGroup("ttsr");
				// `getCwd` is a live getter, not `cwd`: a rule with a `pathScope` compares the match
				// against the CURRENT working directory, and `set_cwd` moves it mid-session.
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
			},
		);

		// Resolve contextFiles up-front (it's needed before tool creation). The
		// workspace tree scan is slow on large repos and we MUST NOT block startup on
		// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
		// will re-race the same promise through its own withDeadline path. Background
		// work continues so caches still warm.
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
		const [contextFiles, resolvedWorkspaceTree, activeRepoContext, watchdogFiles, discoveredAdvisors] =
			await Promise.all([
				contextFilesPromise,
				raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
				activeRepoContextPromise,
				watchdogFilesPromise,
				advisorConfigsPromise,
			]);

		let promptInputCwd = cwd;
		let promptContextFiles = contextFiles;
		let promptWorkspaceTree: WorkspaceTree | Promise<WorkspaceTree> = workspaceTreePromise;
		let promptActiveRepoContext = activeRepoContext;
		let promptSkills = skills;
		let promptRulebookRules = rulebookRules;
		let promptAlwaysApplyRules = alwaysApplyRules;

		const leaseSecretRuntime = async (): Promise<SecretRuntimeLease> => {
			for (;;) {
				const pending = pendingSecretRuntime;
				if (pending) {
					await pending.work;
					if (pendingSecretRuntime !== pending) continue;
				}

				if (
					secretVault &&
					capturedVaultRevision !== undefined &&
					secretVault.revision() !== capturedVaultRevision
				) {
					return await refreshSecretRuntime(sessionManager.getCwd());
				}
				return secretRuntimeLease;
			}
		};

		refreshSecretRuntime = (runtimeCwd: string): Promise<SecretRuntimeLease> => {
			const revision = ++latestSecretRuntimeRequest;
			const normalizedRuntimeCwd = path.resolve(runtimeCwd);
			const work = (async (): Promise<SecretRuntimeLease | undefined> => {
				const runtimeSettings =
					normalizedRuntimeCwd === secretRuntimeCwd || path.resolve(settings.getCwd()) === normalizedRuntimeCwd
						? settings
						: await settings.cloneForCwd(normalizedRuntimeCwd);
				const next = await loadSecretRuntime(normalizedRuntimeCwd, runtimeSettings);

				const isAuthoritative = (): boolean =>
					revision === latestSecretRuntimeRequest &&
					path.resolve(sessionManager.getCwd()) === normalizedRuntimeCwd;
				if (!isAuthoritative()) return undefined;

				if (next.obfuscator && redactionObfuscator) {
					// Expansion never crosses snapshots, but redaction tombstones and retired-name
					// refusals cross every refresh and cwd move.
					next.obfuscator.retainRedactionsFrom(redactionObfuscator);
				} else if (redactionObfuscator) {
					// Disabling expansion does not erase the names already advertised in this process.
					// Mark them on the redaction-only authority so stale tool calls fail before execution.
					redactionObfuscator.markAllPlaceholdersRetired();
				}
				await secretAuditLog?.flush();
				if (!isAuthoritative()) return undefined;

				const nextRedactor = next.obfuscator ?? redactionObfuscator;
				const nextLease = createSecretRuntimeLease(
					revision,
					normalizedRuntimeCwd,
					next.obfuscator,
					nextRedactor,
					next.vault,
					next.vaultRevision,
					next.auditLog,
				);

				// One synchronous commit updates every SDK closure and the AgentSession
				// view. No await is permitted in this block.
				obfuscator = next.obfuscator;
				redactionObfuscator = nextRedactor;
				secretVault = next.vault;
				capturedVaultRevision = next.vaultRevision;
				secretAuditLog = next.auditLog;
				secretRuntimeCwd = normalizedRuntimeCwd;
				secretRuntimeLease = nextLease;
				if (hasSession) session.installSecretRuntime(nextLease);
				return nextLease;
			})();
			const pending = { revision, cwd: normalizedRuntimeCwd, work };
			pendingSecretRuntime = pending;

			return (async () => {
				try {
					const committed = await work;
					if (committed) return committed;
					if (pendingSecretRuntime === pending) pendingSecretRuntime = undefined;
					return await leaseSecretRuntime();
				} catch (error) {
					if (revision !== latestSecretRuntimeRequest) return await leaseSecretRuntime();
					throw error;
				} finally {
					if (pendingSecretRuntime === pending) pendingSecretRuntime = undefined;
				}
			})();
		};
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
		// Only the first top-level session in a process owns an AsyncJobManager.
		// Subagents inherit the parent's manager via `AsyncJobManager.instance()`
		// (set below), and any additional top-level session spun up in-process
		// (e.g. the agent-creation architect in `agent-dashboard.ts`) must share
		// the live singleton — otherwise its dispose path would clobber the
		// owning session's manager and break the `task`/`bash` async paths
		// (issue #1923). The `instance()` guard means later sessions also skip
		// constructing an orphaned manager that nothing would ever route to.
		asyncJobManager =
			!isInProcessChildSession(options) && !AsyncJobManager.instance()
				? new AsyncJobManager({
						maxRunningJobs: asyncMaxJobs,
						onJobComplete: async (jobId, result, job) => {
							if (!session || asyncJobManager!.isDeliverySuppressed(jobId)) return;
							const formattedResult = await formatAsyncResultForFollowUp(result);
							if (asyncJobManager!.isDeliverySuppressed(jobId)) return;

							const durationMs = job ? Math.max(0, Date.now() - job.startTime) : undefined;
							session.yieldQueue.enqueue<AsyncResultEntry>("async-result", {
								jobId,
								result: formattedResult,
								job,
								durationMs,
							});
						},
					})
				: undefined;

		const scopedAsyncJobManager =
			asyncJobManager ?? (isInProcessChildSession(options) ? AsyncJobManager.instance() : undefined);

		const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
		const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
		const resolvedAgentDisplayName = options.agentDisplayName ?? (sessionIsSubagent ? "sub" : "main");
		const agentKind = sessionIsSubagent ? ("sub" as const) : ("main" as const);
		/**
		 * Forget the agent ref on teardown — unless the agent is being parked (or is
		 * already parked). Parking disposes the session but keeps the ref addressable
		 * (history://, revive); only process teardown / explicit kill unregisters.
		 */
		unregisterUnlessParked = (): void => {
			if (agentRegistry.get(resolvedAgentId)?.status === "parked") return;
			if (AgentLifecycleManager.global().isParking(resolvedAgentId)) return;
			agentRegistry.unregister(resolvedAgentId);
		};
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		// Per-path mutation counter shared across edit/write tools. Late-diagnostics
		// entries capture it at fetch time and are dropped at injection if a newer
		// mutation (any tool) bumped it in the meantime.
		const fileMutationVersions = new Map<string, number>();
		const activeToolNames = new Set<string>();
		const setActiveToolNames = (names: Iterable<string>): void => {
			activeToolNames.clear();
			for (const name of names) {
				activeToolNames.add(name);
			}
		};
		/**
		 * Move the session working directory before an `AgentSession` exists.
		 *
		 * Only reachable in the window where a tool runs during construction. Once
		 * `session` is assigned, both tool sessions delegate to `AgentSession.setCwd`,
		 * which owns the re-scope and does considerably more than this.
		 *
		 * ONE copy, because there were two: the agent's tool session and the
		 * advisor's held byte-identical bodies, and the `setProjectDir` below is
		 * exactly the kind of line that gets fixed in one of a pair and not the other.
		 * It is guarded for the same reason `AgentSession.rescopeToCwd` guards its
		 * process-global half: a subagent shares this process with its parent and its
		 * siblings, and may not move their working directory.
		 */
		const setCwdBeforeSessionExists: NonNullable<ToolSession["setCwd"]> = async (resolvedPath, options) => {
			const previous = sessionManager.getCwd();
			const cwd = await sessionManager.setCwd(resolvedPath, options);
			if (cwd !== previous) {
				if (!sessionIsSubagent) setProjectDir(cwd);
				const note = `Session working directory changed: ${previous} → ${cwd}`;
				sessionManager.appendCustomMessageEntry("cwd_changed", note, true, { previous, cwd }, "agent");
			}
			return cwd;
		};
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			setCwd: async (resolvedPath, options) =>
				session ? session.setCwd(resolvedPath, options) : setCwdBeforeSessionExists(resolvedPath, options),
			obfuscateProviderText: text => secretRuntimeLease.obfuscateText(text),
			// A generated subagent label is a side request of THIS session, so it
			// rides the session's side transport and inherits its watchdogs and
			// concurrency bracket. Read live: the session is constructed after this
			// literal, and no tool can run before it exists.
			get sideComplete() {
				return session?.sideComplete;
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
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			skills,
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			requireYieldTool: options.requireYieldTool,
			taskDepth: options.taskDepth ?? 0,
			maxNestedSpawnDepth: options.maxNestedSpawnDepth,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getEvalKernelOwnerId: () => evalKernelOwnerId,
			getEvalSessionId: () =>
				session?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
			assertEvalExecutionAllowed: () => session?.assertEvalExecutionAllowed(),
			trackEvalExecution: (execution, abortController) =>
				session ? session.trackEvalExecution(execution, abortController) : execution,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			getTurnIndex: () => session?.getTurnIndex() ?? 0,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			getAgentId: () => resolvedAgentId,
			getToolByName: name => session?.getToolByName(name),
			agentRegistry,
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveThinkingLevel: () => session?.configuredThinkingLevel() ?? options.thinkingLevel,
			getActiveModel: () => agent?.state.model ?? model,
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			getPlanModeState: () => session?.getPlanModeState(),
			getPlanReferencePath: () => session?.getPlanReferencePath() ?? DEFAULT_PLAN_FILE_URL,
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getTurnBudget: () => sessionManager.getTurnBudget(),
			recordEvalSubagentUsage: output => sessionManager.recordEvalSubagentOutput(output),
			getClientBridge: () => session?.clientBridge,
			queueDeferredDiagnostics: entry => session?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
			bumpFileMutationVersion: path => {
				const next = (fileMutationVersions.get(path) ?? 0) + 1;
				fileMutationVersions.set(path, next);
				return next;
			},
			getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			isMCPDiscoveryEnabled: () => session.isMCPDiscoveryEnabled(),
			getSelectedMCPToolNames: () => session.getSelectedMCPToolNames(),
			activateDiscoveredMCPTools: toolNames => session.activateDiscoveredMCPTools(toolNames),
			// Generic tool discovery (unified — covers built-in + MCP + extension)
			isToolDiscoveryEnabled: () => session.isToolDiscoveryEnabled(),
			getDiscoverableTools: filter => session.getDiscoverableTools(filter),
			getDiscoverableToolSearchIndex: () => session.getDiscoverableToolSearchIndex(),
			getSelectedDiscoveredToolNames: () => session.getSelectedDiscoveredToolNames(),
			activateDiscoveredTools: toolNames => session.activateDiscoveredTools(toolNames),
			getCheckpointState: () => session.getCheckpointState(),
			setCheckpointState: state => session.setCheckpointState(state ?? undefined),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
			getToolChoiceQueue: () => session.toolChoiceQueue,
			buildToolChoice: name => {
				const m = session.model;
				return m ? buildNamedToolChoice(name, m) : undefined;
			},
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			peekQueueInvoker: () => session.peekQueueInvoker(),
			peekPendingInvoker: () => session.peekPendingInvoker(),
			clearPendingInvokers: () => session.clearPendingInvokers(),
			peekStandingResolveHandler: () => session.peekStandingResolveHandler(),
			setStandingResolveHandler: handler => session.setStandingResolveHandler(handler),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch (error) {
					// Without an artifact, oversized output is truncated with no
					// full-output copy — never degrade to that silently.
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
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			// Subagents inherit the singleton (the parent's manager) so their bash/task
			// completions still flow into the spawning conversation's yieldQueue.
			// Secondary in-process top-level sessions (no parentTaskPrefix, no
			// constructed manager because the singleton was already installed) leave
			// this undefined so tools and session job snapshots refuse async work
			// instead of silently routing into the owning session (issue #1923).
			asyncJobManager: scopedAsyncJobManager,
		};

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!isInProcessChildSession(options)) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
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

		// Create built-in tools (already wrapped with meta notice formatting)
		const builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);

		// Discover MCP tools from .mcp.json files
		mcpManager = options.mcpManager;
		toolSession.mcpManager = mcpManager;
		const enableMCP = options.enableMCP ?? true;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const customTools: CustomTool[] = [];
		let startDeferredMCPDiscovery:
			| ((liveSession: AgentSession, activation: DeferredMCPActivation) => void)
			| undefined;
		const startupQuiet = settings.get("startup.quiet");
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			// Always filter Exa - we have native integration
			filterExa: true,
			// Filter browser MCP servers when builtin browser tool is active
			filterBrowser: settings.get("browser.enabled") ?? false,
			// The session's own profile, not the booted one: an SDK host rooted in
			// another agent dir gets that profile's mcp.json, matching its rules,
			// commands, skills and instructions.
			agentDir,
		};
		if (enableMCP && !mcpManager) {
			if (deferMCPDiscoveryForUI) {
				const cacheStorage = settings.getStorage();
				mcpManager = new MCPManager(cwd, cacheStorage ? new MCPToolCache(cacheStorage) : null);
				mcpManager.setAuthStorage(authStorage);
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
							// The session can be torn down while servers are still connecting.
							// Don't resurrect tools on a disposed session, and don't leak the
							// transports/subprocesses the connect just spawned.
							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);
							// `tools.discoveryMode: "auto"` was resolved before deferred MCP
							// tools existed. Reconcile again before refresh so a large toolset
							// cannot bypass discovery by arriving after first paint.
							let discoveryEnabled = activation.mcpDiscoveryEnabled;
							let activateAll = activation.activateAllMCPTools;
							if (
								!discoveryEnabled &&
								(await enableDeferredMCPDiscoveryForTools(liveSession, mcpResult.tools))
							) {
								discoveryEnabled = true;
								activateAll = false;
							}
							await liveSession.refreshMCPTools(mcpResult.tools, { activateAll });
							if (activation.explicitlyRequestedMCPToolNames.length > 0) {
								if (discoveryEnabled && !activation.mcpDiscoveryEnabled) {
									// Discovery flipped on mid-flight: route the explicit request
									// through discovery-aware activation so selection persists.
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
					authStorage,
				});
				mcpManager = mcpResult.manager;
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				// Log MCP errors
				for (const { path, error } of mcpResult.errors) {
					logger.error("MCP tool load failed", { path, error });
				}

				if (mcpResult.tools.length > 0) {
					// MCP tools are LoadedCustomTool, extract the tool property
					customTools.push(...mcpResult.tools.map(loaded => loaded.tool));
				}
			}
		}
		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager && !isInProcessChildSession(options)) MCPManager.setInstance(mcpManager);

		// Add image tools when generation is enabled and either no explicit tool
		// whitelist was given or it names `generate_image`. Unlike built-in tools
		// (filtered in `createTools`), custom tools are force-activated via
		// `alwaysInclude` below, so an explicit `--no-tools`/whitelist must be
		// honored here or image-gen would leak past every filter (issue #5305).
		const imageGenRequested = !options.toolNames || options.toolNames.includes("generate_image");
		if (settings.get("generate_image.enabled") && imageGenRequested) {
			const imageGenTools = await logger.time("getImageGenTools", () => getImageGenTools(modelRegistry, model));
			if (imageGenTools.length > 0) {
				customTools.push(...(imageGenTools as unknown as CustomTool[]));
			}
		}

		// Like image-gen above, tts is a custom tool force-activated via
		// `alwaysInclude`, so an explicit `--no-tools` / tool whitelist must be
		// honored here or it would leak past every filter (issue #5305).
		const speechRequested = !options.toolNames || options.toolNames.includes(ttsTool.name);
		if (settings.get("speechgen.enabled") && speechRequested) {
			customTools.push(ttsTool as unknown as CustomTool);
		}

		// Add web search tools
		if (options.toolNames?.includes(TOOL.web_search)) {
			customTools.push(...getSearchTools());
		}

		// Exa's hosted MCP servers. Both settings default to off, so this costs a
		// round trip only for sessions that asked for the tools. `exa.enabled` is
		// the master switch the search provider already honors, so it gates these
		// too: turning Exa off must turn all of Exa off.
		if (settings.get("exa.enabled")) {
			const exaTools = await logger.time("getExaMcpTools", () =>
				getExaMcpTools({
					researcher: settings.get("exa.enableResearcher"),
					websets: settings.get("exa.enableWebsets"),
				}),
			);
			// Honor an explicit tool whitelist: these are force-activated too, so
			// `--no-tools` / a whitelist that names none of them must drop them all
			// (same leak class as image-gen/tts, issue #5305).
			const whitelist = options.toolNames;
			const requestedExaTools = whitelist
				? exaTools.filter(tool => whitelist.includes((tool as { name: string }).name))
				: exaTools;
			if (requestedExaTools.length > 0) {
				customTools.push(...(requestedExaTools as unknown as CustomTool[]));
			}
		}

		// Discover custom tools from `.veyyon/tools/`, `.claude/tools/`, plugins, etc.
		// Subagents reuse the parent's scan via `preloadedCustomToolPaths` to skip
		// the FS walk, but ALWAYS re-call `loadCustomTools` here so factories bind
		// to THIS session's `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
		// Forwarding the parent's `LoadedCustomTool[]` directly would route tool
		// execution back through the parent — wrong for isolated tasks and for
		// pending-action queueing.
		const builtInToolNames = builtinTools.map(t => t.name);
		// Session CPU budget: every process a custom tool, custom command, or
		// extension spawns through `exec` joins this session's budget group. The
		// closure resolves the limiter lazily, so registration order (limiter
		// created in the AgentSession constructor, tools loaded before it) is
		// irrelevant.
		const adoptSpawnedPid = sessionCpuAdoption(() => toolSession.getSessionId?.() ?? null);
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
			),
		);
		for (const { path, error } of customToolsLoadResult.errors) {
			logger.error("Custom tool load failed", { path, error });
		}
		if (customToolsLoadResult.tools.length > 0) {
			customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
		}
		// Forward the path list (NOT the loaded tools) to subagents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		const inlineExtensions: ExtensionFactory[] = options.extensions ? [...options.extensions] : [];
		inlineExtensions.push((await import("./autoresearch")).createAutoresearchExtension);
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools, text => secretRuntimeLease.obfuscateText(text)));
		}

		// Load extensions. Three paths:
		//   1. `preloadedExtensions` (CLI): caller already loaded — reuse the
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   2. `preloadedExtensionPaths` (subagent): caller resolved paths;
		//      skip the FS scan but always re-call `loadExtensions` here so
		//      each `Extension` binds to THIS session's `ExtensionAPI`
		//      (cwd, eventBus, runtime).
		//   3. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		if (options.preloadedExtensions) {
			extensionsResult = {
				...options.preloadedExtensions,
				extensions: [...options.preloadedExtensions.extensions],
			};
			// Capture paths for downstream forwarding; filter inline-factory
			// entries (`<inline-N>`) — those are per-session, not source paths.
			extensionPaths = extensionsResult.extensions
				.map(ext => ext.resolvedPath)
				.filter(p => !p.startsWith("<inline"));
			// The caller loaded these (the CLI resolves extension flags before a
			// session exists), so the failures came with them. This session is
			// the one that has a surface, so it is the one that reports them.
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
			);
			reportExtensionLoadFailures(extensionsResult, operatorNotices);
		}
		// Forward the source-path list (NOT the loaded instances) so subagents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;

		// Load inline extensions from factories
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
				);
				extensionsResult.extensions.push(loaded);
			}
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
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
		// Hydrate cached runtime (extension) provider catalogs before model
		// resolution. Dynamic-only providers have no synchronous registration side
		// effect, so a cold --model/provider resume must see the same fresh SQLite
		// cache that `veyyon models find` uses before the online refresh continues in
		// the background.
		await modelRegistry.refreshRuntimeProviders("offline");
		// Continue runtime discovery in the background (cache-aware) so startup is
		// only blocked on local cache reads, not provider network fetches.
		void modelRegistry.refreshRuntimeProviders().catch(error => {
			logger.warn("runtime provider discovery failed", {
				error: errorMessage(error),
			});
		});

		// Retry session-model candidates now that extension providers are
		// registered. The initial restore runs before extensions load, so a role
		// model supplied by an extension would have either fallen back to the
		// saved default (`restoredSessionModelIndex > 0`) or failed entirely
		// (`restoredSessionModelIndex === -1`, with the settings default or
		// downstream fallback filling `model`). Reclaim it here so resume
		// honors the last active role in either case.
		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && sessionRetryLimit > 0) {
			for (let i = 0; i < sessionRetryLimit; i++) {
				const sessionModelStr = sessionModelStrings[i];
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
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					// Recompute thinking-level from scratch against the reclaimed
					// model: any value derived from the earlier fallback model's
					// `thinking.defaultLevel` must not become sticky.
					thinkingLevel = pickInitialThinkingLevel(restoredModel);
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
		// Resolve deferred --model/subagent patterns now that extension models are
		// registered. Expand role aliases (`@smol`) and comma chains to concrete
		// selectors first so deferred resolution accepts everything the immediate
		// path (resolveModelOverride → resolveModelRoleValue) accepts.
		if (!model && deferredModelPatterns.length > 0) {
			const expandedModelPatterns = resolveConfiguredModelPatterns(deferredModelPatterns, settings);
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
						const fallback = parseModelPattern(
							options.modelPatternAuthFallback,
							availableModels,
							matchPreferences,
						);
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
					restoredSessionThinkingLevel = selectedThinkingLevel;
				}
				thinkingLevel = pickInitialThinkingLevel(selectedModel);
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
				// Never assume the id is at fault. An empty registry, or one whose
				// credentials can no longer serve a token, is an AUTH failure, and
				// reporting it as an unknown model id is what sent a real
				// investigation into model allowlists for a day (BACKLOG
				// AUTH-FAILURE-BLAMES-MODEL-ID). The classification is
				// `modelResolutionFailureMessage`, under test.
				modelFallbackMessage = modelResolutionFailureMessage(deferredModelPatterns, modelRegistry);
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && deferredModelPatterns.length === 0) {
			// Retry the default-role lookup against the post-extension allowed
			// set. Extension factories register providers AFTER the early
			// `defaultRoleSpec` resolution, so a role pointing at an extension
			// model (e.g. an openai-compat plugin's `posthog/claude-opus-4-8`)
			// returned `undefined` there. Without this retry the next step's
			// `pickDefaultAvailableModel` happily replaces the user's configured
			// default with a bundled provider's default whenever a stray
			// `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issue #3569)
			// setting `model` (+ thinking level) when it resolves. Extension
			// factories register providers AFTER the early `defaultRoleSpec`
			// resolution, and configured discovery providers may still be
			// mid-discovery, so a role pointing at such a model (an openai-compat
			// plugin's `posthog/claude-opus-4-8`, a models.yml `openai-models-list`
			// endpoint) returned `undefined` there. Without this retry the
			// `pickDefaultAvailableModel` fallback below happily replaces the
			// user's configured default with a bundled provider's default whenever
			// a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issues #3569, #6162)
			const tryResolveDefaultRole = async (): Promise<boolean> => {
				if (hasExplicitModel) return false;
				// Re-resolve the allowed set: extension factories and discovery
				// refreshes above may have registered models not visible earlier.
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const reResolvedRoleSpec = resolveModelRoleValue(
					settings.getModelRole(DEFAULT_MODEL_SLOT),
					fallbackCandidates,
					{
						settings,
						matchPreferences: modelMatchPreferences,
					},
				);
				if (!reResolvedRoleSpec.model) return false;
				defaultRoleSpec = reResolvedRoleSpec;
				const resolvedDefaultModel = reResolvedRoleSpec.model;
				model = resolvedDefaultModel;
				modelFallbackMessage = undefined;
				// Recompute the thinking level against the now-real model.
				// `pickInitialThinkingLevel` closes over `defaultRoleSpec`,
				// so the role's explicit selector (e.g. `:max`) now applies.
				thinkingLevel = pickInitialThinkingLevel(resolvedDefaultModel);
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
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));

				// Cold-cache discovery race (issues #6114, #6162): a discovery
				// provider (models.yml `openai-models-list`, LM Studio/Ollama/
				// llama.cpp, or an openai-compat proxy) ships no static models, so
				// the static+cached catalog resolved nothing above. Background
				// discovery in main.ts fires only AFTER createAgentSession returns,
				// so on a cache-cold boot the configured default stays unresolved
				// and `pick` silently degrades to an unrelated authed provider's
				// default (#6162) or "No models available" (#6114) — even though
				// `veyyon models` (which awaits discovery) lists the model. Await one
				// cache-aware discovery pass and retry when a default role is
				// configured (must win over `pick`) or nothing resolved at all.
				// The common path — role already resolved, or a `pick` with no
				// configured default — never pays for it.
				const defaultRoleConfigured = Boolean(settings.getModelRole(DEFAULT_MODEL_SLOT));
				if (
					!hasExplicitModel &&
					(defaultRoleConfigured || !pick) &&
					modelRegistry.getDiscoverableProviders().length > 0
				) {
					await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
					if (!(await tryResolveDefaultRole()) && !model) {
						const refreshedCandidates = await resolveAllowedModels(
							modelRegistry,
							settings,
							modelMatchPreferences,
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
				// The `enabledModels` case already names its real cause. The general
				// case must not: "set an API key" is right only when there is no
				// credential, and it hid a broken registry behind advice about keys.
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
				thinkingLevel = pickInitialThinkingLevel(refreshedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(refreshedModel)
						: resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
				);
			}
		}

		// A first-turn user tail has no assistant metadata to copy. Once startup
		// has selected its final model, use that model to terminate the
		// interrupted turn before the live agent consumes the restored context.
		if (model) {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () => sessionManager.buildSessionContext());
			}
		}

		// Discover custom commands (TypeScript slash commands)
		const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
			? { commands: [], errors: [] }
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir, adoptSpawnedPid });
		if (!options.disableExtensionDiscovery) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		// The runner is created unconditionally — even with zero extensions loaded — because the
		// `ExtensionToolWrapper` installed below is the only place the per-tool approval gate runs.
		// A conditional runner means the approval system silently disappears for users with no
		// extensions, contradicting non-yolo `tools.approvalMode` settings without feedback.
		// (The builtin autoresearch extension is unconditionally loaded above, so this scenario
		// is unreachable; unconditional runner construction keeps that invariant explicit and
		// prevents future optional extensions from silently re-opening the hole.)
		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			() => (hasSession ? createSessionMemoryRuntimeContext(session, agentDir, cwd) : undefined),
			settings,
			localProtocolOptions,
		);

		credentialDisabledTarget = extensionRunner;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			// Same containment as the live path above: nothing awaits this drain.
			void extensionRunner.emitCredentialDisabled(event).catch(error => {
				logger.warn("Failed to deliver a buffered credential-disabled event to extensions", {
					error: errorMessage(error),
				});
			});
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				abortDetached(session, "sdk.agentControl.abort", USER_INTERRUPT_LABEL);
			},
			settings,
			obfuscateProviderText: (text: string) => secretRuntimeLease.obfuscateText(text),
			localProtocolOptions,
			autoApprove: options.autoApprove ?? false,
			// Live read so a mid-session `/yolo` toggle takes effect on the next
			// tool call (getSessionContext runs per tool-execution context build).
			bypassAllApprovals: session.isApprovalBypassed(),
			sessionApprovals: session.sessionToolApprovals(),
		});
		const toolContextStore = new ToolContextStore(getSessionContext);
		// Tool calls the model makes go through the agent loop, which resolves the
		// context itself. Calls an eval snippet or a browser page makes reach the
		// same approval-wrapped tools directly, so they need the same context or
		// they arrive with no policy at all.
		toolSession.getToolContext = toolCall => toolContextStore.getContext(toolCall);

		const registeredTools = extensionRunner.getAllRegisteredTools();
		const sdkCustomTools = options.customTools?.filter(tool => !isLegacyBuiltinToolDefinition(tool)) ?? [];
		const allCustomTools = [
			...registeredTools,
			...sdkCustomTools.map(tool => {
				const definition = isCustomTool(tool)
					? customToolToDefinition(tool, text => secretRuntimeLease.obfuscateText(text))
					: tool;
				return { definition, extensionPath: "<sdk>" };
			}),
		];
		// `wrapToolWithMetaNotice` runs the centralized large-output → artifact spill.
		// Built-in tools get it in `createTools`; extension, SDK-custom, image-gen,
		// TTS, and startup (non-deferred) MCP tools all funnel through here, so apply
		// it once at this adapter boundary (idempotent — a no-op if already wrapped).
		const wrappedExtensionTools: Tool[] = wrapRegisteredTools(allCustomTools, extensionRunner).map(
			wrapToolWithMetaNotice,
		);

		// All built-in tools are active (conditional tools like git/ask return null from factory if disabled)
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
			for (const name of collectPendingMCPToolNames(options.toolNames, existingSession.selectedMCPToolNames)) {
				if (!toolRegistry.has(name)) {
					toolRegistry.set(name, createPendingMCPTool(name));
				}
			}
		}

		// Wrap every tool with `ExtensionToolWrapper` so the per-tool approval gate runs on every
		// call site, regardless of whether any user extensions are loaded. See the runner-construction
		// comment above for the safety invariant this enforces.
		for (const tool of toolRegistry.values()) {
			toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
		}

		// `resolve` is hidden but must stay in the registry whenever any code path can invoke it:
		// either a deferrable tool stages a preview action, or plan mode installs a standing handler
		// that consumes `resolve { action: "apply" }` to submit the plan for approval (issue #1428).
		// Dropping it on read-only sessions (e.g. plan-mode toolset `read`, `search`, `find`,
		// `web_search`) leaves plan mode unable to exit through the intended path.
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

		// `let`: the deferred MCP discovery closure upgrades these when the real
		// MCP tool count pushes `auto` past its threshold; `rebuildSystemPrompt`
		// below reads the live bindings.
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
		let mcpDiscoveryEnabled = effectiveDiscoveryMode !== "off"; // back-compat: true when any discovery active

		async function enableDeferredMCPDiscoveryForTools(
			liveSession: AgentSession,
			mcpTools: CustomTool[],
		): Promise<boolean> {
			if (mcpDiscoveryEnabled) return true;
			const nonMCPToolNames = [...toolRegistry.keys()].filter(name => !isMCPToolName(name));
			const projectedMode = resolveEffectiveToolDiscoveryMode(
				settings,
				countToolsForAutoDiscovery([...nonMCPToolNames, ...mcpTools.map(tool => tool.name)]),
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
				await liveSession.setActiveToolsByName([...liveSession.getActiveToolNames(), TOOL.search_tool_bm25]);
			}
			return true;
		}

		const reloadSshTool = async (): Promise<AgentTool | null> => {
			if (!requestedToolNameSet.has(TOOL.ssh)) return null;
			const { loadSshTool } = await import("./tools/ssh");
			const sshTool = (await loadSshTool({
				...toolSession,
				cwd: sessionManager.getCwd(),
			})) as unknown as AgentTool | null;
			if (!sshTool) return null;
			const wrapped = wrapToolWithMetaNotice(sshTool);
			return new ExtensionToolWrapper(wrapped, extensionRunner) as AgentTool;
		};

		let cursorEventEmitter: ((event: AgentEvent) => void) | undefined;
		const cursorExecHandlers = new CursorExecHandlers({
			cwd,
			tools: toolRegistry,
			getToolContext: () => toolContextStore.getContext(),
			emitEvent: event => cursorEventEmitter?.(event),
		});

		// Keep prompt placement and provider-schema pruning on one per-model
		// decision. A session can switch model families, and `auto` deliberately
		// chooses different representations for Gemini and native OpenAI models.
		const inlineToolDescriptorsForModel = (requestModel: Model): boolean =>
			shouldInlineToolDescriptors(settings.get("inlineToolDescriptors"), requestModel.id);
		// A RESOLVER, not a captured constant, and that is the whole reason
		// `tools.intentTracing` is a live prompt gate. Read once here, every later
		// `rebuildSystemPrompt` re-read the session-start value, so flipping the setting
		// mid-session changed the settings UI and nothing else: the prompt kept its old
		// text and the tool schemas kept their old shape, with nothing to say so. The two
		// reads have to move together -- a prompt explaining an intent field the schemas
		// do not carry is worse than one that omits it -- which is why the agent option
		// below takes the same resolver rather than a value.
		const intentTracingEnabled = () => resolveIntentField(settings) !== undefined;
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

					// A newer cwd transition won the race. Discard these bytes rather
					// than installing one project's inputs under another project's path.
					if (path.resolve(sessionManager.getCwd()) !== liveCwd) return;

					const previousTtsrRules = ttsrManager.getRules();
					ttsrManager.clearRules();
					let nextBuckets: RuleBuckets;
					try {
						const ttsrSettings = settings.getGroup("ttsr");
						nextBuckets = bucketRules(nextRulesResult.items, ttsrManager, {
							builtinRules: ttsrSettings.builtinRules,
							disabledRules: ttsrSettings.disabledRules,
							experimentalRules: ttsrSettings.experimentalRules,
						});
					} catch (error) {
						ttsrManager.clearRules();
						for (const rule of previousTtsrRules) ttsrManager.addRule(rule);
						throw error;
					}

					const nextAdvisorWatchdogPrompts = [...nextWatchdogFiles];
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
					if (hasSession) session.replaceSkills(nextSkillsResult.skills);
					if (hasSession) {
						session.replaceProjectAdvisorScope({
							advisorWatchdogPrompt: nextAdvisorWatchdogPrompt,
							advisorContextPrompt: nextAdvisorContextPrompt,
							advisorSharedInstructions: nextAdvisorConfigs.sharedInstructions,
							advisorConfigs: nextAdvisorConfigs.advisors,
						});
					}
					for (const warning of nextSkillsResult.warnings ?? []) {
						operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
					}
					ttsrManager.reportUnknownToolScopes(toolRegistry.keys());
					if (!isInProcessChildSession(options)) {
						setActiveSkills(nextSkillsResult.skills);
						setActiveRules([
							...nextBuckets.rulebookRules,
							...nextBuckets.alwaysApplyRules,
							...ttsrManager.getRules(),
						]);
					}
				});
			projectInputRefresh = refresh;
			await refresh;

			if (path.resolve(sessionManager.getCwd()) !== promptInputCwd) {
				await refreshProjectPromptInputs();
			}
		};
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
		): Promise<BuildSystemPromptResult> => {
			await refreshProjectPromptInputs();
			toolContextStore.setToolNames(toolNames);
			const discoverableMCPTools: DiscoverableTool[] = mcpDiscoveryEnabled
				? filterBySource(collectDiscoverableTools(tools.values()), "mcp")
				: [];
			const activeToolNames = new Set(toolNames);
			const discoverableLocalTools: DiscoverableTool[] =
				effectiveDiscoveryMode === "all"
					? Array.from(tools.values()).flatMap(tool => {
							if (tool.loadMode !== "discoverable" || activeToolNames.has(tool.name)) return [];
							return collectDiscoverableTools([tool], {
								source: builtInRegistryToolNames.has(tool.name) ? "builtin" : "custom",
							});
						})
					: [];
			const discoverableToolsForDesc: DiscoverableTool[] = [...discoverableLocalTools, ...discoverableMCPTools];
			const discoverableToolSummary = summarizeDiscoverableTools(discoverableToolsForDesc);
			const hasDiscoverableTools =
				mcpDiscoveryEnabled && toolNames.includes(TOOL.search_tool_bm25) && discoverableToolsForDesc.length > 0;
			const promptTools = buildSystemPromptToolMetadata(tools, {
				search_tool_bm25: { description: renderSearchToolBm25Description(discoverableToolsForDesc) },
			});
			// Ask the live task tool which agents this session may spawn, rather than
			// re-running discovery here: it already filtered its discovered set
			// through `subagent.agents`, and the prompt must describe exactly the
			// agents the tool will accept. Absent when delegation is off.
			// Every settings-fed prompt gate, from the ONE resolver the inspection path
			// (`veyyon prompt`) also calls. These twelve reads used to live here and nowhere else,
			// which is how the inspection path came to render a prompt no session sends.
			// `system-prompt-builder/gate-inputs.ts` says what each read is and why.
			const gateInputs = resolveGateInputs(settings, {
				tools,
				model: agent?.state.model ?? model,
				taskDepth: options.taskDepth ?? 0,
			});
			const memoryBackend = await resolveMemoryBackend(settings);
			const memoryInstructions = await memoryBackend.buildDeveloperInstructions(agentDir, settings, session);

			// Build combined append prompt: memory instructions + auto-learn guidance
			// + MCP server instructions. For UI sessions MCP discovery is deferred, so
			// `getServerInstructions()` is empty until the background connect completes;
			// the rebuild that `refreshMCPTools` triggers post-discovery then picks up
			// the now-connected servers' instructions, so they join the prompt for the
			// rest of the session.
			const serverInstructions = mcpManager?.getServerInstructions();
			// Drive guidance off the auto-learn BUILTINS that createTools actually built
			// (provenance, not just an active name): `builtInToolNames` excludes a
			// custom/extension tool that merely shares the name, and reflects the
			// session-start build — so a subagent that filtered them out, a mid-session
			// enable that never built them, or a same-named custom tool while auto-learn
			// is off all get no guidance.
			const autoLearnInstructions = buildAutoLearnInstructions({
				manageSkill: builtInToolNames.includes(TOOL.manage_skill),
				learn: builtInToolNames.includes(TOOL.learn),
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
				appendPrompt = appendPrompt
					? `${appendPrompt}\n\n${options.appendSystemPrompt}`
					: options.appendSystemPrompt;
			}
			// Gate teaching by the encode policy: the active model must be on the
			// allowlist and the context under the cutoff. When encoding is on, the
			// prompt always carries the notation preamble (which also tells the model
			// to load its project itself through argot_load); the concrete handle
			// table is added once the model has loaded one. Decoding is unaffected —
			// handles already in history still expand at the seams whatever this holds.
			const argotActiveModel = getActiveModelString();
			const argotCanEncode =
				argotEnabled &&
				argot !== undefined &&
				argotActiveModel !== undefined &&
				shouldEncode(argotGate, { model: argotActiveModel, contextTokens: argotContextTokens });
			const defaultPrompt = await buildSystemPromptInternal({
				...gateInputs,
				// `includeWorkspaceTree` is captured once at session start and
				// `gate-registry.ts` records that placement. Descriptor placement
				// stays live in `gateInputs`: the same active-model policy also
				// drives provider-schema pruning below, so a model switch cannot
				// retain the previous model family's more expensive representation.
				includeWorkspaceTree: settings.get("includeWorkspaceTree") ?? false,
				// A subagent gets no personality regardless of the setting. That is a fact about
				// this caller, not about the configuration, so it does not belong in the resolver.
				personality: agentKind === "sub" ? "none" : gateInputs.personality,
				cwd: promptInputCwd,
				agentDir,
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: promptSkills,
				// Cursor's server replaces client system-prompt blobs with its own canned prompt,
				// so on cursor-agent models the operator's layers travel as requestContext rules
				// (the `cursorRulesResolver` below) and NOTHING inlines here: a repository file may
				// not configure the agent, and inlining the operator's files too would deliver
				// them twice. `[]` is the deliberate "resolved to nothing"
				// `BuildSystemPromptOptions.contextFiles` documents, not a discovery miss.
				contextFiles: usesCursorRuleDelivery(agent?.state.model ?? model) ? [] : promptContextFiles,
				tools: promptTools,
				toolNames,
				rules: promptRulebookRules,
				alwaysApplyRules: promptAlwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				mcpDiscoveryMode: hasDiscoverableTools,
				mcpDiscoveryServerSummaries: discoverableToolSummary.servers.map(formatDiscoverableToolServerSummary),
				secretsEnabled: obfuscator?.hasSecrets() === true,
				// Read LATE, inside the build, never snapshotted when the runtime was
				// constructed. `namedSecretNames()` expires stale entries while answering, so
				// asking it here is what drops a credential that lapsed mid-session out of the
				// prompt, and reading the live `obfuscator` binding is what drops one that
				// `/secret rm` revoked. Undefined (protection off, or an empty vault) emits no
				// section at all.
				secretInventory: renderSecretInventory(obfuscator?.namedSecretNames()),
				argotPreamble: argotCanEncode ? renderPreamble({ tools: true }) : undefined,
				argotHandles: argotCanEncode && argot.loaded ? argot.promptFragment() : undefined,
				workspaceTree: promptWorkspaceTree,
				memoryRootEnabled: memoryBackend.id === "local",
				model: getActiveModelString(),
				activeRepoContext: promptActiveRepoContext,
				sectionOrder: resolvePromptSectionOrderForModel(settings, agent?.state.model ?? model),
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
				// The caller replaced the assembled prompt, so no statement produced these blocks.
				statementContext: null,
				statementOverrides: null,
				replacedStatementSections: [],
			};
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
		// When `requireYieldTool` is set, the subagent's prompts and idle-reminders demand a
		// `yield` call to terminate. The tool registry already includes `yield` (see
		// `createTools`), but an explicit `toolNames` list would otherwise drop it from the
		// active set — leaving the model unable to satisfy the contract. Mirror the same
		// invariant `parseAgentFields` enforces on frontmatter `tools`.
		if (
			options.requireYieldTool === true &&
			explicitlyRequestedToolNames &&
			!explicitlyRequestedToolNames.includes(TOOL.yield)
		) {
			explicitlyRequestedToolNames.push(TOOL.yield);
		}
		// Auto-learn builtins are force-included into the registry by `createTools`
		// for enabled top-level sessions (tools/index.ts), but — like `yield` above —
		// an explicit `toolNames` list would otherwise drop them from the ACTIVE set,
		// leaving the nudge/guidance pointing at tools the model cannot call. Activate
		// exactly the builtins createTools built (`builtInToolNames` — provenance, so a
		// same-named custom/extension tool is never force-activated when auto-learn is
		// off) to keep guidance, controller, and the active set consistent.
		if (explicitlyRequestedToolNames) {
			for (const name of [TOOL.manage_skill, TOOL.learn]) {
				if (builtInToolNames.includes(name) && !explicitlyRequestedToolNames.includes(name)) {
					explicitlyRequestedToolNames.push(name);
				}
			}
		}
		const requestedToolNames = explicitlyRequestedToolNames ?? toolNamesFromRegistry;
		const normalizedRequested = requestedToolNames.filter(name => toolRegistry.has(name));
		const requestedToolNameSet = new Set(normalizedRequested);
		// The registry is complete here, MCP and extension tools included, which is the first point where
		// "this rule is scoped to a tool that does not exist" is answerable. Checked against the whole
		// registry rather than the active set: scoping a rule to a tool the user has not activated is
		// legitimate, and a rule that names no tool at all is a typo that would otherwise never fire.
		ttsrManager.reportUnknownToolScopes(toolRegistry.keys());
		// Effective discovery mode is resolved after the full registry exists so auto mode can count MCP/extension tools.
		const defaultInactiveToolNames = new Set(
			registeredTools.filter(tool => tool.definition.defaultInactive).map(tool => tool.definition.name),
		);
		const discoveryDefaultServers = new Set(
			(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
		);
		const discoveryDefaultServerToolNames = mcpDiscoveryEnabled
			? selectDiscoverableToolNamesByServer(
					filterBySource(collectDiscoverableTools(toolRegistry.values()), "mcp"),
					discoveryDefaultServers,
				)
			: [];
		// Custom tools and extension-registered tools are always included regardless of toolNames filter
		const alwaysInclude: string[] = [
			...sdkCustomTools.map(t => (isCustomTool(t) ? t.name : t.name)),
			...registeredTools.filter(t => !t.definition.defaultInactive).map(t => t.definition.name),
		];
		// Everything above is INPUT GATHERING. The six stages that turn it into an active set —
		// dropping `goal`, dropping `defaultInactive`, merging the MCP selection, appending
		// `alwaysInclude`, hiding discoverables under `all`, and the harness allowlist — all live in
		// `resolveInitialActiveToolNames` (`tools/loading/policy.ts`), together with every other
		// tool-loading rule. Note `explicitToolNames` is the RAW `options.toolNames`, NOT
		// `explicitlyRequestedToolNames`: the yield / auto-learn names forced into the latter are
		// activations, not user requests, and must not exempt a tool from discovery-all hiding.
		const {
			initialToolNames,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			explicitlyRequestedMCPToolNames,
		} = resolveInitialActiveToolNames({
			explicitToolNames: options.toolNames ? normalizeToolNames(options.toolNames) : undefined,
			requestedToolNames: normalizedRequested,
			defaultInactiveToolNames,
			hasRegistryTool: name => toolRegistry.has(name),
			mcpDiscoveryEnabled,
			discoveryDefaultServerToolNames,
			persistedSelectedMCPToolNames: existingSession.selectedMCPToolNames,
			hasPersistedMCPToolSelection: existingSession.hasPersistedMCPToolSelection,
			alwaysIncludeToolNames: alwaysInclude,
			effectiveDiscoveryMode,
			loadModeOf: name => toolRegistry.get(name)?.loadMode,
			essentialToolNames: computeEssentialBuiltinNames(settings),
			forceActiveToolNames: resolveDiscoveryAllForceActive({
				todoEager: settings.get("todo.eager"),
				todoEnabled: settings.get("todo.enabled"),
				hasTodoTool: toolRegistry.has(TOOL.todo),
				delegationStrength: delegationStrength(settings),
				hasTaskTool: toolRegistry.has(TOOL.task),
			}),
			harnessToolAllowlist: resolveHarnessProfileForModel(settings, model)?.tools,
		});

		// Pre-register in the global agent registry before session construction so
		// tool routing and IRC discovery can resolve this agent immediately. The
		// session reference is attached after construction below.
		agentRegistry.register({
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			// The conversation this agent belongs to. A subagent inherits its
			// parent's, so only a root session states one: its session id, which
			// exists before the transcript has ever been written and survives a
			// `/move` that rewrites the path.
			scope: options.parentAgentId ? undefined : (sessionManager.getSessionId?.() ?? undefined),
			status: "running",
			model: getActiveModelString(),
		});
		hasRegistered = true;

		setActiveToolNames(initialToolNames);
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		const secretRuntimeByObject = new WeakMap<object, SecretRuntimeLease>();
		const bindSecretRuntime = (value: unknown, runtime: SecretRuntimeLease): void => {
			if (typeof value !== "object" || value === null) return;
			secretRuntimeByObject.set(value, runtime);
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "object" && item !== null) secretRuntimeByObject.set(item, runtime);
				}
			}
		};
		const resolveSecretRuntimeForContext = (context: Context): SecretRuntimeLease | undefined => {
			const direct = secretRuntimeByObject.get(context) ?? secretRuntimeByObject.get(context.messages);
			if (direct) return direct;
			for (const message of context.messages) {
				const runtime = secretRuntimeByObject.get(message);
				if (runtime) return runtime;
			}
			return undefined;
		};
		let activeMainRequestRuntime = secretRuntimeLease;

		// Acquire before the first async extension hook. The returned arrays and
		// context retain this exact authority through provider serialization.
		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const runtime = await leaseSecretRuntime();
			activeMainRequestRuntime = runtime;
			bindSecretRuntime(messages, runtime);
			const withContext = await extensionRunner.emitContext(messages);
			const transformed = wrapSteeringForModel(withContext);
			bindSecretRuntime(withContext, runtime);
			bindSecretRuntime(transformed, runtime);
			return transformed;
		};

		const convertToLlmFinal = (messages: AgentMessage[]): Message[] => {
			const runtime = secretRuntimeByObject.get(messages) ?? activeMainRequestRuntime;
			// No image policy here. Conversion sees one model per session, while the
			// main turn, a side request, compaction and an advisor each dispatch
			// their own; the policy resolves in AgentSession's provider-context hook,
			// which knows the model the request is actually going to.
			const converted = filterProviderReplayMessages(convertToLlm(messages));
			const redacted = runtime.obfuscateMessages(converted);
			bindSecretRuntime(converted, runtime);
			bindSecretRuntime(redacted, runtime);
			return redacted;
		};

		const transformProviderContext = async (
			context: Context,
			_transformModel: Model,
			requestRuntime?: SecretRuntimeLease,
		): Promise<Context> => {
			const runtime = requestRuntime ?? resolveSecretRuntimeForContext(context) ?? activeMainRequestRuntime;
			const transformed = runtime.obfuscateContext(context);
			bindSecretRuntime(context, runtime);
			bindSecretRuntime(transformed, runtime);
			bindSecretRuntime(transformed.messages, runtime);
			return transformed;
		};

		// Raw extension hook. The leased stream wrapper performs the final
		// redaction after this await with the request's immutable runtime.
		const onPayload = async (payload: unknown, _model?: Model) =>
			(await extensionRunner.emitBeforeProviderRequest(payload)) ?? payload;
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools = initialToolNames
			.map(name => toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined);

		// Fall back to the schema default ("auto"), matching command-controller.ts.
		// The old "off" fallback disagreed with both the schema and that sibling, so
		// a resolved-undefined value would have silently disabled websockets here
		// while the command controller kept them on.
		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "auto";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const initialServiceTierByFamily = hasServiceTierEntry
			? (existingSession.serviceTier ?? {})
			: buildServiceTierByFamily(
					settings.get("tier.openai"),
					settings.get("tier.anthropic"),
					settings.get("tier.google"),
				);

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		// Shared, settings-aware stream wrapper used by the main agent, advisor,
		// and side-channel requests (`/btw`, `/omfg`, IRC auto-replies, handoff).
		// Keeps OpenRouter sticky-routing variants, antigravity endpoint routing,
		// in-flight caps, and the loop guard consistent across every provider call
		// the session drives. Wrapped in a per-provider concurrency limiter so
		// each LLM HTTP request — not the whole subagent lifecycle — holds the
		// slot, preventing the nested-spawn deadlock from issue #3749.
		const settingsAwareStreamFn = wrapStreamFnWithProviderConcurrency(
			settings,
			createSettingsAwareStreamFn(settings),
		);
		const callerTelemetryTextSanitizer = options.telemetry?.textSanitizer;
		const telemetry: AgentTelemetryConfig = {
			...(options.telemetry ?? {}),
			textSanitizer: text =>
				secretRuntimeLease.obfuscateText(callerTelemetryTextSanitizer ? callerTelemetryTextSanitizer(text) : text),
		};
		// One warning per model when auto tool-format reroutes a non-tool-calling
		// model onto an in-band text dialect — the operator must see the degrade.
		const notifiedDialectFallbackModels = new Set<string>();
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,
			// Live cwd: `/move` updates SessionManager (and process cwd) without
			// reconstructing the Agent, so a static cwd would strand GitLab Duo Agent
			// namespace/project discovery on the original repo's git remote. Re-read it
			// per turn from the SessionManager.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			// Unset is exactly UNSET_NUMBER, read through its one owner. The previous
			// `>= 0` test also discarded every legitimate negative value, so a
			// configured negative presence/repetition penalty (both providers accept
			// them) silently never reached the request.
			temperature: optionalNumber(settings.get("temperature")),
			topP: optionalNumber(settings.get("topP")),
			topK: optionalNumber(settings.get("topK")),
			minP: optionalNumber(settings.get("minP")),
			presencePenalty: optionalNumber(settings.get("presencePenalty")),
			repetitionPenalty: optionalNumber(settings.get("repetitionPenalty")),
			hideThinkingSummary: settings.get("omitThinking"),
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			preferWebsockets: preferOpenAICodexWebsockets,
			getToolContext: tc => toolContextStore.getContext(tc),
			getApiKey: requestModel => modelRegistry.resolver(requestModel, agent.sessionId),
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
				const runtime = resolveSecretRuntimeForContext(context) ?? activeMainRequestRuntime;
				const optionsForRequest = streamOptions ?? {};
				const requestOnPayload = optionsForRequest.onPayload;
				const leasedOnPayload =
					runtime.hasRedactions || requestOnPayload
						? async (payload: unknown, payloadModel?: Model) => {
								const replacement = requestOnPayload
									? await requestOnPayload(payload, payloadModel)
									: undefined;
								return runtime.obfuscatePayload(replacement ?? payload);
							}
						: undefined;
				return settingsAwareStreamFn(streamModel, context, {
					...optionsForRequest,
					onPayload: leasedOnPayload,
				});
			},
			cursorExecHandlers,
			// Reads the live `promptContextFiles` binding at turn time, so a `/reload` or
			// `/move` reaches the next Cursor request. Composition policy (operator scopes
			// only, repository files never) lives in `cursorContextFileRules`.
			cursorRulesResolver: () => cursorContextFileRules(promptContextFiles),
			transformToolCallArguments: (args, toolName) => {
				// `display` is what an operator reads and what the session records;
				// `execution` is what the tool runs with. They diverge on exactly one thing
				// below, and that divergence is the point of the split.
				let display = args;
				const maxTimeout = settings.get("tools.maxTimeout");
				if (maxTimeout > 0 && typeof display.timeout === "number") {
					display = {
						...display,
						timeout: Math.min(display.timeout, maxTimeout),
					};
				}
				let execution = display;
				const requestRuntime = activeMainRequestRuntime;
				const requestObfuscator = requestRuntime.expansionObfuscator;
				if (requestObfuscator === undefined && requestRuntime.redactionObfuscator) {
					mapJsonStrings(display as JsonWithOptionalFields, text => {
						requestRuntime.redactionObfuscator?.assertNoRetiredPlaceholder(text);
						return text;
					});
				}
				// Before the `hasSecrets()` gate on purpose: when the unreadable scope was
				// the only source of secrets there is nothing in the obfuscator and that
				// gate is false, which is exactly the case this has to catch.
				assertNoOrphanPlaceholderWhileVaultUnreadable(requestRuntime, display);
				if (requestObfuscator?.hasSecrets()) {
					// Freshness is a question about THIS payload, not about the session.
					// The revision compare is the cheap half, so it runs first; only when
					// it fails is walking the arguments worth its cost. A payload that
					// carries no placeholder this runtime would substitute expands to
					// itself, so a moved revision cannot make it wrong and must not cost
					// it a refusal. That is the whole reason a placeholder-free `bash` call
					// used to be rejected out of a session holding any secret.
					let expansionLease = requestRuntime;
					let expansionObfuscator = requestObfuscator;
					if (
						!requestRuntime.isFreshForExpansion() &&
						toolArgumentsCarryLivePlaceholder(requestObfuscator, display)
					) {
						const fresh = resolveFreshExpansionAuthority(requestRuntime);
						if (fresh === undefined) {
							// Schedules the reload the retry will expand against, then
							// refuses this one call rather than spending a value the vault
							// may already have replaced. The agent loop turns this into a
							// failed tool result, never an unwound session.
							requestRuntime.assertFreshForExpansion();
						} else {
							expansionLease = fresh;
							expansionObfuscator = fresh.expansionObfuscator ?? requestObfuscator;
						}
					}
					// The audit log travels with whichever lease supplied the expansion
					// authority, because both were built by the same load: a log that
					// named a placeholder the other snapshot resolved would describe an
					// event that never happened.
					const requestAuditLog = auditLogBySecretLease.get(expansionLease);
					if (requestAuditLog !== undefined) {
						const record = buildExpansionRecord({
							args: display,
							tool: toolName,
							session: agent.sessionId,
							at: Date.now(),
							known: placeholder => expansionObfuscator.knowsPlaceholder(placeholder),
							obfuscate: value => requestRuntime.obfuscateText(value),
						});
						if (record !== null) requestAuditLog.record(record);
					}
					// The operator-visible half of the same fact, on the session's notice event so
					// the transcript carries it in EVERY approval mode. The audit log is a file read
					// afterwards and the secret-use boundary is skipped under yolo / the `/yolo`
					// bypass, which is the configuration most likely to be running unattended: this
					// is the only thing that says a credential left the vault while it happens. Read
					// BEFORE expansion, because after it there is no placeholder left to name, and
					// never gated on `secrets.auditLog` — recording a spend and showing one are
					// separate obligations.
					const spend = secretSpendMarker(display, toolName, placeholder =>
						expansionObfuscator.knowsPlaceholder(placeholder),
					);
					if (spend !== undefined) session?.emitNotice("info", spend, SECRET_SPEND_NOTICE_SOURCE);
					// EXECUTION ONLY. The substituted text is a live credential, so the tool
					// gets it and nothing else does: `display` keeps the placeholder, which is
					// what reaches the rendered tool card, `tool_execution_start`, the
					// telemetry span and the session file. A renderer cannot leak a value it
					// was never handed.
					execution = deobfuscateToolArguments(expansionObfuscator, display);
				}
				// BOTH. A codec handle is opaque to a person, so an unexpanded display is the
				// bug rather than the protection — the opposite of a secret. When no secret
				// expanded, `execution` is still the same object as `display` and one walk
				// serves both.
				if (argot?.loaded) {
					const expandedDisplay = expandToolArguments(argot, display);
					execution = execution === display ? expandedDisplay : expandToolArguments(argot, execution);
					display = expandedDisplay;
				}
				return { execution, display };
			},
			repairToolCallArguments: createRepairToolCallArgumentsHook(settings, () => agent.state.model),
			// The RESOLVERS keep provider schemas synchronized with the rebuilt
			// prompt on settings changes and model-family switches.
			intentTracing: intentTracingEnabled,
			instrumentation: settings.get("session.instrumentation"),
			pruneToolDescriptions: inlineToolDescriptorsForModel,
			// Re-resolved with the active model on every request so mid-session
			// model switches pick the right tool-calling shape (a switch to a
			// `supportsTools: false` model must stop sending a native `tools`
			// param the endpoint rejects with a 400).
			dialect: requestModel => {
				const dialect = resolveDialect(settings.get("tools.format"), requestModel);
				if (dialect !== undefined && requestModel.supportsTools === false) {
					const modelKey = `${requestModel.provider}/${requestModel.id}`;
					if (!notifiedDialectFallbackModels.has(modelKey)) {
						notifiedDialectFallbackModels.add(modelKey);
						session?.emitNotice(
							"warning",
							`${modelKey} is cataloged as non-tool-calling; tools are delivered through the "${dialect}" text dialect instead of the native tools parameter.`,
							"tools.format",
						);
					}
				}
				return dialect;
			},
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => session?.nextToolChoiceDirective(),
			telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});

		cursorEventEmitter = event => agent.emitExternalEvent(event);

		// Track the live context size for the argot encode cutoff. The prompt the
		// model saw this turn is its input plus cached-prompt tokens; output is
		// excluded. Read from the assistant message's usage so no re-estimation is
		// needed. Next turn's system-prompt rebuild reads this to decide whether to
		// keep teaching shorthand (see argotGate / shouldEncode below).
		if (argotEnabled && argotGate.disableAboveTokens > 0) {
			agent.subscribe(event => {
				if (event.type !== "turn_end") return;
				const usage = (event.message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } })
					.usage;
				if (usage) {
					argotContextTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				}
			});
		}

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
		} else {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			if (!autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel);
			}
			if (Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(initialServiceTierByFamily);
			}
		}

		// Full toolset for the advisor, built unconditionally so it can be toggled at
		// runtime. Bound to a DISTINCT ToolSession (its own `-advisor` session id +
		// agent id) so the advisor's tool state — snapshot, seen-lines, conflict, and
		// summary caches, all keyed on session identity — stays isolated from the
		// primary, while edit/bash/write stay fully functional: the advisor is a full
		// agent and its config's `tools` selects which of these it actually gets
		// (defaulting to read/grep/glob).
		const advisorToolSession: ToolSession = {
			...toolSession,
			get cwd() {
				return sessionManager.getCwd();
			},
			setCwd: async (resolvedPath, options) =>
				session ? session.setCwd(resolvedPath, options) : setCwdBeforeSessionExists(resolvedPath, options),
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

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (activeRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(activeRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
		// Hand the advisor the same project context files (AGENTS.md, etc.) the
		// primary agent gets in its system prompt, so the read-only reviewer judges
		// against the instruction files instead of advising blind.
		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		session = new AgentSession({
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorConfigs: discoveredAdvisors.advisors,
			agent,
			pruneToolDescriptions: inlineToolDescriptorsForModel,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			thinkingSource,
			prewalk: options.prewalk,
			planYolo: options.planYolo,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			settings,
			autoApprove: options.autoApprove,
			bypassAllApprovals: options.bypassAllApprovals,
			parentApprovalBypassed: options.parentApprovalBypassed,
			evalKernelOwnerId,
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			customCommands: customCommandsResult.commands,
			skills,
			operatorNotices,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			toolRegistry,
			createVibeTools: sessionIsSubagent ? undefined : () => createVibeTools(toolSession),
			// A subagent shares this process with its parent and its siblings, so its
			// re-root may not move the process working directory or any other
			// process-global project state. See `AgentSession.rescopeToCwd`.
			isSubagent: sessionIsSubagent,
			builtInToolNames: builtInRegistryToolNames,
			transformContext,
			transformProviderContext,
			onPayload,
			onResponse,
			sideStreamFn: settingsAwareStreamFn,
			preferWebsockets: preferOpenAICodexWebsockets,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			reloadSshTool,
			requestedToolNames: requestedToolNameSet,
			setActiveToolNames,
			getMcpServerInstructions: mcpManager
				? () => {
						const raw = mcpManager!.getServerInstructions();
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
			mcpDiscoveryEnabled,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: [...discoveryDefaultServers],
			ttsrManager,
			obfuscator,
			secretRuntime: secretRuntimeLease,
			leaseSecretRuntime,
			resolveSecretRuntimeLeaseForContext: resolveSecretRuntimeForContext,
			refreshSecretRuntime,
			argot,
			agentId: resolvedAgentId,
			agentKind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource,
			parentEvalSessionId: options.parentEvalSessionId,
			advisorTools,
			titleSystemPrompt: options.titleSystemPrompt,
		});
		hasSession = true;

		if (
			shouldAutoloadArgotAtStartup({
				enabled: argotEnabled,
				autoload: settings.get("argot.autoload"),
				argot,
			}) &&
			argot !== undefined
		) {
			// The adoption path auto-loads the launch project so the feature works
			// out of the box; argot_load remains the way to teach additional
			// projects, and `argot.autoload` off leaves every load to it. The load
			// runs in the background: the first dictionary
			// generation in a project walks the repo, and awaiting it inline
			// would block session construction on large trees. The completed load
			// refreshes the base system prompt to teach the handles — the same
			// contract as argot_load.
			void armArgotAfterStartup({
				argot,
				cwd,
				tokenBudget: settings.get("argot.tokenBudget"),
				// Refresh the prompt to teach the handles, then RECORD what the refresh
				// actually produced. Without this record nothing downstream can tell a
				// session that taught 551 handles from one that taught none: the only
				// prompt in the transcript is `session_init`, written before this
				// background arm completes, so it always shows an unarmed prompt. An
				// eval reading it therefore charged "the model ignored the handles" to
				// the model, when the same evidence is equally consistent with the
				// table never reaching the model at all. This entry is the difference.
				onArmed: async () => {
					const prompt = await session.refreshBaseSystemPrompt("argot-arm");
					const joined = prompt.join("\n\n");
					const taughtHandles = argot.loaded ? argot.vocabulary().handles.size : 0;
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
						// Fail loud rather than degrade quietly: an armed session whose
						// prompt carries no table is inert, and silence here is what made
						// that state indistinguishable from the feature being off.
						logger.error(
							"argot: refreshed system prompt carries no handle table; session is effectively UNARMED",
							{
								cwd,
								handles: taughtHandles,
							},
						);
					}
				},
				// Record the actually-loaded vocabulary (including an empty one) as
				// durable session telemetry. An eval reading the transcript otherwise
				// cannot tell an empty-dictionary corpus (nothing to encode) from a
				// loaded dictionary the model ignored: session_init snapshots the
				// startup prompt before this async arm, so the handle table never
				// appears in any recorded prompt. The entries ride along because a
				// count cannot bound the effect — computing how much the model COULD
				// have saved needs the actual expansions. Same custom_message channel
				// as cwd_changed; a few KB at most, written once per session.
				onResolved: vocab => {
					sessionManager.appendCustomMessageEntry(
						"argot_armed",
						`argot: launch project armed with ${vocab.handles} handle${vocab.handles === 1 ? "" : "s"}`,
						false,
						vocab,
						"agent",
					);
				},
				// The failure twin of `onResolved`, on the same durable channel. Without
				// it a failed arm left NO record at all, so a reader could not tell an
				// inert session from one with the feature off — and an eval would score
				// the trial as a shorthand arm that the model ignored.
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

		// Record the top-level session's exact system prompt + active tools at start,
		// reusing the SAME `session_init` entry a subagent writes (ONE PLACE — see
		// task/executor.ts). This makes the main agent's run replayable/backtestable at
		// full fidelity: the exact prompt bytes AS SENT are in the record, not merely
		// reconstructable from config (GRAN-4). Written once on a NEW session only —
		// resumed sessions already carry their init entry, so we do not duplicate it.
		if (agentKind === "main" && !hasExistingSession) {
			sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
				task: "",
				tools: session.getActiveToolNames(),
			});
		}

		// Record the complete effective config that governs this run (every Tier-A
		// setting AS RESOLVED), for EVERY new session — main and subagent alike — so a
		// backtest can reproduce the exact configuration, not guess it from current
		// defaults (GRAN-3). Written once per new session; resumed sessions keep the
		// snapshot they were created with. The few settings that change interactively
		// (model, thinking, tier, mode, MCP selection) are tracked by their own entries.
		if (!hasExistingSession) {
			sessionManager.appendSettingsSnapshot(settings.getEffectiveSnapshot());
		}

		if (asyncJobManager) {
			const managedJobs = asyncJobManager;
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

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		agentRegistry.attachSession(resolvedAgentId, session, sessionManager.getSessionFile() ?? null);
		{
			const originalDispose = session.dispose.bind(session);
			let disposeCall: Promise<void> | undefined;
			session.dispose = options => {
				if (!disposeCall) {
					disposeCall = (async () => {
						try {
							// Reject new session work (eval starts) the moment disposal
							// begins — the lifecycle await below opens an async gap before
							// AgentSession.dispose() would otherwise set its guards.
							session.beginDispose();
							if (agentKind === "main") {
								// Top-level teardown owns the global agent lifecycle: park timers,
								// adopted subagent sessions, revivers. Tear it down while shared
								// resources (kernels, MCP, LSP) are still live. Subagent disposal
								// must NOT touch the global lifecycle.
								await AgentLifecycleManager.global().dispose();
							}
							await originalDispose(options);
						} finally {
							// The expansion log queues its appends so a tool call is never blocked by a
							// write, which means an exit that does not wait for the queue loses whichever
							// records were still in it, and loses them silently. Flushed here rather than
							// left to the event loop because quitting the TUI ends the process rather than
							// waiting for pending work: the last credential an agent used is exactly the
							// one an incident asks about.
							try {
								await secretAuditLog?.flush();
							} finally {
								// Stop routing machine faults into this session's notices. Left attached, the sink
								// keeps a disposed `OperatorNotices` reachable and posts later faults into a channel
								// nothing renders, and in a process that opens sessions in sequence the count grows
								// by one per session forever.
								detachFaultSink?.();
								detachSecretsNoticeSink?.();
								unregisterUnlessParked();
								unsubscribeCredentialDisabled?.();
							}
						}
					})();
				}
				return disposeCall;
			};
		}

		if (model?.api === "openai-codex-responses") {
			// `.api` equality doesn't narrow the generic; the guard makes this cast sound.
			const codexModel = model as Model<"openai-codex-responses">;
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
						const errorText = errorMessage(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorText,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Start LSP warmup in the background so startup does not block on language server initialization.
		// With `lsp.lazy` (the default) the warmup is skipped: recognized servers are still discovered and
		// surfaced in the UI as "available", but cold-start on first use — the lsp tool or an edit/write
		// touching a matching file type — through `getOrCreateClient`.
		// Print/script invocations (`hasUI=false`) skip it regardless: they don't render the warmup status
		// indicator AND typically finish before LSP servers would have stabilized — warming them just spends
		// CPU parsing big `initialize` responses concurrently with the LLM stream consumer, jittering
		// perceived latency.
		let lspServers: CreateAgentSessionResult["lspServers"];
		// Dynamic import: the lsp barrel pulls the full client/config machinery,
		// which must stay off the boot path when LSP is disabled or has no UI.
		const lazyLsp = enableLsp && options.hasUI ? await import("./lsp") : undefined;
		if (lazyLsp && settings.get("lsp.lazy")) {
			lspServers = lazyLsp.discoverStartupLspServers(cwd, "available");
		} else if (lazyLsp) {
			lspServers = lazyLsp.discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", lazyLsp.warmupLspServers, cwd);
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

		const startMemoryBackend = async () => {
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
		};

		// Auto-learn can immediately trigger a synthetic capture turn after the
		// first real stop. When a memory backend is selected, install that backend's
		// per-session state first so the capture turn's `learn` tool observes the
		// same initialized state as normal memory tools. Other sessions keep memory
		// startup in the background to preserve the existing startup profile.
		//
		// Gated on `autolearn.enabled` to match the tools: `createTools` builds the
		// `learn`/`manage_skill` registry ONCE at session start and no settings
		// change rebuilds it, so installing the controller while disabled would let a
		// mid-session enable fire a nudge pointing at tools the session never built.
		// Activation is therefore a session-start decision for BOTH the controller
		// and the tools; the fire-time re-check in `#onAgentEnd` still handles a
		// mid-session DISABLE. The subscription lives for the session's lifetime; the
		// reference is intentionally discarded (the listener retains it).
		if (settings.get("autolearn.enabled") && taskDepth === 0) {
			await logger.time("startMemoryStartupTask", startMemoryBackend);
			new AutoLearnController({ session, settings });
		} else {
			void logger.time("startMemoryStartupTask", startMemoryBackend);
		}

		// Wire MCP manager callbacks to session for reactive tool updates.
		// Skip when reusing a parent's manager — the parent owns the callbacks.
		if (mcpManager && !options.mcpManager) {
			const reactiveMcpManager = mcpManager;
			// MCP stdio servers are session-spawned processes: they join the
			// session's CPU budget group when one is configured.
			reactiveMcpManager.setSpawnAdoption(sessionCpuAdoption(() => session.sessionManager.getSessionId() ?? null));
			reactiveMcpManager.setOnToolsChanged(tools => {
				void (async () => {
					try {
						let activateAll = deferMCPDiscoveryForUI && !mcpDiscoveryEnabled;
						if (activateAll && (await enableDeferredMCPDiscoveryForTools(session, tools))) {
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
			// Wire prompt refresh → rebuild MCP prompt slash commands
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
			mcpManager.setOnResourcesChanged((serverName, uri) => {
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
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		startDeferredMCPDiscovery?.(session, {
			mcpDiscoveryEnabled,
			explicitlyRequestedMCPToolNames,
			activateAllMCPTools: !mcpDiscoveryEnabled,
		});

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership. Idempotent with dispose() — Set.delete is a no-op
		// for already-removed listeners.
		unsubscribeCredentialDisabled?.();
		// Same reason as the dispose path: the sink was attached near the top of this function, so a
		// throw anywhere after it would otherwise leave a sink pointing at notices for a session that
		// never started. Idempotent, so the `session.dispose()` below detaching again is harmless.
		detachFaultSink?.();
		detachSecretsNoticeSink?.();
		try {
			if (hasSession) {
				await session.dispose();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				if (evalKernelOwnerId) {
					await disposeKernelSessionsByOwner(evalKernelOwnerId);
					await disposeRubyKernelSessionsByOwner(evalKernelOwnerId);
					await disposeJuliaKernelSessionsByOwner(evalKernelOwnerId);
					await disposeVmContextsByOwner(evalKernelOwnerId);
				}
				if (mcpManager && mcpManager !== options.mcpManager) {
					await mcpManager.disconnectAll();
				}
				if (!options.sessionManager) await sessionManager?.close();
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: errorMessage(cleanupError),
			});
		}
		throw error;
	}
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect`
 * primes DNS + TCP + TLS + H2 so the first real request reuses the warm
 * connection. Errors are swallowed: preconnect is an optimization, never a
 * hard dependency.
 */
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
