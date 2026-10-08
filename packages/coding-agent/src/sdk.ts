import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Agent, type AgentTool, AppendOnlyContextManager, type StreamFn } from "@veyyon/agent-core";
import type { Model, ServiceTierByFamily } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import type { Dialect } from "@veyyon/ai/dialect";
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import { createInterruptedTurnAbortMessage } from "@veyyon/kernel/session/exit-diagnostics";
import { OperatorNotices, stderrNoticeSink } from "@veyyon/kernel/session/operator-notices";
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
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
	Snowflake,
} from "@veyyon/utils";
import { type ArgotGate, shouldEncode } from "argot/policy";
import { renderPreamble } from "argot/preamble";
import type { ArgotSession } from "argot/session";
import { createArgotSession } from "./argot-cache";
import { buildArgotGate } from "./argot-wire";
import { AsyncJobManager } from "./async";
import { AutoLearnController, buildAutoLearnInstructions } from "./autolearn/controller";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { resolveDialect } from "./config/dialect-format";
import { shouldInlineToolDescriptors } from "./config/inline-tool-descriptors-mode";
import { ModelRegistry } from "./config/model-registry";
import { openaiWebsocketPreference } from "./config/openai-websockets-mode";
import type { PromptTemplate } from "./config/prompt-templates";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings } from "./config/settings";
import { CursorExecHandlers } from "./cursor";
import { initializeWithSettings } from "./discovery";
import { type Rule, setActiveRules } from "./discovery/capability/rule";
import { bucketRules, type RuleBuckets } from "./discovery/capability/rule-buckets";
import { TtsrManager } from "./export/ttsr";
import type { LoadedCustomCommand } from "./extensibility/custom-commands/types";
import type { CustomTool, CustomToolContext } from "./extensibility/custom-tools/types";
import {
	type BuiltinExtensionFactory,
	ExtensionRunner,
	ExtensionToolWrapper,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type RegisteredTool,
	wrapRegisteredTools,
} from "./extensibility/extensions";
import { type Skill, setActiveSkills } from "./extensibility/skills";
import type { FileSlashCommand } from "./extensibility/slash-commands";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import { describeLegacyPromptFile, findLegacyPromptFiles } from "./legacy-system-prompt-files";
import type { MCPManager } from "./mcp";
import { holdSessionMcpManager, type McpManagerRelease } from "./mcp/manager-lease";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory/backend";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { AgentRegistry } from "./registry/agent-registry";
import { resolveHarnessProfileForModel, resolvePromptSectionOrderForModel } from "./registry/model-profile";
import { attachSecretsNoticeSink } from "./secrets/notices";
import { SessionSecretRuntime } from "./secrets/session-runtime";
import { AgentSession } from "./session/agent-session";
import { discoverAuthStorage } from "./session/auth-broker-config";
import { type SessionCpuExecHooks, sessionCpuExecHooks } from "./session/cpu-limit";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "./session/messages";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { StartupModelSelection } from "./session/startup-model";
import { orderSessionDisposal } from "./session/top-level-sessions";
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
import { shouldDisableReasoning, toReasoningEffort } from "./thinking";
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
import { createVibeModeTools } from "./tools/agent/manifest";
import { normalizeToolNames, TOOL } from "./tools/core/builtin-names";
import { ToolContextStore } from "./tools/core/context";
import {
	type InitialActiveToolNames,
	resolveDiscoveryAllForceActive,
	resolveInitialActiveToolNames,
	resolveRequestedToolNames,
} from "./tools/core/loading";
import { wrapToolWithMetaNotice } from "./tools/core/output-meta";
import { createRepairToolCallArgumentsHook } from "./tools/core/repair/agent-hook";
import { renderSearchToolBm25Description } from "./tools/search/search-tool-bm25";
import { isImageProviderPreference, setPreferredImageProvider } from "./tools/web/image-gen";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "./tools/web/search";
import type { ActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import type { WorkspaceTree } from "./workspace-tree";

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

// Internal Helpers

import type { AsyncResultEntry, ProjectAdvisorScope } from "./session/agent-session-types";
import { createOwnedAsyncJobManager, sessionAsyncJobManager } from "./session/async-jobs";
import {
	discoverProjectInputs,
	type ProjectInputDiscovery,
	projectAdvisorScope,
	workspaceTreeWithinDeadline,
} from "./session/factory-extensions";
import { openSessionMCP, type SessionMCP, wireReactiveMCPManager } from "./session/factory-mcp";
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
	loadSessionCustomTools,
	registerSdkCustomTools,
} from "./session/factory-tools";
import { deferAtRestReading } from "./session/non-message-tokens";
import {
	applySystemPromptOverride,
	composeAppendPrompt,
	type DiscoveredProjectInputs,
	ProjectPromptInputs,
	promptDiscoverableTools,
} from "./session/prompt-inputs";
import { deferMemoryStartup, prewarmCodexTransport, startLspServers } from "./session/startup-background";
import { CredentialDisabledRelay } from "./session/startup-credential-relay";
import {
	adoptStartupExtensionProviders,
	type CommandInputDiscovery,
	discoverCommandInputs,
	loadStartupCustomCommands,
	loadStartupExtensions,
	reportSkillWarnings,
} from "./session/startup-extensions";
import {
	type AgentIdentity,
	type ProviderPromptCache,
	resolveAgentIdentity,
	resolveProviderPromptCache,
} from "./session/startup-identity";
import {
	armLaunchArgot,
	rearmArgotForResume,
	recordAtRestLaunch,
	recordNewSessionDefaults,
	recordNewSessionStart,
} from "./session/startup-records";
import {
	createLeasedStreamFn,
	createRequestHooks,
	createToolArgumentTransform,
	type SessionRequestHooks,
	sessionTelemetry,
} from "./session/startup-request-hooks";
import { SessionToolDiscovery } from "./session/tool-discovery";
import { buildAdvisorTools, createSessionToolSession, type SessionToolSession } from "./session/tool-session";

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

/** Apply the web search, excluded web search and image provider preferences in `settings`. */
function applyProviderPreferences(settings: Settings): void {
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	if (Array.isArray(excludedWebSearchProviders)) {
		setExcludedSearchProviders(excludedWebSearchProviders.filter(isSearchProviderId));
	}
	const webSearchProvider = settings.get("providers.webSearch");
	if (typeof webSearchProvider === "string" && isSearchProviderPreference(webSearchProvider)) {
		setPreferredSearchProvider(webSearchProvider);
	}
	const imageProvider = settings.get("providers.image");
	if (isImageProviderPreference(imageProvider)) setPreferredImageProvider(imageProvider);
}

/**
 * The agent's dialect resolver, run with the active model on every request, so a switch to a
 * `supportsTools: false` model stops sending the native `tools` parameter its endpoint rejects with a
 * 400. `warn` receives one message per model that `tools.format` moves onto a text dialect for that reason.
 */
function createDialectResolver(
	settings: Settings,
	warn: (message: string) => void,
): (requestModel: Model) => Dialect | undefined {
	const warnedModels = new Set<string>();
	return requestModel => {
		const dialect = resolveDialect(settings.get("tools.format"), requestModel);
		if (dialect === undefined || requestModel.supportsTools !== false) return dialect;
		const modelKey = `${requestModel.provider}/${requestModel.id}`;
		if (!warnedModels.has(modelKey)) {
			warnedModels.add(modelKey);
			warn(
				`${modelKey} is cataloged as non-tool-calling; tools are delivered through the "${dialect}" text dialect instead of the native tools parameter.`,
			);
		}
		return dialect;
	};
}

/**
 * Report the prompt size the model saw each turn: its input plus cached-prompt tokens, output excluded,
 * read from the assistant message's usage.
 */
function onTurnPromptTokens(agent: Agent, report: (tokens: number) => void): void {
	agent.subscribe(event => {
		if (event.type !== "turn_end" || !("usage" in event.message) || !event.message.usage) return;
		const { usage } = event.message;
		report(usage.input + usage.cacheRead + usage.cacheWrite);
	});
}

/**
 * One {@link createAgentSession} call, as the steps it runs in order. Each step reads what the steps
 * before it set. A resource a step acquires is released by {@link SessionStartup.abandon} when a later
 * step throws before the session takes it over, and by the session's disposal once it has.
 */
class SessionStartup {
	readonly #options: CreateAgentSessionOptions;
	readonly #cwd: string;
	readonly #agentDir: string;
	readonly #globalConfigRoot: string;
	readonly #eventBus: EventBus;
	readonly #modelRegistry: ModelRegistry;
	readonly #authStorage: AuthStorage;
	readonly #credentialDisabled: CredentialDisabledRelay;
	readonly #evalKernelOwnerId = `agent-session:${Snowflake.next()}`;
	readonly #isSpawned: boolean;
	readonly #taskDepth: number;
	readonly #enableLsp: boolean;

	// Released by `abandon` while no session owns them.
	/** Detach the sinks routing secrets conditions and filesystem and native faults to the operator channel. */
	readonly #noticeSinks: Array<() => void> = [];
	/** The auth store startup created. */
	readonly #createdAuthStorage: AuthStorage | undefined;
	#createdSessionManager: SessionManager | undefined;
	#createdMcpManager: MCPManager | undefined;
	#releaseMcpManager: McpManagerRelease | undefined;
	#asyncJobManager: AsyncJobManager | undefined;
	#registered = false;
	#session: AgentSession | undefined;
	#agent: Agent | undefined;

	// Set by a step of `run` before any reader runs.
	#settings!: Settings;
	#projectInputs!: ProjectInputDiscovery;
	#commandInputs!: CommandInputDiscovery;
	#operatorNotices!: OperatorNotices;
	#sessionManager!: SessionManager;
	#providerSessionId!: string;
	#providerPromptCache!: ProviderPromptCache;
	#secretRuntime!: SessionSecretRuntime;
	#argot: ArgotSession | undefined;
	#argotEnabled = false;
	#argotGate!: ArgotGate;
	/**
	 * The prompt tokens the model last saw, refreshed each turn so the encode cutoff tracks the growing
	 * context. 0 until the first response, which keeps encoding on for a small starting context.
	 */
	#argotContextTokens = 0;
	#restoredBranch!: SessionEntry[];
	#restoredContext!: SessionContext;
	#hasExistingSession = false;
	#hasServiceTierEntry = false;
	#modelSelection!: StartupModelSelection;
	#skills!: Skill[];
	#rules!: Rule[];
	#ruleBuckets!: RuleBuckets;
	#ttsrManager!: TtsrManager;
	#contextFiles!: ContextFileEntry[];
	#activeRepoContext!: ActiveRepoContext | null;
	#advisorScope!: ProjectAdvisorScope;
	#agentRegistry!: AgentRegistry;
	#identity!: AgentIdentity;
	#tools!: SessionToolSession;
	#scopedAsyncJobManager: AsyncJobManager | undefined;
	#localProtocolOptions!: LocalProtocolOptions;
	#builtinTools!: Tool[];
	/** The built-ins `createTools` built, by provenance: a custom tool sharing a name is not one. */
	#builtInToolNames!: string[];
	#mcp!: SessionMCP;
	#cpuExec!: SessionCpuExecHooks;
	#extensionsResult!: LoadExtensionsResult;
	#customCommands!: LoadedCustomCommand[];
	#extensionRunner!: ExtensionRunner;
	#toolContextStore!: ToolContextStore;
	#registeredTools!: RegisteredTool[];
	#sdkTools!: RegisteredTool[];
	#toolRegistry!: Map<string, Tool>;
	#builtInRegistryToolNames!: Set<string>;
	#toolDiscovery!: SessionToolDiscovery;
	#cursorExecHandlers!: CursorExecHandlers;
	#promptInputs!: ProjectPromptInputs;
	#requestedToolNames!: Set<string>;
	#discoveryDefaultServers!: Set<string>;
	#initialTools!: InitialActiveToolNames;
	#preferWebsockets: boolean | undefined;
	#serviceTierByFamily!: ServiceTierByFamily;
	/**
	 * The settings-aware stream wrapper the agent, the advisor and side requests (`/btw`, `/omfg`, IRC
	 * auto-replies, handoff) share, so OpenRouter sticky routing, antigravity endpoint routing, in-flight
	 * caps and the loop guard hold for every provider call. The per-provider concurrency limiter holds a
	 * slot per LLM HTTP request, not per spawned agent lifecycle, which prevents the nested-spawn
	 * deadlock from issue #3749.
	 */
	#sideStreamFn!: StreamFn;

	/**
	 * Whether a model receives its tool descriptors inline in the prompt rather than in the provider
	 * schema. One per-model reading drives both prompt placement and schema pruning: a session can
	 * switch model families, and `auto` chooses different representations for Gemini and native OpenAI
	 * models.
	 */
	readonly #inlineToolDescriptors = (requestModel: Model): boolean =>
		shouldInlineToolDescriptors(this.#settings.get("inlineToolDescriptors"), requestModel.id);

	/** Resolve the model registry and the auth store it pins. */
	static async begin(options: CreateAgentSessionOptions): Promise<SessionStartup> {
		const cwd = options.cwd ?? getProjectDir();
		const agentDir = options.agentDir ?? getAgentDir();
		// The auth store is the model registry's: `ModelRegistry.getApiKey()` routes refresh failures
		// through that instance, so a divergent store handed to the bridge, the MCP manager or the
		// session would miss credential_disabled events.
		const modelRegistry =
			options.modelRegistry ??
			new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
		if (options.authStorage && options.authStorage !== modelRegistry.authStorage) {
			throw new Error(
				"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
			);
		}
		return new SessionStartup(options, cwd, agentDir, modelRegistry);
	}

	private constructor(
		options: CreateAgentSessionOptions,
		cwd: string,
		agentDir: string,
		modelRegistry: ModelRegistry,
	) {
		this.#options = options;
		this.#cwd = cwd;
		this.#agentDir = agentDir;
		this.#globalConfigRoot = options.globalConfigRoot ?? getGlobalConfigRootDir();
		this.#eventBus = options.eventBus ?? new EventBus();
		this.#modelRegistry = modelRegistry;
		this.#authStorage = modelRegistry.authStorage;
		this.#createdAuthStorage = !options.authStorage && !options.modelRegistry ? this.#authStorage : undefined;
		this.#credentialDisabled = new CredentialDisabledRelay(this.#authStorage);
		this.#isSpawned = isSubagentSession(options);
		this.#taskDepth = options.taskDepth ?? 0;
		this.#enableLsp = options.enableLsp ?? true;
	}

	async run(): Promise<CreateAgentSessionResult> {
		await this.#openChannels();
		this.#createArgot();
		await this.#restoreTranscript();
		await this.#beginModelSelection();
		const workspaceTree = await this.#loadProjectInputs();
		this.#createToolSession(workspaceTree);
		this.#installProtocolState();
		await this.#loadTools();
		await this.#completeModelSelection();
		await this.#createExtensionRunner();
		await this.#assembleTools();
		this.#createPromptInputs();
		this.#resolveInitialTools();
		this.#registerAgent();
		const prompt = await this.#buildInitialSystemPrompt();
		const promptTemplates = await this.#commandInputs.promptTemplates;
		this.#tools.toolSession.promptTemplates = promptTemplates;
		const slashCommands = await this.#commandInputs.slashCommands;
		const hooks = createRequestHooks(this.#secretRuntime, this.#extensionRunner);
		const agent = this.#createAgent(prompt, hooks);
		const session = this.#createSession(agent, hooks, promptTemplates, slashCommands);
		this.#recordSessionStart(session);
		this.#attachSession(session);
		const lspServers = await this.#startBackgroundWork(session);
		return {
			session,
			extensionsResult: this.#extensionsResult,
			setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => {
				this.#toolContextStore.setUIContext(uiContext, hasUI);
			},
			setToolNotifier: this.#tools.setNotifier,
			mcpManager: this.#mcp.manager,
			modelFallbackMessage: this.#modelSelection.fallbackMessage,
			lspServers,
			eventBus: this.#eventBus,
		};
	}

	/**
	 * Release what startup acquired after a step threw. The subscription and the sinks are released
	 * first, so none keeps pointing at a session that never started; each release is idempotent with
	 * the dispose path.
	 */
	async abandon(): Promise<void> {
		this.#credentialDisabled.dispose();
		this.#detachNoticeSinks();
		try {
			if (this.#session) await this.#session.dispose();
			else await this.#releaseUnstarted();
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: errorMessage(cleanupError),
			});
		}
	}

	/** Release what no session took over. */
	async #releaseUnstarted(): Promise<void> {
		if (this.#registered) this.#unregisterUnlessParked();
		const jobs = this.#asyncJobManager;
		if (jobs) {
			if (AsyncJobManager.instance() === jobs) AsyncJobManager.setInstance(undefined);
			await jobs.dispose({ timeoutMs: 3_000 });
		}
		await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		// A manager startup created is disconnected when no release holds it.
		if (this.#releaseMcpManager) await this.#releaseMcpManager();
		else await this.#createdMcpManager?.disconnectAll();
		await this.#createdSessionManager?.close();
		this.#createdAuthStorage?.close();
	}

	#detachNoticeSinks(): void {
		for (const detach of this.#noticeSinks.splice(0)) detach();
	}

	/**
	 * Forget the agent ref on teardown, unless the agent is being parked or already is. Parking disposes
	 * the session but keeps the ref addressable (history://, revive); only process teardown or an
	 * explicit kill unregisters.
	 */
	#unregisterUnlessParked(): void {
		const id = this.#identity.id;
		if (this.#agentRegistry.get(id)?.status === "parked") return;
		if (AgentLifecycleManager.global().isParking(id)) return;
		this.#agentRegistry.unregister(id);
	}

	/**
	 * Load settings, start every project-input discovery, and open the session file, the operator
	 * channel and the secret runtime.
	 *
	 * Each discovery is awaited at its consumer, so the scans overlap model resolution, secret loading,
	 * the session-context build, tool creation, MCP discovery and extension discovery. A spawned agent
	 * inherits its parent's resolved values through the options.
	 */
	async #openChannels(): Promise<void> {
		const options = this.#options;
		const cwd = this.#cwd;
		const agentDir = this.#agentDir;
		const settings = await (options.settings ??
			options.settingsManager ??
			logger.time("settings", Settings.init, { cwd, agentDir }));
		this.#settings = settings;
		logger.time("initializeWithSettings", initializeWithSettings, settings);
		if (!options.modelRegistry) {
			this.#modelRegistry.refreshInBackground();
		}
		// A caller that filtered its context files down to nothing turns discovery off.
		if (options.contextFiles?.length === 0) {
			logger.warn("Context file discovery disabled: caller supplied an empty resolved list", { cwd, agentDir });
		}
		this.#projectInputs = discoverProjectInputs(cwd, agentDir, settings, options);
		this.#commandInputs = discoverCommandInputs(cwd, agentDir, options);
		applyProviderPreferences(settings);
		// The operator-visible channel for non-fatal startup and runtime problems. It exists before the
		// session manager, so load-time recovery notices use the same surface as secrets and filesystem
		// faults. The default is stderr rather than dropping warnings.
		this.#operatorNotices = options.operatorNotices ?? new OperatorNotices(stderrNoticeSink);
		this.#openSessionManager();
		await this.#attachNoticeSinks();
		// Startup is the only load that may start without a vault; every later reload throws, because
		// its caller is about to expand a live placeholder.
		this.#secretRuntime = await SessionSecretRuntime.load(
			{
				settings,
				globalConfigRoot: this.#globalConfigRoot,
				agentDir,
				operatorNotices: this.#operatorNotices,
				getCwd: () => this.#sessionManager.getCwd(),
			},
			cwd,
		);
	}

	#openSessionManager(): void {
		const options = this.#options;
		const instrumentation = this.#settings.get("session.instrumentation");
		const sessionManager =
			options.sessionManager ??
			logger.time("sessionManager", () =>
				SessionManager.create(
					this.#cwd,
					SessionManager.getDefaultSessionDir(this.#cwd, this.#agentDir),
					undefined,
					{
						operatorNotices: this.#operatorNotices,
						instrumentation,
					},
				),
			);
		if (!options.sessionManager) this.#createdSessionManager = sessionManager;
		this.#sessionManager = sessionManager;
		// A caller-supplied manager was constructed before this SDK surface existed. Attach the selected
		// session's channel now so a later setSessionFile or load recovery is still visible.
		sessionManager.setOperatorNotices(this.#operatorNotices);
		sessionManager.setInstrumentationLevel(this.#settings.get("session.instrumentation"));
		this.#providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
		this.#providerPromptCache = resolveProviderPromptCache(
			options,
			sessionManager.getHeader()?.providerPromptCacheKey,
		);
	}

	/**
	 * Route conditions raised below this layer to the operator channel. Key and vault conditions come
	 * from deep inside the secrets subsystem and cannot be returned (see secrets/notices.ts). The
	 * `@veyyon/utils` helpers are free functions with no per-session channel, so without the fault sink
	 * an agents directory that exists and cannot be listed reported "no agents" and logged the reason to
	 * a file. The native loader runs before any session exists and inside the interactive UI, where a raw
	 * terminal write lands between frames; its notices wait in the loader until this sink attaches.
	 *
	 * Each registration is identity-bound, so overlapping sessions all receive process-global
	 * conditions, and each is detached on dispose and on a startup failure: every sink closes over
	 * `operatorNotices` and would otherwise outlive the session it reports to.
	 */
	async #attachNoticeSinks(): Promise<void> {
		const operatorNotices = this.#operatorNotices;
		this.#noticeSinks.push(attachSecretsNoticeSink(message => operatorNotices.warn("secrets", message)));
		for (const legacyFile of await findLegacyPromptFiles({ cwd: this.#cwd, agentDir: this.#agentDir })) {
			operatorNotices.warn("system-prompt", describeLegacyPromptFile(legacyFile));
		}
		this.#noticeSinks.push(
			attachFaultSink(fault => operatorNotices.warn(fault.source, fault.text)),
			attachNativeNoticeSink(text => operatorNotices.warn("natives", text)),
		);
	}

	/**
	 * The Argot per-project shorthand codec (experimental). The launch project's dictionary loads at
	 * startup; further projects load through the `argot_load` tool. The dictionary is a local cache under
	 * the config root, never committed. The system prompt teaches the notation and the loaded handles.
	 * Expansion runs at the same two seams as secret deobfuscation, tool-call arguments before execution
	 * and assistant content before display, so the short handle stays in history and everything outside
	 * history reads full text.
	 *
	 * A spawned agent follows `argot.agents`: `off` gets no codec, `fresh` an empty session that loads its
	 * task's project itself, `inherit` a fork of the parent's codec. The encode gate selects which models
	 * may write shorthand and an optional context-size cutoff; decoding is unconditional and lossless.
	 */
	#createArgot(): void {
		const settings = this.#settings;
		this.#argotEnabled = settings.get("argot.enabled") === true;
		this.#argot = createArgotSession({
			enabled: this.#argotEnabled,
			isSpawned: this.#isSpawned,
			agentMode: settings.get("argot.agents"),
			parentArgot: this.#options.parentArgot,
		});
		this.#argotGate = buildArgotGate(
			this.#argotEnabled,
			settings.get("argot.encode.models") ?? [],
			settings.get("argot.encode.disableAboveTokens"),
		);
	}

	/**
	 * Read the session's branch and context. An abnormal process exit after a non-terminal message tail
	 * is durable evidence that the old process cannot finish that turn, so the partial transcript is
	 * kept and one terminal aborted assistant record is appended before the runtime context is rebuilt.
	 * The helper is idempotent once that record exists.
	 */
	async #restoreTranscript(): Promise<void> {
		const sessionManager = this.#sessionManager;
		let branch = logger.time("getSessionBranch", () => sessionManager.getBranch());
		const interruptedTurnAbort = createInterruptedTurnAbortMessage(branch);
		if (interruptedTurnAbort) {
			sessionManager.appendMessage(interruptedTurnAbort);
			branch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
		}
		this.#restoredBranch = branch;
		this.#restoredContext = logger.time("loadSessionContext", () => sessionManager.buildSessionContext());
		await rearmArgotForResume(this.#argot, branch, this.#settings);
		this.#hasExistingSession = branch.length > 0;
		this.#hasServiceTierEntry = branch.some(entry => entry.type === "service_tier_change");
	}

	/**
	 * The first model pass: the session's last model, else the settings default. Extension providers
	 * register later, and {@link completeModelSelection} runs the second pass.
	 */
	async #beginModelSelection(): Promise<void> {
		this.#modelSelection = await StartupModelSelection.begin({
			options: this.#options,
			settings: this.#settings,
			modelRegistry: this.#modelRegistry,
			sessionManager: this.#sessionManager,
			existingSession: this.#restoredContext,
			hasExistingSession: this.#hasExistingSession,
			hasThinkingEntry: this.#restoredBranch.some(entry => entry.type === "thinking_level_change"),
		});
	}

	/**
	 * Await the skills, rules and context files, registering the TTSR rules. Returns the workspace tree
	 * when its scan finished within the startup deadline: the scan is slow on large repositories, so past
	 * the deadline the tool session gets none and the system prompt races the same promise again while
	 * the scan warms its caches.
	 */
	async #loadProjectInputs(): Promise<WorkspaceTree | undefined> {
		const projectInputs = this.#projectInputs;
		const discovered = await projectInputs.skills;
		this.#skills = discovered.skills;
		reportSkillWarnings(this.#operatorNotices, discovered.warnings);
		// `getCwd` is live, not `cwd`: a rule with a `pathScope` compares the match against the CURRENT
		// working directory, and `set_cwd` moves it mid-session.
		const ttsrSettings = this.#settings.getGroup("ttsr");
		const ttsrManager = new TtsrManager(ttsrSettings, { getCwd: () => this.#sessionManager.getCwd() });
		this.#ttsrManager = ttsrManager;
		this.#rules = await projectInputs.rules;
		this.#ruleBuckets = bucketRules(this.#rules, ttsrManager, ttsrSettings);
		const { injectedTtsrRules } = this.#restoredContext;
		if (injectedTtsrRules.length > 0) ttsrManager.restoreInjected(injectedTtsrRules);
		const [contextFiles, workspaceTree, activeRepoContext, watchdogFiles, advisors] = await Promise.all([
			projectInputs.contextFiles,
			workspaceTreeWithinDeadline(projectInputs),
			projectInputs.activeRepoContext,
			projectInputs.watchdogFiles,
			projectInputs.advisors,
		]);
		this.#contextFiles = contextFiles;
		this.#activeRepoContext = activeRepoContext;
		// The advisor reads the same project context files (AGENTS.md and the rest) the primary agent's
		// system prompt carries, so the read-only reviewer judges against them.
		this.#advisorScope = projectAdvisorScope({ watchdogFiles, activeRepoContext, contextFiles, advisors });
		return workspaceTree;
	}

	#createToolSession(workspaceTree: WorkspaceTree | undefined): void {
		const options = this.#options;
		const sessionManager = this.#sessionManager;
		this.#asyncJobManager = createOwnedAsyncJobManager({
			options,
			settings: this.#settings,
			sessionManager,
			target: () => this.#session,
		});
		this.#scopedAsyncJobManager = sessionAsyncJobManager(this.#asyncJobManager, options);
		this.#agentRegistry = options.agentRegistry ?? AgentRegistry.global();
		this.#identity = resolveAgentIdentity(options, this.#isSpawned, sessionManager.getSessionId?.());
		this.#tools = createSessionToolSession({
			options,
			sessionManager,
			session: () => this.#session,
			agent: () => this.#agent,
			startupModel: () => this.#modelSelection.model,
			hasExplicitModel: this.#modelSelection.hasExplicitModel,
			obfuscateProviderText: text => this.#secretRuntime.obfuscateText(text),
			isSpawned: this.#isSpawned,
			agentId: this.#identity.id,
			evalKernelOwnerId: this.#evalKernelOwnerId,
			fields: {
				enableLsp: this.#enableLsp,
				contextFiles: this.#contextFiles,
				workspaceTree,
				skills: this.#skills,
				rules: this.#rules,
				eventBus: this.#eventBus,
				agentRegistry: this.#agentRegistry,
				settings: this.#settings,
				authStorage: this.#authStorage,
				modelRegistry: this.#modelRegistry,
				asyncJobManager: this.#scopedAsyncJobManager,
			},
		});
	}

	/**
	 * Install the process-wide internal URL state and the tool session's artifact resolution. A top-level
	 * session installs the active snapshots; a spawned agent inherits them. Artifact and agent-output URLs
	 * resolve through `AgentRegistry.global()`: the protocol handlers walk each ref's
	 * `sessionManager.getArtifactsDir()`, which is the parent's directory for a spawned agent (it adopts
	 * the parent's ArtifactManager), so one lookup reaches every artifact.
	 */
	#installProtocolState(): void {
		const options = this.#options;
		const toolSession = this.#tools.toolSession;
		const getArtifactsDir = () => this.#sessionManager.getArtifactsDir();
		if (!isInProcessChildSession(options)) this.#publishTopLevelState();
		this.#localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => this.#sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = this.#localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);
	}

	#publishTopLevelState(): void {
		setActiveSkills(this.#skills);
		// TTSR rules are registered with the manager and bucketed out before rulebook and always-apply,
		// so they are listed too: without them a TTSR-only rule (a triggered builtin) has no `rule://`
		// address and `rule://` reports "Available: none".
		const { rulebookRules, alwaysApplyRules } = this.#ruleBuckets;
		setActiveRules(rulebookRules.concat(alwaysApplyRules, this.#ttsrManager.getRules()));
		// The first top-level session's manager stays the process-wide fallback. A later one runs its own
		// jobs and never replaces it, so its disposal cannot take the first session's jobs down (issue #1923).
		const jobs = this.#asyncJobManager;
		if (jobs && !AsyncJobManager.instance()) AsyncJobManager.setInstance(jobs);
	}

	/**
	 * Build the built-in tools, open MCP, load the custom tools and the extensions, and register the
	 * extension providers. Every process a custom tool, custom command or extension spawns through
	 * `exec` joins the session's CPU budget group; the hooks resolve the limiter lazily, so it may be
	 * created after the tools load.
	 */
	async #loadTools(): Promise<void> {
		const options = this.#options;
		const toolSession = this.#tools.toolSession;
		this.#builtinTools = await logger.time("createAllTools", createTools, toolSession, options.toolNames);
		const mcp = await openSessionMCP({
			cwd: this.#cwd,
			agentDir: this.#agentDir,
			settings: this.#settings,
			authStorage: this.#authStorage,
			eventBus: this.#eventBus,
			options,
			restoredSelectedToolNames: this.#restoredContext.selectedMCPToolNames,
		});
		this.#mcp = mcp;
		this.#createdMcpManager = mcp.createdManager;
		toolSession.mcpManager = mcp.manager;
		this.#builtInToolNames = this.#builtinTools.map(tool => tool.name);
		this.#cpuExec = sessionCpuExecHooks(() => toolSession.getSessionId?.() ?? null);
		const sessionCustomTools = await loadSessionCustomTools({
			options,
			settings: this.#settings,
			modelRegistry: this.#modelRegistry,
			model: this.#modelSelection.model,
			cwd: this.#cwd,
			agentDir: this.#agentDir,
			builtInToolNames: this.#builtInToolNames,
			toolSession,
			cpuExec: this.#cpuExec,
			operatorNotices: this.#operatorNotices,
		});
		// A spawned agent receives the path list, not the loaded tools, and binds them under its own
		// `CustomToolAPI` without the filesystem scan.
		toolSession.customToolPaths = sessionCustomTools.paths;
		await this.#loadExtensions(mcp.tools.concat(sessionCustomTools.tools));
	}

	async #loadExtensions(customTools: CustomTool[]): Promise<void> {
		const builtins: BuiltinExtensionFactory[] = [(await import("./autoresearch")).createAutoresearchExtension];
		if (customTools.length > 0) {
			builtins.push(createCustomToolsExtension(customTools, text => this.#secretRuntime.obfuscateText(text)));
		}
		const extensions = await loadStartupExtensions(
			{
				options: this.#options,
				cwd: this.#cwd,
				agentDir: this.#agentDir,
				settings: this.#settings,
				eventBus: this.#eventBus,
				cpuExec: this.#cpuExec,
				operatorNotices: this.#operatorNotices,
			},
			builtins,
		);
		this.#extensionsResult = extensions.result;
		// A spawned agent receives the source paths, not the loaded instances, and rebuilds its own
		// session-scoped extensions.
		const toolSession = this.#tools.toolSession;
		toolSession.extensionPaths = extensions.paths;
		toolSession.namedExtensionPaths = extensions.namedPaths;
		await adoptStartupExtensionProviders(this.#modelRegistry, extensions.result);
	}

	/**
	 * The second model pass, with every provider registered: reclaim the session's model, resolve
	 * deferred `--model` patterns, fall back to the first authenticated model, and refresh the chosen
	 * model's metadata. A first-turn user tail has no assistant metadata to copy, so the final model
	 * terminates the interrupted turn before the agent consumes the restored context.
	 */
	async #completeModelSelection(): Promise<void> {
		await this.#modelSelection.completeAfterExtensions();
		const model = this.#modelSelection.model;
		if (!model) return;
		const selectedModelAbort = createInterruptedTurnAbortMessage(this.#restoredBranch, {
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		if (!selectedModelAbort) return;
		const sessionManager = this.#sessionManager;
		sessionManager.appendMessage(selectedModelAbort);
		this.#restoredContext = logger.time("loadRecoveredUserTailContext", () => sessionManager.buildSessionContext());
	}

	/**
	 * Load the custom commands and create the extension runner and the tool context store.
	 *
	 * The runner exists even with no extension loaded: the `ExtensionToolWrapper` installed over every
	 * tool is the only place the per-tool approval check runs, so a conditional runner would drop
	 * approval for a session without extensions and contradict a non-yolo `tools.approvalMode` without
	 * feedback.
	 */
	async #createExtensionRunner(): Promise<void> {
		const cwd = this.#cwd;
		const agentDir = this.#agentDir;
		const customCommands = await loadStartupCustomCommands({
			options: this.#options,
			cwd,
			agentDir,
			cpuExec: this.#cpuExec,
			operatorNotices: this.#operatorNotices,
		});
		this.#customCommands = customCommands.commands;
		const extensionRunner = new ExtensionRunner(
			this.#extensionsResult.extensions,
			this.#extensionsResult.runtime,
			cwd,
			this.#sessionManager,
			this.#modelRegistry,
			() => (this.#session ? createSessionMemoryRuntimeContext(this.#session, agentDir, cwd) : undefined),
			this.#settings,
			this.#localProtocolOptions,
		);
		this.#extensionRunner = extensionRunner;
		this.#credentialDisabled.attach(extensionRunner);
		this.#toolContextStore = new ToolContextStore(() => this.#toolExecutionContext());
		// The agent loop resolves the context of a call the model makes. A call an eval snippet or a
		// browser page makes reaches the same approval-wrapped tools directly, so it reads the same
		// context or it arrives with no policy at all.
		this.#tools.toolSession.getToolContext = toolCall => this.#toolContextStore.getContext(toolCall);
	}

	/**
	 * The session state every tool execution context is built from, read per build so a mid-session
	 * `/yolo` toggle applies to the next tool call.
	 */
	#toolExecutionContext(): CustomToolContext {
		const session = this.#session;
		const agent = this.#agent;
		if (!session || !agent) {
			throw new Error("A tool execution context was requested before the session was constructed.");
		}
		return {
			sessionManager: this.#sessionManager,
			modelRegistry: this.#modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				abortDetached(session, "sdk.agentControl.abort", USER_INTERRUPT_LABEL);
			},
			settings: this.#settings,
			obfuscateProviderText: text => this.#secretRuntime.obfuscateText(text),
			localProtocolOptions: this.#localProtocolOptions,
			autoApprove: this.#options.autoApprove ?? false,
			bypassAllApprovals: session.isApprovalBypassed(),
			sessionApprovals: session.sessionToolApprovals(),
		};
	}

	/**
	 * Assemble the tool registry and resolve the discovery mode. Extension, SDK-custom, image
	 * generation, TTS and startup (non-deferred) MCP tools are wrapped here with the large-output
	 * artifact spill that `createTools` applies to built-ins; the wrap is idempotent.
	 */
	async #assembleTools(): Promise<void> {
		const extensionRunner = this.#extensionRunner;
		const toolSession = this.#tools.toolSession;
		this.#registeredTools = extensionRunner.getAllRegisteredTools();
		this.#sdkTools = registerSdkCustomTools(this.#options.customTools, text =>
			this.#secretRuntime.obfuscateText(text),
		);
		const extensionTools: Tool[] = wrapRegisteredTools(
			this.#registeredTools.concat(this.#sdkTools),
			extensionRunner,
		).map(wrapToolWithMetaNotice);
		const { tools, builtInNames } = await assembleToolRegistry({
			builtinTools: this.#builtinTools,
			extensionTools,
			pendingMCPToolNames: this.#mcp.pendingToolNames,
			extensionRunner,
			settings: this.#settings,
			toolSession,
		});
		this.#toolRegistry = tools;
		this.#builtInRegistryToolNames = builtInNames;
		this.#toolDiscovery = new SessionToolDiscovery({
			tools,
			builtInNames,
			settings: this.#settings,
			toolSession,
			extensionRunner,
		});
		this.#cursorExecHandlers = new CursorExecHandlers({
			cwd: this.#cwd,
			tools,
			getToolContext: () => this.#toolContextStore.getContext(),
			emitEvent: event => this.#agent?.emitExternalEvent(event),
		});
	}

	/** The `ssh` tool rebuilt for the live working directory, or null when the session did not request it. */
	async #reloadSshTool(): Promise<AgentTool | null> {
		if (!this.#requestedToolNames.has(TOOL.ssh)) return null;
		const { loadSshTool } = await import("./tools/shell/ssh");
		const sshTool = (await loadSshTool({
			...this.#tools.toolSession,
			cwd: this.#sessionManager.getCwd(),
		})) as unknown as AgentTool | null;
		if (!sshTool) return null;
		return new ExtensionToolWrapper(wrapToolWithMetaNotice(sshTool), this.#extensionRunner) as AgentTool;
	}

	#createPromptInputs(): void {
		const settings = this.#settings;
		const { rulebookRules, alwaysApplyRules } = this.#ruleBuckets;
		this.#promptInputs = new ProjectPromptInputs({
			initial: {
				cwd: this.#cwd,
				contextFiles: this.#contextFiles,
				workspaceTree: this.#projectInputs.workspaceTree,
				activeRepoContext: this.#activeRepoContext,
				nonProjectCwd: this.#projectInputs.nonProjectCwd,
				skills: this.#skills,
				rulebookRules,
				alwaysApplyRules,
			},
			getCwd: () => this.#sessionManager.getCwd(),
			discover: liveCwd => discoverProjectInputs(liveCwd, this.#agentDir, settings, this.#options),
			ttsrManager: this.#ttsrManager,
			ttsrOptions: () => settings.getGroup("ttsr"),
			onChange: next => this.#applyProjectInputs(next),
		});
	}

	/** Move the tool session, the session and the process-wide snapshots onto a new working directory's inputs. */
	#applyProjectInputs(next: DiscoveredProjectInputs): void {
		const toolSession = this.#tools.toolSession;
		toolSession.contextFiles = next.contextFiles;
		toolSession.workspaceTree = next.workspaceTree;
		toolSession.skills = next.skills;
		toolSession.rules = next.rules;
		if (this.#session) {
			this.#session.replaceSkills(next.skills);
			this.#session.replaceProjectAdvisorScope(projectAdvisorScope(next));
		}
		reportSkillWarnings(this.#operatorNotices, next.skillWarnings);
		this.#ttsrManager.reportUnknownToolScopes(this.#toolRegistry.keys());
		if (!isInProcessChildSession(this.#options)) {
			setActiveSkills(next.skills);
			setActiveRules([
				...next.buckets.rulebookRules,
				...next.buckets.alwaysApplyRules,
				...this.#ttsrManager.getRules(),
			]);
		}
	}

	/**
	 * The system prompt for `toolNames` over `tools`. Every settings-fed gate is re-read from the one
	 * resolver the inspection path (`veyyon prompt`) also calls, so a setting flipped mid-session changes
	 * the next rebuild, and the project inputs follow the live working directory.
	 */
	async #rebuildSystemPrompt(toolNames: string[], tools: Map<string, AgentTool>): Promise<BuildSystemPromptResult> {
		const options = this.#options;
		const settings = this.#settings;
		const toolDiscovery = this.#toolDiscovery;
		await this.#promptInputs.refresh();
		this.#toolContextStore.setToolNames(toolNames);
		const discoverable = promptDiscoverableTools({
			tools,
			activeToolNames: toolNames,
			mcpDiscoveryEnabled: toolDiscovery.enabled,
			discoveryMode: toolDiscovery.mode,
			builtInToolNames: this.#builtInRegistryToolNames,
		});
		const promptTools = buildSystemPromptToolMetadata(tools, {
			search_tool_bm25: { description: renderSearchToolBm25Description(discoverable.tools) },
		});
		const gateInputs = resolveGateInputs(settings, {
			tools,
			model: this.#tools.activeModel(),
			taskDepth: this.#taskDepth,
		});
		const memoryBackend = await resolveMemoryBackend(settings);
		const appendPrompt = composeAppendPrompt({
			memoryInstructions: await memoryBackend.buildDeveloperInstructions(this.#agentDir, settings, this.#session),
			// Guidance follows the auto-learn built-ins `createTools` built, by provenance: a spawned agent
			// that filtered them out, a mid-session enable that never built them, and a same-named custom
			// tool while auto-learn is off all get none.
			autoLearnInstructions: buildAutoLearnInstructions({
				manageSkill: this.#builtInToolNames.includes(TOOL.manage_skill),
				learn: this.#builtInToolNames.includes(TOOL.learn),
			}),
			// A UI session defers MCP discovery, so this is empty until the background connect completes;
			// the rebuild `refreshMCPTools` triggers afterwards adds the connected servers' instructions.
			serverInstructions: this.#mcp.manager?.getServerInstructions(),
			appendSystemPrompt: options.appendSystemPrompt,
		});
		const defaultPrompt = await buildSystemPromptInternal({
			...gateInputs,
			...this.#promptInputs.promptOptions(),
			// The tree is scanned when the project is discovered, so this flag hides a scanned tree but
			// cannot scan one; `gate-registry.ts` records that placement.
			includeWorkspaceTree: settings.get("includeWorkspaceTree") ?? false,
			// A spawned agent gets no personality whatever the setting: a fact about this caller, not
			// about the configuration.
			personality: this.#identity.kind === "sub" ? "none" : gateInputs.personality,
			agentDir: this.#agentDir,
			operatorNotices: this.#operatorNotices,
			resolvedCustomPrompt: options.customSystemPrompt,
			tools: promptTools,
			toolNames,
			resolvedAppendSystemPrompt: appendPrompt,
			skillsSettings: settings.getGroup("skills"),
			mcpDiscoveryMode: discoverable.searchable,
			mcpDiscoveryServerSummaries: discoverable.serverSummaries,
			secretsEnabled: this.#secretRuntime.obfuscator?.hasSecrets() === true,
			// Read inside the build, never snapshotted: `namedSecretNames()` expires stale entries while
			// answering, which drops a credential that lapsed mid-session, and the live obfuscator drops
			// one `/secret rm` revoked. Undefined (protection off, or an empty vault) emits no section.
			secretInventory: renderSecretInventory(this.#secretRuntime.obfuscator?.namedSecretNames()),
			...this.#argotPromptSections(),
			memoryRootEnabled: memoryBackend.id === "local",
			model: this.#tools.activeModelString(),
			sectionOrder: resolvePromptSectionOrderForModel(settings, this.#tools.activeModel()),
		});
		return applySystemPromptOverride(defaultPrompt, options.systemPrompt);
	}

	/**
	 * The shorthand sections a rebuild teaches. Teaching follows the encode policy: the active model is
	 * on the allowlist and the context is under the cutoff. While encoding is on, the prompt carries the
	 * notation preamble, which also instructs the model to load its project through `argot_load`; the
	 * handle table joins once a project is loaded. Handles already in history expand at the seams
	 * whatever this returns.
	 */
	#argotPromptSections(): { argotPreamble?: string; argotHandles?: string } {
		const argot = this.#argot;
		const model = this.#tools.activeModelString();
		if (!this.#argotEnabled || !argot || model === undefined) return {};
		if (!shouldEncode(this.#argotGate, { model, contextTokens: this.#argotContextTokens })) return {};
		return {
			argotPreamble: renderPreamble({ tools: true }),
			argotHandles: argot.loaded ? argot.promptFragment() : undefined,
		};
	}

	/**
	 * Resolve the active tool set the session starts with. The registry is complete here, MCP and
	 * extension tools included, so a rule scoped to a tool that does not exist is reported against the
	 * whole registry rather than the active set: scoping a rule to an inactive tool is legitimate, and a
	 * rule naming no tool is a typo that would never fire.
	 *
	 * `resolveInitialActiveToolNames` (`tools/core/loading/policy.ts`) runs the stages that turn these
	 * inputs into the active set. `explicitToolNames` is the raw `options.toolNames`, not the list
	 * `resolveRequestedToolNames` widened: the yield and auto-learn names it adds are activations, not
	 * requests, and must not exempt a tool from discovery-all hiding. Custom and extension-registered
	 * tools are always included whatever the `toolNames` filter.
	 */
	#resolveInitialTools(): void {
		const options = this.#options;
		const settings = this.#settings;
		const toolRegistry = this.#toolRegistry;
		const toolDiscovery = this.#toolDiscovery;
		const hasRegistryTool = (name: string): boolean => toolRegistry.has(name);
		const requestedToolNames = resolveRequestedToolNames({
			toolNames: options.toolNames,
			requireYieldTool: options.requireYieldTool === true,
			builtInToolNames: this.#builtInToolNames,
			registryToolNames: Array.from(toolRegistry.keys()),
			hasRegistryTool,
		});
		this.#requestedToolNames = new Set(requestedToolNames);
		this.#ttsrManager.reportUnknownToolScopes(toolRegistry.keys());
		this.#discoveryDefaultServers = new Set(
			(settings.get("mcp.discoveryDefaultServers") ?? []).map(serverName => serverName.trim()).filter(Boolean),
		);
		const registered = this.#registeredTools.map(tool => tool.definition);
		this.#initialTools = resolveInitialActiveToolNames({
			explicitToolNames: options.toolNames ? normalizeToolNames(options.toolNames) : undefined,
			requestedToolNames,
			goalEnabled: settings.get("goal.enabled"),
			defaultInactiveToolNames: new Set(registered.filter(tool => tool.defaultInactive).map(tool => tool.name)),
			hasRegistryTool,
			mcpDiscoveryEnabled: toolDiscovery.enabled,
			discoveryDefaultServerToolNames: toolDiscovery.defaultServerToolNames(this.#discoveryDefaultServers),
			persistedSelectedMCPToolNames: this.#restoredContext.selectedMCPToolNames,
			hasPersistedMCPToolSelection: this.#restoredContext.hasPersistedMCPToolSelection,
			alwaysIncludeToolNames: [
				...this.#sdkTools.map(tool => tool.definition.name),
				...registered.filter(tool => !tool.defaultInactive).map(tool => tool.name),
			],
			effectiveDiscoveryMode: toolDiscovery.mode,
			loadModeOf: name => toolRegistry.get(name)?.loadMode,
			essentialToolNames: computeEssentialBuiltinNames(settings),
			forceActiveToolNames: resolveDiscoveryAllForceActive({
				todoEager: settings.get("todo.eager"),
				todoEnabled: settings.get("todo.enabled"),
				hasTodoTool: toolRegistry.has(TOOL.todo),
				delegationStrength: delegationStrength(settings),
				hasTaskTool: toolRegistry.has(TOOL.task),
			}),
			harnessToolAllowlist: resolveHarnessProfileForModel(settings, this.#modelSelection.model)?.tools,
		});
	}

	/**
	 * Register the agent in the agent registry before the session exists, so tool routing and IRC
	 * discovery resolve it at once; {@link attachSession} attaches the session later. The scope is the
	 * conversation the agent belongs to: a spawned agent inherits its parent's, so only a root session
	 * states one, its session id, which exists before the transcript is first written and survives a
	 * `/move` that rewrites the path.
	 */
	#registerAgent(): void {
		const sessionManager = this.#sessionManager;
		const { id, displayName, kind } = this.#identity;
		const parentId = this.#options.parentAgentId;
		this.#agentRegistry.register({
			id,
			displayName,
			kind,
			parentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			scope: parentId ? undefined : (sessionManager.getSessionId?.() ?? undefined),
			status: "running",
			model: this.#tools.activeModelString(),
		});
		this.#registered = true;
	}

	/** Build the starting system prompt, letting pending input and rendering run on either side of it. */
	async #buildInitialSystemPrompt(): Promise<BuildSystemPromptResult> {
		const { initialToolNames } = this.#initialTools;
		this.#tools.setActiveToolNames(initialToolNames);
		await yieldToEventLoop();
		const prompt = await logger.time("buildSystemPrompt", () =>
			this.#rebuildSystemPrompt(initialToolNames, this.#toolRegistry),
		);
		await yieldToEventLoop();
		return prompt;
	}

	/** Construct the agent, seeded with the restored history or recording a new session's defaults. */
	#createAgent(prompt: BuildSystemPromptResult, hooks: SessionRequestHooks): Agent {
		const options = this.#options;
		const settings = this.#settings;
		const sessionManager = this.#sessionManager;
		const { model, effectiveThinkingLevel } = this.#modelSelection;
		const toolRegistry = this.#toolRegistry;
		this.#preferWebsockets = openaiWebsocketPreference(settings.get("providers.openaiWebsockets"));
		this.#serviceTierByFamily = this.#initialServiceTierByFamily();
		this.#sideStreamFn = wrapStreamFnWithProviderConcurrency(settings, createSettingsAwareStreamFn(settings));
		const agent: Agent = new Agent({
			initialState: {
				systemPrompt: prompt.systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: this.#initialTools.initialToolNames
					.map(name => toolRegistry.get(name))
					.filter((tool): tool is AgentTool => tool !== undefined),
			},
			cwd: this.#cwd,
			// Live cwd: `/move` updates the session manager (and the process cwd) without reconstructing
			// the agent, so a static cwd would strand GitLab Duo Agent namespace and project discovery on
			// the original repository's git remote.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: hooks.convertToLlm,
			onPayload: hooks.onPayload,
			onResponse: hooks.onResponse,
			sessionId: this.#providerSessionId,
			promptCacheKey: this.#providerPromptCache.key,
			deadline: options.deadline,
			transformContext: hooks.transformContext,
			transformProviderContext: hooks.transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			// Unset is exactly UNSET_NUMBER, read through its one owner, so a configured negative presence
			// or repetition penalty (both providers accept them) reaches the request.
			temperature: optionalNumber(settings.get("temperature")),
			topP: optionalNumber(settings.get("topP")),
			topK: optionalNumber(settings.get("topK")),
			minP: optionalNumber(settings.get("minP")),
			presencePenalty: optionalNumber(settings.get("presencePenalty")),
			repetitionPenalty: optionalNumber(settings.get("repetitionPenalty")),
			hideThinkingSummary: settings.get("omitThinking"),
			kimiApiFormat: settings.get("providers.kimiApiFormat") ?? "anthropic",
			preferWebsockets: this.#preferWebsockets,
			getToolContext: toolCall => this.#toolContextStore.getContext(toolCall),
			getApiKey: requestModel => this.#modelRegistry.resolver(requestModel, agent.sessionId),
			streamFn: createLeasedStreamFn(hooks.requestLeases, this.#sideStreamFn, options.onFirstChatDispatch),
			cursorExecHandlers: this.#cursorExecHandlers,
			transformToolCallArguments: createToolArgumentTransform({
				settings,
				secretRuntime: this.#secretRuntime,
				requestLeases: hooks.requestLeases,
				argot: this.#argot,
				sessionId: () => agent.sessionId,
			}),
			repairToolCallArguments: createRepairToolCallArgumentsHook(settings, () => agent.state.model),
			// Resolvers, not values: `tools.intentTracing` and descriptor placement are live prompt gates,
			// so the provider schemas follow the rebuilt prompt on a settings change or a model-family
			// switch. A prompt explaining an intent field the schemas do not carry is worse than one that
			// omits it.
			intentTracing: () => resolveIntentField(settings) !== undefined,
			instrumentation: settings.get("session.instrumentation"),
			pruneToolDescriptions: this.#inlineToolDescriptors,
			dialect: createDialectResolver(settings, message =>
				this.#session?.emitNotice("warning", message, "tools.format"),
			),
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			getToolChoice: () => this.#session?.nextToolChoiceDirective(),
			telemetry: sessionTelemetry(options.telemetry, this.#secretRuntime),
			appendOnlyContext:
				model && shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined,
		});
		this.#agent = agent;
		// The argot encode cutoff reads the context size the model last saw.
		if (this.#argotEnabled && this.#argotGate.disableAboveTokens > 0) {
			onTurnPromptTokens(agent, tokens => {
				this.#argotContextTokens = tokens;
			});
		}
		if (this.#hasExistingSession) {
			agent.replaceMessages(this.#restoredContext.messages);
		} else {
			recordNewSessionDefaults(sessionManager, model, this.#modelSelection, this.#serviceTierByFamily);
		}
		return agent;
	}

	/** The service tier a resumed session recorded, else the settings tiers. */
	#initialServiceTierByFamily(): ServiceTierByFamily {
		if (this.#hasServiceTierEntry) return this.#restoredContext.serviceTier ?? {};
		const settings = this.#settings;
		return buildServiceTierByFamily(
			settings.get("tier.openai"),
			settings.get("tier.anthropic"),
			settings.get("tier.google"),
		);
	}

	#createSession(
		agent: Agent,
		hooks: SessionRequestHooks,
		promptTemplates: PromptTemplate[],
		slashCommands: FileSlashCommand[],
	): AgentSession {
		const options = this.#options;
		const settings = this.#settings;
		const secretRuntime = this.#secretRuntime;
		const toolSession = this.#tools.toolSession;
		const mcp = this.#mcp;
		if (mcp.manager)
			this.#releaseMcpManager = holdSessionMcpManager(mcp.manager, options.mcpManager, this.#isSpawned);
		const session = new AgentSession({
			...this.#advisorScope,
			agent,
			pruneToolDescriptions: this.#inlineToolDescriptors,
			thinkingLevel: this.#modelSelection.sessionThinkingLevel,
			thinkingSource: this.#modelSelection.thinkingSource,
			prewalk: options.prewalk,
			planYolo: options.planYolo,
			serviceTierByFamily: this.#serviceTierByFamily,
			sessionManager: this.#sessionManager,
			settings,
			autoApprove: options.autoApprove,
			bypassAllApprovals: options.bypassAllApprovals,
			parentApprovalBypassed: options.parentApprovalBypassed,
			evalKernelOwnerId: this.#evalKernelOwnerId,
			// Defined only for a top-level session. AgentSession disposes only the manager it owns; a
			// spawned agent runs on its parent's and MUST NOT tear it down.
			ownedAsyncJobManager: this.#asyncJobManager,
			asyncJobManager: this.#scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner: this.#extensionRunner,
			customCommands: this.#customCommands,
			skills: this.#skills,
			operatorNotices: this.#operatorNotices,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry: this.#modelRegistry,
			toolRegistry: this.#toolRegistry,
			createVibeTools: this.#isSpawned ? undefined : () => createVibeModeTools(toolSession),
			// A spawned agent shares this process with its parent and its siblings, so its re-root may not
			// move the process working directory or any other process-global project state. See
			// `AgentSession.rescopeToCwd`.
			isSpawned: this.#isSpawned,
			builtInToolNames: this.#builtInRegistryToolNames,
			transformContext: hooks.transformContext,
			transformProviderContext: hooks.transformProviderContext,
			onPayload: hooks.onPayload,
			onResponse: hooks.onResponse,
			sideStreamFn: this.#sideStreamFn,
			preferWebsockets: this.#preferWebsockets,
			convertToLlm: hooks.convertToLlm,
			rebuildSystemPrompt: (toolNames, tools) => this.#rebuildSystemPrompt(toolNames, tools),
			reloadSshTool: () => this.#reloadSshTool(),
			requestedToolNames: this.#requestedToolNames,
			setActiveToolNames: this.#tools.setActiveToolNames,
			getMcpServerInstructions: mcp.serverInstructions,
			releaseMcpManager: this.#releaseMcpManager,
			mcpDiscoveryEnabled: this.#toolDiscovery.enabled,
			initialSelectedMCPToolNames: this.#initialTools.initialSelectedMCPToolNames,
			defaultSelectedMCPToolNames: this.#initialTools.defaultSelectedMCPToolNames,
			persistInitialMCPToolSelection: !this.#hasExistingSession,
			defaultSelectedMCPServerNames: Array.from(this.#discoveryDefaultServers),
			ttsrManager: this.#ttsrManager,
			obfuscator: secretRuntime.obfuscator,
			secretRuntime: secretRuntime.lease,
			leaseSecretRuntime: () => secretRuntime.acquire(),
			resolveSecretRuntimeLeaseForContext: context => hooks.requestLeases.forContext(context),
			refreshSecretRuntime: runtimeCwd => secretRuntime.refresh(runtimeCwd),
			argot: this.#argot,
			agentId: this.#identity.id,
			agentKind: this.#identity.kind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource: this.#providerPromptCache.source,
			parentEvalSessionId: options.parentEvalSessionId,
			loadAdvisorTools: () => buildAdvisorTools(this.#tools.advisorToolSession),
			titleSystemPrompt: options.titleSystemPrompt,
		});
		this.#session = session;
		return session;
	}

	/**
	 * Record the session's start: the secret runtime's session, the launch card reading of a top-level
	 * session, the launch project's shorthand, and a new session's start entries. The launch card reading
	 * builds every tool's schema, so the session takes it when it leaves rest; a spawned agent records
	 * none.
	 */
	#recordSessionStart(session: AgentSession): void {
		const settings = this.#settings;
		const isMainAgent = this.#identity.kind === "main";
		this.#secretRuntime.attachSession(session);
		if (isMainAgent) deferAtRestReading(session, () => recordAtRestLaunch(session, settings));
		armLaunchArgot({
			argot: this.#argot,
			enabled: this.#argotEnabled,
			settings,
			cwd: this.#cwd,
			sessionManager: this.#sessionManager,
			refreshPrompt: () => session.refreshBaseSystemPrompt("argot-arm"),
		});
		if (!this.#hasExistingSession) {
			recordNewSessionStart({
				sessionManager: this.#sessionManager,
				settings,
				isMainAgent,
				systemPrompt: session.agent.state.systemPrompt,
				activeToolNames: session.getActiveToolNames(),
			});
		}
	}

	/** Register the session's yield queues, attach it to its registry ref, and order its disposal. */
	#attachSession(session: AgentSession): void {
		const jobs = this.#asyncJobManager;
		if (jobs) {
			session.yieldQueue.register<AsyncResultEntry>("async-result", {
				isStale: entry => jobs.isDeliverySuppressed(entry.jobId),
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
		// Attach the live session to the pre-registered ref so peers can route IRC messages here, with
		// the session file refreshed in case it did not exist at registration. Every agent's turns keep
		// its roster row current, the driving session's included, so the Agent Control Center does not
		// age a mid-turn session from process start. The status is left alone: the bus routes an incoming
		// message by it, and flipping the operator's own session to idle between turns would change how a
		// peer reaches it.
		const agentId = this.#identity.id;
		this.#agentRegistry.attachSession(agentId, session, this.#sessionManager.getSessionFile() ?? null);
		session.subscribe(event => {
			if (event.type === "agent_start" || event.type === "agent_end") {
				this.#agentRegistry.noteTurn(agentId);
			}
		});
		orderSessionDisposal(session, {
			topLevel: this.#identity.kind === "main",
			finalize: () => this.#finalize(),
		});
	}

	/**
	 * Flush the secret audit log, then release what the session's startup attached. The expansion log
	 * queues its appends so a tool call never blocks on a write, and quitting the TUI ends the process
	 * rather than waiting for pending work, so an exit that does not flush loses the last records
	 * silently: the last credential an agent used is the one an incident asks about. Left attached, a
	 * notice sink keeps a disposed `OperatorNotices` reachable and posts later faults into a channel
	 * nothing renders, one more per session in a process that opens sessions in sequence.
	 */
	async #finalize(): Promise<void> {
		try {
			await this.#secretRuntime.flushAuditLog();
		} finally {
			this.#detachNoticeSinks();
			this.#unregisterUnlessParked();
			this.#credentialDisabled.dispose();
		}
	}

	/**
	 * Start the work that runs beside the session: the Codex transport prewarm, language server warmup,
	 * memory hydration, auto-learn, and MCP change routing and deferred discovery. Returns the language
	 * servers the session lists.
	 */
	async #startBackgroundWork(session: AgentSession): Promise<CreateAgentSessionResult["lspServers"]> {
		const options = this.#options;
		const settings = this.#settings;
		prewarmCodexTransport({
			model: this.#modelSelection.model,
			modelRegistry: this.#modelRegistry,
			sessionId: this.#providerSessionId,
			preferWebsockets: this.#preferWebsockets,
			providerSessionState: session.providerSessionState,
		});
		// A print or script invocation (no UI) lists no language servers: it draws no warmup status and
		// usually finishes before a server stabilizes. The lsp barrel is imported lazily because it pulls
		// the client and config machinery, which stays off the boot path.
		const lspServers =
			this.#enableLsp && options.hasUI
				? startLspServers(await import("./lsp"), { cwd: this.#cwd, settings, eventBus: this.#eventBus })
				: undefined;
		await yieldToEventLoop();
		deferMemoryStartup({
			session,
			settings,
			modelRegistry: this.#modelRegistry,
			agentDir: this.#agentDir,
			taskDepth: this.#taskDepth,
			options,
		});
		// Auto-learn is a session-start decision, matching the tools: `createTools` builds the `learn`
		// and `manage_skill` registry once, so a controller installed while disabled would let a
		// mid-session enable nudge toward tools the session never built. The fire-time re-check in
		// `#onAgentEnd` handles a mid-session disable. The listener retains the controller.
		if (settings.get("autolearn.enabled") && this.#taskDepth === 0) {
			new AutoLearnController({ session, settings });
		}
		this.#startMCP(session);
		return lspServers;
	}

	/**
	 * Route a created MCP manager's changes to the session for reactive tool updates, and connect a
	 * deferred manager's servers. A manager handed down by a parent keeps the parent's callbacks.
	 */
	#startMCP(session: AgentSession): void {
		const mcp = this.#mcp;
		const toolDiscovery = this.#toolDiscovery;
		if (this.#createdMcpManager) {
			wireReactiveMCPManager({
				manager: this.#createdMcpManager,
				session,
				settings: this.#settings,
				refreshTools: tools => toolDiscovery.refreshMCPTools(session, tools, mcp.deferred),
			});
		}
		mcp.startDeferred?.(
			session,
			{
				mcpDiscoveryEnabled: toolDiscovery.enabled,
				explicitlyRequestedMCPToolNames: this.#initialTools.explicitlyRequestedMCPToolNames,
				activateAllMCPTools: !toolDiscovery.enabled,
			},
			(liveSession, tools) => toolDiscovery.enableForMCPTools(liveSession, tools),
		);
	}
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
	registerSshCleanup();
	const startup = await SessionStartup.begin(options);
	try {
		return await startup.run();
	} catch (error) {
		await startup.abandon();
		throw error;
	}
}
