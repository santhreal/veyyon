import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
} from "@veyyon/agent-core";
import type { Context, CredentialDisabledEvent, Message, Model, SimpleStreamOptions } from "@veyyon/ai";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import { createInterruptedTurnAbortMessage } from "@veyyon/kernel/session/exit-diagnostics";
import { OperatorNotices, stderrNoticeSink } from "@veyyon/kernel/session/operator-notices";
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { optionalNumber } from "@veyyon/kernel/settings/optional-number";
import { attachNativeNoticeSink } from "@veyyon/natives/loader-state";
import {
	attachFaultSink,
	errorMessage,
	getAgentDir,
	getGlobalConfigRootDir,
	getProjectDir,
	logger,
	postmortem,
	prefetch,
	Snowflake,
} from "@veyyon/utils";
import { type ArgotGate, shouldEncode } from "argot/policy";
import { renderPreamble } from "argot/preamble";
import {
	armArgotAfterStartup,
	collectArgotLoadedRoots,
	createArgotSession,
	rearmArgotForDecode,
	shouldAutoloadArgotAtStartup,
} from "./argot-cache";
import { buildArgotGate, expandToolArguments } from "./argot-wire";
import { AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { measureContextGauge } from "./config/compaction-strategy";
import { resolveDialect } from "./config/dialect-format";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { ModelRegistry } from "./config/model-registry";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings } from "./config/settings";
import { CursorExecHandlers } from "./cursor";
import { initializeWithSettings } from "./discovery";
import { setActiveRules } from "./discovery/capability/rule";
import { bucketRules } from "./discovery/capability/rule-buckets";
import { countToolsForAutoDiscovery, resolveEffectiveToolDiscoveryMode } from "./discovery/mode";
import {
	collectDiscoverableTools,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "./discovery/tool-index";
import { getExaMcpTools } from "./exa/tools";
import { TtsrManager } from "./export/ttsr";
import {
	type CustomCommandsLoadResult,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import { discoverCustomToolPaths, loadCustomTools, type ToolPathWithSource } from "./extensibility/custom-tools";
import type { CustomTool } from "./extensibility/custom-tools/types";
import {
	type ExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionTrustOptions,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { type Skill, setActiveSkills } from "./extensibility/skills";
import { LocalProtocolHandler } from "./internal-urls";
import { describeLegacyPromptFile, findLegacyPromptFiles } from "./legacy-system-prompt-files";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import { MCPManager } from "./mcp";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory/backend";
import { recordRestLaunchFacts } from "./modes/launch-facts";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, mainAgentIdFor } from "./registry/agent-registry";
import { resolveHarnessProfileForModel, resolvePromptSectionOrderForModel } from "./registry/model-profile";
import { attachSecretsNoticeSink } from "./secrets/notices";
import { SessionSecretRuntime } from "./secrets/session-runtime";
import { AgentSession } from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import { sessionCpuExecHooks } from "./session/cpu-limit";
import { convertToLlm, LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "./session/messages";
import { computeNonMessageBreakdown } from "./session/non-message-tokens";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { StartupModelSelection } from "./session/startup-model";
import { wrapSteeringForModel } from "./session/steering-envelope";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
} from "./system-prompt";
import { resolveGateInputs, resolveIntentField } from "./system-prompt-builder/gate-inputs";
import { renderSecretInventory } from "./system-prompt-builder/secret-inventory";
import { ARGOT_HANDLES_BANNER } from "./system-prompt-builder/section-registry";
import { delegationStrength } from "./task/agent-settings";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import { AUTO_THINKING, shouldDisableReasoning, toReasoningEffort } from "./thinking";
import {
	BUILTIN_TOOLS,
	computeEssentialBuiltinNames,
	createTools,
	type DeferredDiagnosticsEntry,
	HIDDEN_TOOLS,
	type Tool,
	type ToolSession,
} from "./tools";
import { createVibeModeTools } from "./tools/agent/manifest";
import { queueResolveHandler } from "./tools/agent/resolve";
import { normalizeToolNames, TOOL } from "./tools/core/builtin-names";
import { ToolContextStore } from "./tools/core/context";
import { resolveDiscoveryAllForceActive, resolveInitialActiveToolNames } from "./tools/core/loading";
import { wrapToolWithMetaNotice } from "./tools/core/output-meta";
import { createRepairToolCallArgumentsHook } from "./tools/core/repair/agent-hook";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "./tools/search/search-tool-bm25";
import { getImageGenTools, isImageProviderPreference, setPreferredImageProvider } from "./tools/web/image-gen";
import {
	getSearchTools,
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "./tools/web/search";
import { ttsTool } from "./tools/web/tts";
import { EventBus } from "./utils/event-bus";

// Types

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

// API Key Helpers

// System Prompt

// Internal Helpers

import type { AsyncResultEntry, SecretRuntimeLease } from "./session/agent-session-types";
import {
	discoverProjectInputs,
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	discoverSlashCommands,
	projectAdvisorScope,
	reportExtensionLoadFailures,
	workspaceTreeWithinDeadline,
} from "./session/factory-extensions";
import {
	clipMCPServerInstructions,
	collectPendingMCPToolNames,
	createPendingMCPTool,
	type StartDeferredMCPDiscovery,
	startSessionMCP,
	wireReactiveMCPManager,
} from "./session/factory-mcp";
import {
	buildAsyncResultBatchMessage,
	buildLateDiagnosticsBatchMessage,
	buildMcpNotificationBatchMessage,
	type McpNotificationEntry,
} from "./session/factory-notices";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	isInProcessChildSession,
	isSubagentSession,
} from "./session/factory-options";
import {
	createCustomToolsExtension,
	customToolToDefinition,
	isCustomTool,
	isLegacyBuiltinToolDefinition,
} from "./session/factory-tools";
import {
	applySystemPromptOverride,
	composeAppendPrompt,
	ProjectPromptInputs,
	promptDiscoverableTools,
} from "./session/prompt-inputs";
import { buildAdvisorTools, createSessionToolSession } from "./session/tool-session";

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

// Factory

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
 *   getApiKey: async () => process.env.MY_KEY,
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
		// Start every project-input discovery now and await each at its consumer, so the scans
		// overlap model resolution, secret loading, session-context build, tool creation, MCP
		// discovery and extension discovery. Spawned agents inherit the parent's resolved values
		// via options. A caller that filtered its context files down to nothing turns discovery off.
		if (options.contextFiles?.length === 0) {
			logger.warn("Context file discovery disabled: caller supplied an empty resolved list", { cwd, agentDir });
		}
		const projectInputs = discoverProjectInputs(cwd, agentDir, settings, options);
		// Presence, not truthiness, for the same reason as `discoverProjectInputs`: `undefined`
		// means discover, `[]` means resolved to nothing on purpose.
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
		// `logger.warn`, which is file-only: a agents directory that exists and cannot be listed
		// reported "no agents" to the operator and the reason to a file nobody opens. Attached here
		// rather than in each mode because every mode wants it and forgetting it is silent.
		//
		// Detached on dispose, and on the startup-failure path below, by the handle this returns. The
		// sink closes over `operatorNotices`, so leaving it attached outlives the session it reports to.
		//
		// The native loader reports the same way and for the same reason: it runs before any session
		// exists and inside the interactive UI, so a raw terminal write lands between frames and moves
		// the composer. Its notices wait in the loader until this sink attaches, and share its detach.
		const detachMachineFaults = attachFaultSink(fault => operatorNotices.warn(fault.source, fault.text));
		const detachNativeNotices = attachNativeNoticeSink(text => operatorNotices.warn("natives", text));
		detachFaultSink = () => {
			detachMachineFaults();
			detachNativeNotices();
		};

		// Startup is the only load that may start without a vault; every later reload throws,
		// because its caller is about to expand a live placeholder.
		const secretRuntime = await SessionSecretRuntime.load(
			{ settings, globalConfigRoot, agentDir, operatorNotices, getCwd: () => sessionManager.getCwd() },
			cwd,
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
		// A spawned agent (task-spawned child) follows the `argot.agents` policy instead
		// of always starting empty: `off` gets no codec, `fresh` gets its own empty
		// session and loads its task's project itself, `inherit` forks the parent's
		// codec. Correctness never rests on this (the boundary rule expands every
		// emitted seam); the policy trades tokens.
		const sessionIsSpawned = isSubagentSession(options);
		const argot = createArgotSession({
			enabled: argotEnabled,
			isSpawned: sessionIsSpawned,
			agentMode: settings.get("argot.agents"),
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

		// The first model pass: the session's last model, else the settings default. Extension
		// providers register below, and `completeAfterExtensions` runs the second pass.
		const modelSelection = await StartupModelSelection.begin({
			options,
			settings,
			modelRegistry,
			sessionManager,
			existingSession,
			hasExistingSession,
			hasThinkingEntry,
		});
		let model = modelSelection.model;
		const hasExplicitModel = modelSelection.hasExplicitModel;
		const taskDepth = options.taskDepth ?? 0;

		const discovered = await projectInputs.skills;
		const skills: Skill[] = discovered.skills;
		// Straight into the operator channel. These used to be collected into
		// `AgentSession.skillWarnings`, a getter no production code read, so a skill that failed to
		// load was discarded in silence and the channel looked live from the outside.
		for (const warning of discovered.warnings) {
			operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
		}

		// `getCwd` is a live getter, not `cwd`: a rule with a `pathScope` compares the match
		// against the CURRENT working directory, and `set_cwd` moves it mid-session.
		const ttsrSettings = settings.getGroup("ttsr");
		const ttsrManager = new TtsrManager(ttsrSettings, { getCwd: () => sessionManager.getCwd() });
		const allRules = await projectInputs.rules;
		const { rulebookRules, alwaysApplyRules } = bucketRules(allRules, ttsrManager, ttsrSettings);
		if (existingSession.injectedTtsrRules.length > 0) {
			ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
		}

		// Context files are needed before tool creation. The workspace tree scan is slow on large
		// repos and startup must not block on it: past its deadline ToolSession gets `undefined`,
		// and the system prompt races the same promise again while the scan warms its caches.
		const [contextFiles, resolvedWorkspaceTree, activeRepoContext, watchdogFiles, discoveredAdvisors] =
			await Promise.all([
				projectInputs.contextFiles,
				workspaceTreeWithinDeadline(projectInputs),
				projectInputs.activeRepoContext,
				projectInputs.watchdogFiles,
				projectInputs.advisors,
			]);

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
		// Spawned agents inherit the parent's manager via `AsyncJobManager.instance()`
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

							session.deliverAsyncJobResult(jobId, formattedResult, job);
						},
					})
				: undefined;

		const scopedAsyncJobManager =
			asyncJobManager ?? (isInProcessChildSession(options) ? AsyncJobManager.instance() : undefined);

		const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
		// A driving agent is named for the conversation it starts, so two live
		// top-level sessions in one process cannot collide on one key. Falls back
		// to the bare alias only when there is no conversation id to name yet,
		// which is the pre-existing behavior and cannot produce a second main.
		const conversationId = sessionManager.getSessionId?.();
		const resolvedAgentId =
			options.agentId ??
			options.parentTaskPrefix ??
			(!sessionIsSpawned && conversationId ? mainAgentIdFor(conversationId) : MAIN_AGENT_ID);
		const resolvedAgentDisplayName = options.agentDisplayName ?? (sessionIsSpawned ? "sub" : "main");
		const agentKind = sessionIsSpawned ? ("sub" as const) : ("main" as const);
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
		const {
			toolSession,
			advisorToolSession,
			setActiveToolNames,
			setNotifier: setToolNotifier,
			activeModelString: getActiveModelString,
		} = createSessionToolSession({
			options,
			sessionManager,
			session: () => session,
			agent: () => agent,
			startupModel: () => model,
			hasExplicitModel,
			obfuscateProviderText: text => secretRuntime.obfuscateText(text),
			isSpawned: sessionIsSpawned,
			agentId: resolvedAgentId,
			evalKernelOwnerId,
			fields: {
				enableLsp,
				contextFiles,
				workspaceTree: resolvedWorkspaceTree,
				skills,
				rules: allRules,
				eventBus,
				agentRegistry,
				settings,
				authStorage,
				modelRegistry,
				// Spawned agents inherit the singleton (the parent's manager) so their bash/task
				// completions still flow into the spawning conversation's yieldQueue.
				// Secondary in-process top-level sessions (no parentTaskPrefix, no
				// constructed manager because the singleton was already installed) leave
				// this undefined so tools and session job snapshots refuse async work
				// instead of silently routing into the owning session (issue #1923).
				asyncJobManager: scopedAsyncJobManager,
			},
		});

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; spawned agents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for spawned agents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!isInProcessChildSession(options)) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules(rulebookRules.concat(alwaysApplyRules, ttsrManager.getRules()));
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
		const enableMCP = options.enableMCP ?? true;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		const customTools: CustomTool[] = [];
		let startDeferredMCPDiscovery: StartDeferredMCPDiscovery | undefined;
		if (enableMCP && !mcpManager) {
			const mcp = await startSessionMCP({
				cwd,
				agentDir,
				settings,
				authStorage,
				eventBus,
				hasUI: options.hasUI === true,
				deferred: deferMCPDiscoveryForUI,
			});
			mcpManager = mcp.manager;
			customTools.push(...mcp.tools);
			startDeferredMCPDiscovery = mcp.startDeferred;
		}
		toolSession.mcpManager = mcpManager;
		// Only top-level sessions own the global MCPManager. Spawned agents already
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
		// Spawned agents reuse the parent's scan via `preloadedCustomToolPaths` to skip
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
		// The same channel `reportExtensionLoadFailures` uses: a tool with a syntax error, a
		// bad default export, or a name another tool already took was dropped with a line in
		// the file log and nothing on the surface, so the tool was absent with no explanation.
		for (const { path, error } of customToolsLoadResult.errors) {
			logger.error("Custom tool load failed", { path, error });
			operatorNotices.error("tools", `${path}: ${error}`);
		}
		if (customToolsLoadResult.tools.length > 0) {
			customTools.push(...customToolsLoadResult.tools.map(loaded => loaded.tool));
		}
		// Forward the path list (NOT the loaded tools) to spawned agents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = customToolPaths;

		const inlineExtensions: ExtensionFactory[] = options.extensions ? options.extensions.slice() : [];
		inlineExtensions.push((await import("./autoresearch")).createAutoresearchExtension);
		if (customTools.length > 0) {
			inlineExtensions.push(createCustomToolsExtension(customTools, text => secretRuntime.obfuscateText(text)));
		}

		// Load extensions. Three paths:
		//   1. `preloadedExtensions` (CLI): caller already loaded — reuse the
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   2. `preloadedExtensionPaths` (spawned agent): caller resolved paths;
		//      skip the FS scan but always re-call `loadExtensions` here so
		//      each `Extension` binds to THIS session's `ExtensionAPI`
		//      (cwd, eventBus, runtime).
		//   3. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		// The trust gate reads the SESSION's profile, and the paths the operator named are the
		// operator's own even when they live inside the project. Both `loadExtensions` calls
		// below used to pass neither: a `--extension ./dev/tool.ts` was withheld as repository
		// code, and the decision was looked up in whichever profile the process booted with
		// rather than the one this session runs under.
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
		// Forward the source-path list (NOT the loaded instances) so spawned agents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;
		toolSession.namedExtensionPaths = namedExtensionPaths;

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
					gateSpawn,
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

		// Every provider is registered now: reclaim the session's model, resolve deferred
		// `--model` patterns, fall back to the first authenticated model, and refresh the
		// chosen model's metadata.
		await modelSelection.completeAfterExtensions();
		model = modelSelection.model;

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
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, {
					cwd,
					agentDir,
					adoptSpawnedPid,
					gateSpawn,
				});
		if (!options.disableExtensionDiscovery) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
				operatorNotices.error("commands", `${path}: ${error}`);
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
			obfuscateProviderText: (text: string) => secretRuntime.obfuscateText(text),
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
					? customToolToDefinition(tool, text => secretRuntime.obfuscateText(text))
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
		// Dropping it on read-only sessions (e.g. plan-mode toolset `read`, `search`,
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

		const reloadSshTool = async (): Promise<AgentTool | null> => {
			if (!requestedToolNameSet.has(TOOL.ssh)) return null;
			const { loadSshTool } = await import("./tools/shell/ssh");
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
		const promptInputs = new ProjectPromptInputs({
			initial: {
				cwd,
				contextFiles,
				workspaceTree: projectInputs.workspaceTree,
				activeRepoContext,
				skills,
				rulebookRules,
				alwaysApplyRules,
			},
			getCwd: () => sessionManager.getCwd(),
			discover: liveCwd => discoverProjectInputs(liveCwd, agentDir, settings, options),
			ttsrManager,
			ttsrOptions: () => settings.getGroup("ttsr"),
			onChange: next => {
				toolSession.contextFiles = next.contextFiles;
				toolSession.workspaceTree = next.workspaceTree;
				toolSession.skills = next.skills;
				toolSession.rules = next.rules;
				if (hasSession) {
					session.replaceSkills(next.skills);
					session.replaceProjectAdvisorScope(projectAdvisorScope(next));
				}
				for (const warning of next.skillWarnings) {
					operatorNotices.warn("skills", `${warning.skillPath}: ${warning.message}`);
				}
				ttsrManager.reportUnknownToolScopes(toolRegistry.keys());
				if (!isInProcessChildSession(options)) {
					setActiveSkills(next.skills);
					setActiveRules([
						...next.buckets.rulebookRules,
						...next.buckets.alwaysApplyRules,
						...ttsrManager.getRules(),
					]);
				}
			},
		});
		const rebuildSystemPrompt = async (
			toolNames: string[],
			tools: Map<string, AgentTool>,
		): Promise<BuildSystemPromptResult> => {
			await promptInputs.refresh();
			toolContextStore.setToolNames(toolNames);
			const discoverable = promptDiscoverableTools({
				tools,
				activeToolNames: toolNames,
				mcpDiscoveryEnabled,
				discoveryMode: effectiveDiscoveryMode,
				builtInToolNames: builtInRegistryToolNames,
			});
			const promptTools = buildSystemPromptToolMetadata(tools, {
				search_tool_bm25: { description: renderSearchToolBm25Description(discoverable.tools) },
			});
			// Ask the live task tool which agents this session may spawn, rather than
			// re-running discovery here: it already filtered its discovered set
			// through `agent.agents`, and the prompt must describe exactly the
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
			// For UI sessions MCP discovery is deferred, so `getServerInstructions()` is
			// empty until the background connect completes; the rebuild that
			// `refreshMCPTools` triggers post-discovery then picks up the now-connected
			// servers' instructions, so they join the prompt for the rest of the session.
			const appendPrompt = composeAppendPrompt({
				memoryInstructions: await memoryBackend.buildDeveloperInstructions(agentDir, settings, session),
				// Drive guidance off the auto-learn BUILTINS that createTools actually built
				// (provenance, not just an active name): `builtInToolNames` excludes a
				// custom/extension tool that merely shares the name, and reflects the
				// session-start build — so a spawned agent that filtered them out, a mid-session
				// enable that never built them, or a same-named custom tool while auto-learn
				// is off all get no guidance.
				autoLearnInstructions: buildAutoLearnInstructions({
					manageSkill: builtInToolNames.includes(TOOL.manage_skill),
					learn: builtInToolNames.includes(TOOL.learn),
				}),
				serverInstructions: mcpManager?.getServerInstructions(),
				appendSystemPrompt: options.appendSystemPrompt,
			});
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
			const project = promptInputs.current;
			const defaultPrompt = await buildSystemPromptInternal({
				...gateInputs,
				// The tree is scanned when the project is discovered, so this flag hides a
				// scanned tree but cannot scan one; `gate-registry.ts` records that placement.
				// Descriptor placement stays live in `gateInputs`: the same active-model policy
				// also drives provider-schema pruning below, so a model switch cannot retain
				// the previous model family's more expensive representation.
				includeWorkspaceTree: settings.get("includeWorkspaceTree") ?? false,
				// A spawned agent gets no personality regardless of the setting. That is a fact about
				// this caller, not about the configuration, so it does not belong in the resolver.
				personality: agentKind === "sub" ? "none" : gateInputs.personality,
				cwd: project.cwd,
				agentDir,
				resolvedCustomPrompt: options.customSystemPrompt,
				skills: project.skills,
				// Every api inlines the operator's layers here, cursor-agent included. That api's
				// server discards the client's system-prompt blobs and applies none of the
				// request-context rules, so the provider carries the assembled prompt on the
				// active user turn — the one thing it delivers verbatim. Either way the prompt
				// IS the instruction payload, and one composer builds it for every api.
				contextFiles: project.contextFiles,
				tools: promptTools,
				toolNames,
				rules: project.rulebookRules,
				alwaysApplyRules: project.alwaysApplyRules,
				resolvedAppendSystemPrompt: appendPrompt,
				skillsSettings: settings.getGroup("skills"),
				mcpDiscoveryMode: discoverable.searchable,
				mcpDiscoveryServerSummaries: discoverable.serverSummaries,
				secretsEnabled: secretRuntime.obfuscator?.hasSecrets() === true,
				// Read LATE, inside the build, never snapshotted when the runtime was
				// constructed. `namedSecretNames()` expires stale entries while answering, so
				// asking it here is what drops a credential that lapsed mid-session out of the
				// prompt, and reading the runtime's live obfuscator is what drops one that
				// `/secret rm` revoked. Undefined (protection off, or an empty vault) emits no
				// section at all.
				secretInventory: renderSecretInventory(secretRuntime.obfuscator?.namedSecretNames()),
				argotPreamble: argotCanEncode ? renderPreamble({ tools: true }) : undefined,
				argotHandles: argotCanEncode && argot.loaded ? argot.promptFragment() : undefined,
				workspaceTree: project.workspaceTree,
				memoryRootEnabled: memoryBackend.id === "local",
				model: getActiveModelString(),
				activeRepoContext: project.activeRepoContext,
				sectionOrder: resolvePromptSectionOrderForModel(settings, agent?.state.model ?? model),
			});
			return applySystemPromptOverride(defaultPrompt, options.systemPrompt);
		};

		const toolNamesFromRegistry = Array.from(toolRegistry.keys());
		const explicitlyRequestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;
		// When `requireYieldTool` is set, the spawned agent's prompts and idle-reminders demand a
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
		// ensuring `goal`, dropping `defaultInactive`, merging the MCP selection, appending
		// `alwaysInclude`, hiding discoverables under `all`, and applying the harness allowlist —
		// live in `resolveInitialActiveToolNames` (`tools/loading/policy.ts`).
		// `explicitToolNames` is the RAW `options.toolNames`, NOT
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
			goalEnabled: settings.get("goal.enabled"),
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
			// The conversation this agent belongs to. A spawned agent inherits its
			// parent's, so only a root session states one: its session id, which
			// exists before the transcript has ever been written and survives a
			// `/move` that rewrites the path.
			scope: options.parentAgentId ? undefined : (sessionManager.getSessionId?.() ?? undefined),
			status: "running",
			model: getActiveModelString(),
		});
		hasRegistered = true;

		setActiveToolNames(initialToolNames);
		// Let pending input and rendering run between tool construction and prompt assembly.
		await yieldToEventLoop();
		const { systemPrompt } = await logger.time(
			"buildSystemPrompt",
			rebuildSystemPrompt,
			initialToolNames,
			toolRegistry,
		);
		await yieldToEventLoop();

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
		let activeMainRequestRuntime = secretRuntime.lease;

		// Acquire before the first async extension hook. The returned arrays and
		// context retain this exact authority through provider serialization.
		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const runtime = await secretRuntime.acquire();
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
		// each LLM HTTP request — not the whole spawned agent lifecycle — holds the
		// slot, preventing the nested-spawn deadlock from issue #3749.
		const settingsAwareStreamFn = wrapStreamFnWithProviderConcurrency(
			settings,
			createSettingsAwareStreamFn(settings),
		);
		const callerTelemetryTextSanitizer = options.telemetry?.textSanitizer;
		const telemetry: AgentTelemetryConfig = {
			...(options.telemetry ?? {}),
			textSanitizer: text =>
				secretRuntime.obfuscateText(callerTelemetryTextSanitizer ? callerTelemetryTextSanitizer(text) : text),
		};
		// One warning per model when auto tool-format reroutes a non-tool-calling
		// model onto an in-band text dialect — the operator must see the degrade.
		const notifiedDialectFallbackModels = new Set<string>();
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(modelSelection.effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(modelSelection.effectiveThinkingLevel),
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
				// `execution` is `display` itself unless a secret expanded.
				let execution = secretRuntime.deobfuscateForExecution(
					activeMainRequestRuntime,
					display,
					toolName,
					agent.sessionId,
				);
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
			if (!modelSelection.autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				sessionManager.appendThinkingLevelChange(modelSelection.effectiveThinkingLevel);
			}
			if (Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(initialServiceTierByFamily);
			}
		}

		const advisorTools = await buildAdvisorTools(advisorToolSession);

		// Owned only when this session created the manager; spawned agents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		session = new AgentSession({
			// The advisor gets the same project context files (AGENTS.md, etc.) the primary agent
			// gets in its system prompt, so the read-only reviewer judges against them.
			...projectAdvisorScope({ watchdogFiles, activeRepoContext, contextFiles, advisors: discoveredAdvisors }),
			agent,
			pruneToolDescriptions: inlineToolDescriptorsForModel,
			thinkingLevel: modelSelection.autoThinking ? AUTO_THINKING : modelSelection.effectiveThinkingLevel,
			thinkingSource: modelSelection.thinkingSource,
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
			// AsyncJobManager on teardown; spawned agents inherit the parent's and
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
			createVibeTools: sessionIsSpawned ? undefined : () => createVibeModeTools(toolSession),
			// A spawned agent shares this process with its parent and its siblings, so its
			// re-root may not move the process working directory or any other
			// process-global project state. See `AgentSession.rescopeToCwd`.
			isSpawned: sessionIsSpawned,
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
				? () => clipMCPServerInstructions(mcpManager!.getServerInstructions())
				: undefined,
			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			mcpDiscoveryEnabled,
			initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !hasExistingSession,
			defaultSelectedMCPServerNames: Array.from(discoveryDefaultServers),
			ttsrManager,
			obfuscator: secretRuntime.obfuscator,
			secretRuntime: secretRuntime.lease,
			leaseSecretRuntime: () => secretRuntime.acquire(),
			resolveSecretRuntimeLeaseForContext: resolveSecretRuntimeForContext,
			refreshSecretRuntime: runtimeCwd => secretRuntime.refresh(runtimeCwd),
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
		secretRuntime.attachSession(session);
		// Record the at-rest launch facts the moment they exist, not when the
		// status row first renders. The launch card reads the file on every
		// render and repaints when a record lands, so on a cold launch — no
		// recording from a previous session — the hero's model name and provider
		// and the context gauge arrive with the session rather than with the
		// mounted row, and the next launch states them from the first frame.
		// The row re-records the same decision on its own renders against the
		// same gauge; a record that changes nothing does not write.
		const atRestUsage = session.getContextUsage();
		const atRest = measureContextGauge(
			atRestUsage?.tokens ?? null,
			atRestUsage?.contextWindow ?? session.model?.contextWindow ?? 0,
			session.autoCompactionEnabled ? settings.getGroup("compaction") : undefined,
		);
		void recordRestLaunchFacts(
			{
				model: session.state.model,
				thinkingLevel: session.state.thinkingLevel ?? null,
				isAutoThinking: session.isAutoThinking,
				messageCount: session.messages?.length ?? 0,
				systemContextTokens: computeNonMessageBreakdown(session).systemContextTokens,
			},
			atRest.contextPercent,
			atRest.contextLimit,
		);

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
		// reusing the SAME `session_init` entry a spawned agent writes (ONE PLACE — see
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
		// setting AS RESOLVED), for EVERY new session — main and spawned agent alike — so a
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
		// Keep the driving session's own ref alive in the roster. Only spawned agents
		// were ever wired to the registry (`task/executor.ts` on agent_start /
		// agent_end, `persisted-revive.ts` for a revived one), so the main agent's
		// row was whatever registration wrote and nothing after it: the Agent
		// Control Center aged it from process start and printed "1d ago" against a
		// session that was mid-turn. The status is deliberately left alone — the
		// bus routes an incoming message by it, and flipping the operator's own
		// session to idle between turns would change how a peer reaches them.
		session.subscribe(event => {
			if (event.type === "agent_start" || event.type === "agent_end") {
				agentRegistry.noteTurn(resolvedAgentId);
			}
		});
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
								// adopted spawned agent sessions, revivers. Tear it down while shared
								// resources (kernels, MCP, LSP) are still live. Spawned agent disposal
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
								await secretRuntime.flushAuditLog();
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
		const startupQuiet = settings.get("startup.quiet");
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

		// The memory backend's start is HYDRATION, not boot: it opens a database and installs this
		// session's state, and no frame reads either. It used to be awaited here for an auto-learn
		// session, which put both in front of the first frame so that a tool call minutes later would
		// find the state already installed. `deferStartupWork` keeps that guarantee at the only place
		// that needs it — a turn awaits it before running, and every tool call and spawned agent spawn is
		// inside a turn — while the frame paints without it. A session with auto-learn off already ran
		// this unawaited.
		//
		// The controller is installed only when `autolearn.enabled` and only for a top-level session,
		// to match the tools: `createTools` builds the `learn`/`manage_skill` registry ONCE at session
		// start and no settings change rebuilds it, so installing the controller while disabled would
		// let a mid-session enable fire a nudge pointing at tools the session never built. Activation
		// is a session-start decision for BOTH; the fire-time re-check in `#onAgentEnd` still handles a
		// mid-session DISABLE. The subscription lives for the session's lifetime; the reference is
		// intentionally discarded (the listener retains it).
		await yieldToEventLoop();
		session.deferStartupWork(
			logger.time("startMemoryStartupTask", startMemoryBackend).catch(error => {
				logger.warn("memory backend startup failed", { error: errorMessage(error) });
			}),
		);
		if (settings.get("autolearn.enabled") && taskDepth === 0) {
			new AutoLearnController({ session, settings });
		}

		// Wire MCP manager callbacks to session for reactive tool updates.
		// Skip when reusing a parent's manager — the parent owns the callbacks.
		if (mcpManager && !options.mcpManager) {
			wireReactiveMCPManager({
				manager: mcpManager,
				session,
				settings,
				refreshTools: async tools => {
					let activateAll = deferMCPDiscoveryForUI && !mcpDiscoveryEnabled;
					if (activateAll && (await enableDeferredMCPDiscoveryForTools(session, tools))) {
						activateAll = false;
					}
					await session.refreshMCPTools(tools, activateAll ? { activateAll: true } : undefined);
				},
			});
		}

		startDeferredMCPDiscovery?.(
			session,
			{
				mcpDiscoveryEnabled,
				explicitlyRequestedMCPToolNames,
				activateAllMCPTools: !mcpDiscoveryEnabled,
			},
			enableDeferredMCPDiscoveryForTools,
		);

		return {
			session,
			extensionsResult,
			setToolUIContext,
			setToolNotifier,
			mcpManager,
			modelFallbackMessage: modelSelection.fallbackMessage,
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
					await disposeOwnedResources("eval-kernel-owner", evalKernelOwnerId);
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
