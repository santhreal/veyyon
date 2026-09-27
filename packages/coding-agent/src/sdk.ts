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
import { collectArgotLoadedRoots, createArgotSession, rearmArgotForDecode } from "./argot-cache";
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
import { TtsrManager } from "./export/ttsr";
import type { CustomTool } from "./extensibility/custom-tools/types";
import {
	type BuiltinExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { type Skill, setActiveSkills } from "./extensibility/skills";
import { LocalProtocolHandler } from "./internal-urls";
import { describeLegacyPromptFile, findLegacyPromptFiles } from "./legacy-system-prompt-files";
import { MCPManager } from "./mcp";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory/backend";
import { recordRestLaunchFacts } from "./modes/launch-facts";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, mainAgentIdFor } from "./registry/agent-registry";
import { resolveHarnessProfileForModel, resolvePromptSectionOrderForModel } from "./registry/model-profile";
import { attachSecretsNoticeSink } from "./secrets/notices";
import { SecretRequestLeases } from "./secrets/request-leases";
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
import { normalizeToolNames, TOOL } from "./tools/core/builtin-names";
import { ToolContextStore } from "./tools/core/context";
import {
	resolveDiscoveryAllForceActive,
	resolveInitialActiveToolNames,
	resolveRequestedToolNames,
} from "./tools/core/loading";
import { wrapToolWithMetaNotice } from "./tools/core/output-meta";
import { createRepairToolCallArgumentsHook } from "./tools/core/repair/agent-hook";
import { renderSearchToolBm25Description, SearchToolBm25Tool } from "./tools/search/search-tool-bm25";
import { isImageProviderPreference, setPreferredImageProvider } from "./tools/web/image-gen";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "./tools/web/search";
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
import { createOwnedAsyncJobManager } from "./session/async-jobs";
import {
	discoverProjectInputs,
	discoverPromptTemplates,
	discoverSlashCommands,
	projectAdvisorScope,
	workspaceTreeWithinDeadline,
} from "./session/factory-extensions";
import {
	clipMCPServerInstructions,
	collectPendingMCPToolNames,
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
	assembleToolRegistry,
	createCustomToolsExtension,
	customToolToDefinition,
	isCustomTool,
	isLegacyBuiltinToolDefinition,
	loadSessionCustomTools,
} from "./session/factory-tools";
import {
	applySystemPromptOverride,
	composeAppendPrompt,
	ProjectPromptInputs,
	promptDiscoverableTools,
} from "./session/prompt-inputs";
import { prewarmCodexTransport, startLspServers } from "./session/startup-background";
import {
	adoptStartupExtensionProviders,
	loadStartupCustomCommands,
	loadStartupExtensions,
} from "./session/startup-extensions";
import { armLaunchArgot, recordNewSessionStart } from "./session/startup-records";
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
		asyncJobManager = createOwnedAsyncJobManager({ options, settings, sessionManager, target: () => session });

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

		const builtInToolNames = builtinTools.map(t => t.name);
		// Session CPU budget: every process a custom tool, custom command, or
		// extension spawns through `exec` joins this session's budget group. The
		// closure resolves the limiter lazily, so registration order (limiter
		// created in the AgentSession constructor, tools loaded before it) is
		// irrelevant.
		const cpuExec = sessionCpuExecHooks(() => toolSession.getSessionId?.() ?? null);
		const sessionCustomTools = await loadSessionCustomTools({
			options,
			settings,
			modelRegistry,
			model,
			cwd,
			agentDir,
			builtInToolNames,
			toolSession,
			cpuExec,
			operatorNotices,
		});
		customTools.push(...sessionCustomTools.tools);
		// Forward the path list (NOT the loaded tools) to spawned agents so they
		// re-bind under their own `CustomToolAPI` while skipping the FS scan.
		toolSession.customToolPaths = sessionCustomTools.paths;

		const builtins: BuiltinExtensionFactory[] = [(await import("./autoresearch")).createAutoresearchExtension];
		if (customTools.length > 0) {
			builtins.push(createCustomToolsExtension(customTools, text => secretRuntime.obfuscateText(text)));
		}

		const extensions = await loadStartupExtensions(
			{ options, cwd, agentDir, settings, eventBus, cpuExec, operatorNotices },
			builtins,
		);
		const extensionsResult = extensions.result;
		// Forward the source-path list (NOT the loaded instances) so spawned agents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensions.paths;
		toolSession.namedExtensionPaths = extensions.namedPaths;

		await adoptStartupExtensionProviders(modelRegistry, extensionsResult);

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

		const customCommandsResult = await loadStartupCustomCommands({
			options,
			cwd,
			agentDir,
			cpuExec,
			operatorNotices,
		});

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

		const { tools: toolRegistry, builtInNames: builtInRegistryToolNames } = await assembleToolRegistry({
			builtinTools,
			extensionTools: wrappedExtensionTools,
			pendingMCPToolNames:
				deferMCPDiscoveryForUI && mcpManager
					? collectPendingMCPToolNames(options.toolNames, existingSession.selectedMCPToolNames)
					: [],
			extensionRunner,
			settings,
			toolSession,
		});

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
				nonProjectCwd: projectInputs.nonProjectCwd,
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
			const defaultPrompt = await buildSystemPromptInternal({
				...gateInputs,
				...promptInputs.promptOptions(),
				// The tree is scanned when the project is discovered, so this flag hides a
				// scanned tree but cannot scan one; `gate-registry.ts` records that placement.
				// Descriptor placement stays live in `gateInputs`: the same active-model policy
				// also drives provider-schema pruning below, so a model switch cannot retain
				// the previous model family's more expensive representation.
				includeWorkspaceTree: settings.get("includeWorkspaceTree") ?? false,
				// A spawned agent gets no personality regardless of the setting. That is a fact about
				// this caller, not about the configuration, so it does not belong in the resolver.
				personality: agentKind === "sub" ? "none" : gateInputs.personality,
				agentDir,
				resolvedCustomPrompt: options.customSystemPrompt,
				tools: promptTools,
				toolNames,
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
				memoryRootEnabled: memoryBackend.id === "local",
				model: getActiveModelString(),
				sectionOrder: resolvePromptSectionOrderForModel(settings, agent?.state.model ?? model),
			});
			return applySystemPromptOverride(defaultPrompt, options.systemPrompt);
		};

		const normalizedRequested = resolveRequestedToolNames({
			toolNames: options.toolNames,
			requireYieldTool: options.requireYieldTool === true,
			builtInToolNames,
			registryToolNames: Array.from(toolRegistry.keys()),
			hasRegistryTool: name => toolRegistry.has(name),
		});
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
		// `explicitToolNames` is the RAW `options.toolNames`, NOT the list `resolveRequestedToolNames`
		// widened: the yield / auto-learn names it forces in are activations, not user requests, and
		// must not exempt a tool from discovery-all hiding.
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

		const requestLeases = new SecretRequestLeases(secretRuntime);

		// Acquire before the first async extension hook. The returned arrays and
		// context retain this exact authority through provider serialization.
		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const lease = await requestLeases.admit(messages);
			const withContext = await extensionRunner.emitContext(messages);
			const transformed = wrapSteeringForModel(withContext);
			requestLeases.bind(withContext, lease);
			requestLeases.bind(transformed, lease);
			return transformed;
		};

		// No image policy here. Conversion sees one model per session, while the
		// main turn, a side request, compaction and an advisor each dispatch
		// their own; the policy resolves in AgentSession's provider-context hook,
		// which knows the model the request is actually going to.
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] =>
			requestLeases.redactMessages(messages, filterProviderReplayMessages(convertToLlm(messages)));

		const transformProviderContext = async (
			context: Context,
			_transformModel: Model,
			requestLease?: SecretRuntimeLease,
		): Promise<Context> => requestLeases.redactContext(context, requestLease);

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
				const runtime = requestLeases.requestLease(context);
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
					requestLeases.mainRequest,
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
			resolveSecretRuntimeLeaseForContext: context => requestLeases.forContext(context),
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

		armLaunchArgot({
			argot,
			enabled: argotEnabled,
			settings,
			cwd,
			sessionManager,
			refreshPrompt: () => session.refreshBaseSystemPrompt("argot-arm"),
		});
		if (!hasExistingSession) {
			recordNewSessionStart({
				sessionManager,
				settings,
				isMainAgent: agentKind === "main",
				systemPrompt: session.agent.state.systemPrompt,
				activeToolNames: session.getActiveToolNames(),
			});
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

		prewarmCodexTransport({
			model,
			modelRegistry,
			sessionId: providerSessionId,
			preferWebsockets: preferOpenAICodexWebsockets,
			providerSessionState: session.providerSessionState,
		});

		// Print/script invocations (`hasUI=false`) list no language servers: they draw no warmup
		// status and usually finish before a server stabilizes, so warming one only spends CPU on
		// `initialize` responses beside the stream consumer. The lsp barrel is imported lazily
		// because it pulls the client and config machinery, which stays off the boot path.
		const lspServers: CreateAgentSessionResult["lspServers"] =
			enableLsp && options.hasUI ? startLspServers(await import("./lsp"), { cwd, settings, eventBus }) : undefined;

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
