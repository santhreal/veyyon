import * as path from "node:path";
import {
	Agent,
	type AgentEvent,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	type ThinkingLevel,
} from "@veyyon/agent-core";
import type { Context, Model } from "@veyyon/ai";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import { errorMessage, logger, postmortem, setProjectDir } from "@veyyon/utils";
import { type ArgotGate, type ArgotSession, renderPreamble, shouldEncode } from "argot";
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
import { buildArgotGate } from "./argot-wire";
import { AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { createAutoresearchExtension } from "./autoresearch";
import { type Rule, setActiveRules } from "./capability/rule";
import { bucketRules, type RuleBuckets } from "./capability/rule-buckets";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { isAuthenticated, kNoAuth } from "./config/auth-state";
import { resolveDialect } from "./config/dialect-format";
import { type EffortSource, resolveEffort, withLegacyDefaultEffort } from "./config/effort-resolver";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import type { ModelRegistry } from "./config/model-registry";
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
import type { PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import type { Settings } from "./config/settings";
import { CursorExecHandlers, cursorContextFileRules, usesCursorRuleDelivery } from "./cursor";
import { disposeJuliaKernelSessionsByOwner } from "./eval/jl/executor";
import { disposeVmContextsByOwner } from "./eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "./eval/py/executor";
import { disposeRubyKernelSessionsByOwner } from "./eval/rb/executor";
import { defaultEvalSessionId } from "./eval/session-id";
import { getExaMcpTools } from "./exa/tools";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool, CustomToolContext } from "./extensibility/custom-tools/types";
import {
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionTrustOptions,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	type ToolDefinition,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import type { RegisteredTool } from "./extensibility/extensions/types";
import { type SkillWarning, setActiveSkills } from "./extensibility/skills";
import type { FileSlashCommand } from "./extensibility/slash-commands";
import { resolveHarnessProfileForModel, resolvePromptSectionOrderForModel } from "./harness/model-profile";
import { LocalProtocolHandler } from "./internal-urls";
import { discoverStartupLspServers, warmupLspServers } from "./lsp";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import { discoverAndLoadMCPTools, MCPManager, MCPToolCache } from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import { DEFAULT_PLAN_FILE_URL } from "./plan-mode/plan-file-url";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, mainAgentIdFor } from "./registry/agent-registry";
import { createRepairToolCallArgumentsHook } from "./repair/agent-hook";
import { SecretRuntimeController } from "./sdk";
import {
	applyMCPEnvironment,
	buildAsyncResultBatchMessage,
	buildLateDiagnosticsBatchMessage,
	buildMCPPromptCommands,
	buildMcpNotificationBatchMessage,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	collectPendingMCPToolNames,
	createCustomToolsExtension,
	createPendingMCPTool,
	customToolToDefinition,
	type DeferredMCPActivation,
	discoverContextFiles,
	discoverRules,
	discoverSessionEnvironment,
	discoverSessionExtensionPaths,
	discoverSkills,
	isCustomTool,
	isInProcessChildSession,
	isLegacyBuiltinToolDefinition,
	isSubagentSession,
	logMCPLoadErrors,
	MAX_MCP_INSTRUCTIONS_LENGTH,
	type McpNotificationEntry,
	preconnectModelHost,
	reportExtensionLoadFailures,
	type SessionEnvironment,
	type SessionInfrastructure,
	STARTUP_SCAN_DEADLINE_MS,
	secretProtectionUnavailableMessage,
	setupSessionInfrastructure,
} from "./sdk-helpers";
import { collectEnvSecrets, describeSecretRejection, loadSecrets, type SecretEntry, SecretObfuscator } from "./secrets";
import { SecretAuditLog, secretAuditPath } from "./secrets/audit";
import { buildEnvSecretPattern, loadEnvSecretKeywords } from "./secrets/env-keywords";
import { describeSecretExpiry } from "./secrets/obfuscator";
import { expiryWarnings } from "./secrets/secret-command";
import { resolveVaultLocations, type ScopedVaultEntry, SecretVault } from "./secrets/vault";
import { loadOrCreateVaultKey } from "./secrets/vault-crypto";
import { AgentSession, type AsyncResultEntry, type SecretRuntimeLease } from "./session/agent-session";
import type { AuthStorage } from "./session/auth-storage";
import { sessionCpuExecHooks } from "./session/cpu-limit";
import { abortDetached } from "./session/detached-abort";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "./session/messages";
import type { OperatorNotices } from "./session/operator-notices";
import type { SessionContext } from "./session/session-context";
import { getRestorableSessionModels } from "./session/session-context";
import type { SessionEntry } from "./session/session-entries";
import type { SessionManager } from "./session/session-manager";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
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
	computeEssentialBuiltinNames,
	createTools,
	type DeferredDiagnosticsEntry,
	HIDDEN_TOOLS,
	type Tool,
	type ToolSession,
} from "./tools";
import { normalizeToolNames, TOOL } from "./tools/builtin-names";
import { ToolContextStore } from "./tools/context";
import { getImageGenTools } from "./tools/image-gen";
import { resolveDiscoveryAllForceActive, resolveInitialActiveToolNames } from "./tools/loading";
import { wrapToolWithMetaNotice } from "./tools/output-meta";
import { queueResolveHandler } from "./tools/resolve";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "./tools/search-tool-bm25";
import { loadSshTool } from "./tools/ssh";
import { ttsTool } from "./tools/tts";
import { createVibeTools } from "./tools/vibe";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { buildNamedToolChoice } from "./utils/tool-choice";
import { getSearchTools } from "./web/search";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";
export async function setupSecretRuntime(params: {
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

export interface SessionModelAndThinking {
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

export async function resolveSessionModelAndThinking(params: {
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

export interface SessionToolsAndExtensions {
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

export async function setupSessionToolsAndExtensions(params: {
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

export interface SessionPromptAndToolSelection {
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

export async function setupSystemPromptAndToolSelection(params: {
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

export async function initializeAgentAndSession(params: {
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

export async function cleanupFailedSessionStartup(params: {
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
