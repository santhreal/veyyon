import * as path from "node:path";
import { type Agent, type AgentMessage, EventLoopKeepalive, ThinkingLevel } from "@veyyon/agent-core";
import type { CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Usage, UsageReport } from "@veyyon/ai";
import type {
	AutocompleteProvider,
	Component,
	EditorTheme,
	NativeScrollbackLiveRegion,
	SlashCommand,
} from "@veyyon/tui";
import {
	Container,
	clampLow,
	clearRenderCache,
	type Loader,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	TUI,
} from "@veyyon/tui";
import { isInsideTerminalMultiplexer } from "@veyyon/tui/terminal-capabilities";
import { errorMessage, getProjectDir, logger, postmortem } from "@veyyon/utils";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { KeybindingsManager } from "../config/keybindings";
import {
	isSettingsInitialized,
	onStatusLineSessionAccentChanged,
	type QuarantinedSettingsFile,
	Settings,
	type SettingsSaveFailure,
	settings,
} from "../config/settings";
import type {
	AutocompleteProviderFactory,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
} from "../extensibility/extensions";
import type { CompactOptions } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import { loadSlashCommands } from "../extensibility/slash-commands";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import type { MCPManager } from "../mcp";
import { isMcpConnectionStatusEvent, MCP_CONNECTION_STATUS_EVENT_CHANNEL } from "../mcp/startup-events";
import type { PlanApprovalDetails } from "../plan-mode/approved-plan";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { type AgentSession, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { BackgroundSessions, type InteractiveSessionFactory, type KeptSession } from "../session/background-sessions";
import type { CompactMode } from "../session/compact-modes";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import { getRecentSessions } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { formatProviderName } from "../slash-commands/helpers/format";
import type { SubcommandDef } from "../slash-commands/types";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import type { LspStartupServerInfo } from "../tools";
import { hasForegroundBashWait, onForegroundBashWaitChange } from "../tools/bash-foreground-registry";
import type { TodoItem, TodoPhase } from "../tools/todo";
import type { EventBus } from "../utils/event-bus";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { messageHasDisplayableThinking } from "../utils/thinking-display";
import { pushTerminalTitle, setSessionTerminalTitle } from "../utils/title-generator";
import { VibeSessionRegistry } from "../vibe/runtime";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/chat-block";
import {
	COMPOSER_INSET_COLS,
	COMPOSER_PLACEHOLDER,
	ComposerHairline,
	mountComposerZone,
	QuietZoneLine,
	resolveComposerAccents,
} from "./components/composer-chrome";
import { buildComposerShortcuts, ComposerShortcutsBar } from "./components/composer-shortcuts";
import { CustomEditor } from "./components/custom-editor";
import { ErrorBannerComponent } from "./components/error-banner";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorSlider } from "./components/hook-selector";
import { modalRevealGround, pointerMotionEnabled } from "./components/modal-shell";
import { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import { BtwController } from "./controllers/btw-controller";
import { CommandController } from "./controllers/command-controller";
import { EventController } from "./controllers/event-controller";
import { ExtensionUiController } from "./controllers/extension-ui-controller";
import { HomeAnchorLayout } from "./controllers/home-anchor-layout";
import { InputController } from "./controllers/input-controller";
import { MCPCommandController } from "./controllers/mcp-command-controller";
import { OmfgController } from "./controllers/omfg-controller";
import { SelectorController } from "./controllers/selector-controller";
import { SessionFocusController } from "./controllers/session-focus-controller";
import { SSHCommandController } from "./controllers/ssh-command-controller";
import { TanCommandController } from "./controllers/tan-command-controller";
import { TodoCommandController } from "./controllers/todo-command-controller";
import { TranscriptComposer } from "./controllers/transcript-composer";
import { WelcomeController } from "./controllers/welcome-controller";
import { type FirstFrame, takeFirstFrame } from "./first-frame";
import {
	CommandDispatcher,
	EventHandlers,
	GoalModeController,
	LifecycleManager,
	PlanModeController,
	TodoBoardManager,
	WorkingLoaderManager,
} from "./interactive";
import type { LoopLimitRuntime } from "./loop-limit";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { countRunningSubagentBadgeAgents, getRunningSubagentBadgeRegistry } from "./running-subagent-badge";
import { SessionObserverRegistry } from "./session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { setDetectedTerminalGround } from "./theme/ground-tints";
import { setMarkdownMermaidRendering } from "./theme/markdown-theme";
import { clearMermaidCache } from "./theme/mermaid-cache";
import { getEditorTheme, onTerminalAppearanceChange, onThemeChange, type Theme, theme } from "./theme/theme";
import { consumeRelaunchMarker, flushPendingTtyInput } from "./tty-input-flush";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveSelectorDialogOptions,
	SubmittedUserInput,
} from "./types";
import { createSelectionAttemptNotice } from "./utils/selection-notice";
import { UiHelpers } from "./utils/ui-helpers";

export { ANCHORED_BLOCK_PADDING_X } from "./interactive/todo-board-manager";
export const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4;
const EDITOR_MIN_RENDERED_ROWS = 3;

export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = clampLow(rows - EDITOR_RESERVED_ROWS, EDITOR_MAX_HEIGHT_MIN, EDITOR_MAX_HEIGHT_MAX);
	return clampLow(comfortable, EDITOR_MIN_RENDERED_ROWS, rows - EDITOR_MIN_CHROME_ROWS);
}

class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;
	createNextSession?: InteractiveSessionFactory;

	ui: TUI;
	chatContainer: TranscriptContainer;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	todoContainer: Container;
	subagentContainer: Container;
	btwContainer: Container;
	omfgContainer: Container;
	errorBannerContainer: Container;
	modelCycleContainer: Container;
	editor: CustomEditor;
	editorContainer: Container;
	composerShortcuts: ComposerShortcutsBar;
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;
	composerHairline: ComposerHairline;
	capabilityLine: QuietZoneLine;

	isInitialized = false;
	initialChatRendered = false;
	isBashMode = false;
	toolOutputExpanded = false;
	todoExpanded = false;
	#vibeModeEnabled = false;
	#loopModeEnabled = false;
	#loopPrompt: string | undefined = undefined;
	#loopLimit: LoopLimitRuntime | undefined = undefined;
	#vibeModePreviousTools: string[] | undefined;

	hideThinkingBlock = false;
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentSession>();

	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}

	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}

	get effectiveHideThinkingBlock(): boolean {
		const thinkingOff = (this.viewSession?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
	}

	proseOnlyThinking = true;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
	settledToolCalls = new Set<string>();
	pendingBashComponents: BashExecutionComponent[] = [];
	bashComponent: BashExecutionComponent | undefined = undefined;
	pendingPythonComponents: EvalExecutionComponent[] = [];
	pythonComponent: EvalExecutionComponent | undefined = undefined;
	isPythonMode = false;
	streamingComponent: AssistantMessageComponent | undefined = undefined;
	streamingMessage: AssistantMessage | undefined = undefined;
	lastAssistantUsage: Usage | undefined = undefined;
	loadingAnimation: Loader | undefined = undefined;
	autoCompactionLoader: Loader | undefined = undefined;
	retryLoader: Loader | undefined = undefined;

	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;

	get optimisticUserMessageSignature(): string | undefined {
		return this.#transcriptComposer.optimisticSignature;
	}
	get locallySubmittedUserSignatures(): Set<string> {
		return this.#transcriptComposer.localEchoSignatures;
	}
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	get pendingSubmittedInput(): SubmittedUserInput | undefined {
		return this.#pendingSubmittedInput;
	}
	set pendingSubmittedInput(val: SubmittedUserInput | undefined) {
		this.#pendingSubmittedInput = val;
	}

	lastSigintTime = 0;
	lastEscapeTime = 0;
	lastLeftTapTime = 0;
	shutdownRequested = false;

	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput = new OAuthManualInputManager();
	todoPhases: TodoPhase[] = [];

	lspServers?: LspStartupServerInfo[];
	mcpManager?: MCPManager;
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;

	#version: string;
	#toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: (() => void)[] = [];
	get eventBusUnsubscribers(): (() => void)[] {
		return this.#eventBusUnsubscribers;
	}
	set eventBusUnsubscribers(val: (() => void)[]) {
		this.#eventBusUnsubscribers = val;
	}
	#agentRegistrySubscriptionTarget: unknown;
	get agentRegistrySubscriptionTarget(): unknown {
		return this.#agentRegistrySubscriptionTarget;
	}
	set agentRegistrySubscriptionTarget(val: unknown) {
		this.#agentRegistrySubscriptionTarget = val;
	}
	#agentRegistryUnsubscribe?: () => void;
	get agentRegistryUnsubscribe(): (() => void) | undefined {
		return this.#agentRegistryUnsubscribe;
	}
	set agentRegistryUnsubscribe(val: (() => void) | undefined) {
		this.#agentRegistryUnsubscribe = val;
	}
	#bashForegroundUnsubscribe?: () => void;
	get bashForegroundUnsubscribe(): (() => void) | undefined {
		return this.#bashForegroundUnsubscribe;
	}
	set bashForegroundUnsubscribe(val: (() => void) | undefined) {
		this.#bashForegroundUnsubscribe = val;
	}
	#backgroundSessionsUnsubscribe?: () => void;
	get backgroundSessionsUnsubscribe(): (() => void) | undefined {
		return this.#backgroundSessionsUnsubscribe;
	}
	set backgroundSessionsUnsubscribe(val: (() => void) | undefined) {
		this.#backgroundSessionsUnsubscribe = val;
	}
	#resizeHandler?: () => void;
	get resizeHandler(): (() => void) | undefined {
		return this.#resizeHandler;
	}
	set resizeHandler(val: (() => void) | undefined) {
		this.#resizeHandler = val;
	}
	#cleanupUnsubscribe?: () => void;
	get cleanupUnsubscribe(): (() => void) | undefined {
		return this.#cleanupUnsubscribe;
	}
	set cleanupUnsubscribe(val: (() => void) | undefined) {
		this.#cleanupUnsubscribe = val;
	}
	#signalTeardown?: SessionTeardown;
	get signalTeardown(): SessionTeardown | undefined {
		return this.#signalTeardown;
	}
	set signalTeardown(val: SessionTeardown | undefined) {
		this.#signalTeardown = val;
	}

	#baseAutocompleteProvider?: AutocompleteProvider;
	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#pendingSlashCommands: SlashCommand[] = [];

	readonly #btwController: BtwController;
	readonly #tanCommandController: TanCommandController;
	readonly #omfgController: OmfgController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #eventController: EventController;
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #focusController: SessionFocusController;
	readonly #welcomeController: WelcomeController;
	readonly #transcriptComposer: TranscriptComposer;
	readonly #layout: HomeAnchorLayout;
	readonly #observerRegistry: SessionObserverRegistry;
	readonly #uiHelpers: UiHelpers;

	readonly #workingLoaderManager: WorkingLoaderManager;
	readonly #todoBoardManager: TodoBoardManager;
	readonly #planModeController: PlanModeController;
	readonly #goalModeController: GoalModeController;
	readonly #lifecycleManager: LifecycleManager;
	readonly #commandDispatcher: CommandDispatcher;
	readonly #eventHandlers: EventHandlers;

	get workingLoaderManager(): WorkingLoaderManager {
		return this.#workingLoaderManager;
	}
	get todoBoardManager(): TodoBoardManager {
		return this.#todoBoardManager;
	}
	get planModeController(): PlanModeController {
		return this.#planModeController;
	}
	get goalModeController(): GoalModeController {
		return this.#goalModeController;
	}
	get lifecycleManager(): LifecycleManager {
		return this.#lifecycleManager;
	}
	get commandDispatcher(): CommandDispatcher {
		return this.#commandDispatcher;
	}
	get eventHandlers(): EventHandlers {
		return this.#eventHandlers;
	}

	get planModeEnabled(): boolean {
		return this.#planModeController.planModeEnabled;
	}
	set planModeEnabled(val: boolean) {
		this.#planModeController.planModeEnabled = val;
	}
	get planModePaused(): boolean {
		return this.#planModeController.planModePaused;
	}
	set planModePaused(val: boolean) {
		this.#planModeController.planModePaused = val;
	}
	get planModePlanFilePath(): string | undefined {
		return this.#planModeController.planModePlanFilePath;
	}
	set planModePlanFilePath(val: string | undefined) {
		this.#planModeController.planModePlanFilePath = val;
	}

	get goalModeEnabled(): boolean {
		return this.#goalModeController.goalModeEnabled;
	}
	set goalModeEnabled(val: boolean) {
		this.#goalModeController.goalModeEnabled = val;
	}
	get goalModePaused(): boolean {
		return this.#goalModeController.goalModePaused;
	}
	set goalModePaused(val: boolean) {
		this.#goalModeController.goalModePaused = val;
	}

	get vibeModeEnabled(): boolean {
		return this.#vibeModeEnabled;
	}
	set vibeModeEnabled(val: boolean) {
		this.#vibeModeEnabled = val;
	}
	get loopModeEnabled(): boolean {
		return this.#loopModeEnabled;
	}
	set loopModeEnabled(val: boolean) {
		this.#loopModeEnabled = val;
	}
	get loopPrompt(): string | undefined {
		return this.#loopPrompt;
	}
	set loopPrompt(val: string | undefined) {
		this.#loopPrompt = val;
	}
	get loopLimit(): LoopLimitRuntime | undefined {
		return this.#loopLimit;
	}
	set loopLimit(val: LoopLimitRuntime | undefined) {
		this.#loopLimit = val;
	}

	get isShuttingDown(): boolean {
		return this.#lifecycleManager.isShuttingDown;
	}

	get eventController(): EventController {
		return this.#eventController;
	}
	get eventBus(): EventBus | undefined {
		return this.#eventBus;
	}
	get viewSession(): AgentSession {
		return this.#focusController.target ?? this.session;
	}
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	get sessionName(): string | undefined {
		return this.session.sessionName;
	}
	get observerRegistry(): SessionObserverRegistry {
		return this.#observerRegistry;
	}
	get inputController(): InputController {
		return this.#inputController;
	}
	get extensionUiController(): ExtensionUiController {
		return this.#extensionUiController;
	}
	get selectorController(): SelectorController {
		return this.#selectorController;
	}
	get focusController(): SessionFocusController {
		return this.#focusController;
	}
	get btwController(): BtwController {
		return this.#btwController;
	}
	get omfgController(): OmfgController {
		return this.#omfgController;
	}
	get commandController(): CommandController {
		return this.#commandController;
	}

	focusAgentSession(id: string): Promise<void> {
		return this.#focusController.focusAgent(id);
	}
	focusParentSession(): Promise<void> {
		return this.#focusController.focusParent();
	}
	unfocusSession(): Promise<void> {
		return this.#focusController.unfocus();
	}
	clearTransientSessionUi(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.pendingMessagesContainer.clear();
		this.statusContainer.clear();
		this.todoContainer.clear();
		this.subagentContainer.clear();
		this.btwContainer.clear();
		this.omfgContainer.clear();
		this.errorBannerContainer.clear();
		this.modelCycleContainer.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.settledToolCalls.clear();
		this.pendingBashComponents = [];
		this.bashComponent = undefined;
		this.pendingPythonComponents = [];
		this.pythonComponent = undefined;
		this.isPythonMode = false;
	}

	readonly #chatHost: ChatBlockHost = {
		requestComponentRender: component => this.ui.requestComponentRender(component),
	};

	#startupInputGateRelease?: () => void;
	readonly #firstFrame: FirstFrame | undefined = takeFirstFrame();

	constructor(
		session: AgentSession,
		version: string,
		setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void = () => {},
		lspServers: LspStartupServerInfo[] | undefined = undefined,
		mcpManager?: MCPManager,
		eventBus?: EventBus,
	) {
		this.session = session;
		this.sessionManager = session.sessionManager;
		this.settings = session.settings;
		this.keybindings = KeybindingsManager.inMemory();
		this.agent = session.agent;
		this.#version = version;
		this.#toolUiContextSetter = setToolUIContext;
		this.lspServers = lspServers;
		this.mcpManager = mcpManager;
		this.#eventBus = eventBus;

		this.#workingLoaderManager = new WorkingLoaderManager(this);
		this.#todoBoardManager = new TodoBoardManager(this);
		this.#planModeController = new PlanModeController(this);
		this.#goalModeController = new GoalModeController(this);
		this.#lifecycleManager = new LifecycleManager(this);
		this.#commandDispatcher = new CommandDispatcher(this);
		this.#eventHandlers = new EventHandlers(this);

		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (this.settings.get("startup.quiet")) return;
					this.#eventHandlers.handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#eventHandlers.handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		setMarkdownMermaidRendering(settings.get("tui.renderMermaid"));
		this.ui = this.#firstFrame?.ui ?? new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
		this.ui.setScrollIsolation(settings.get("tui.scrollIsolation"));

		this.ui.onSelectionAttempt = createSelectionAttemptNotice(message => this.showStatus(message));
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.textSizing);
		this.chatContainer = new TranscriptContainer();
		this.#transcriptComposer = new TranscriptComposer({
			chatContainer: this.chatContainer,
			addMessageToChat: (message, options) => void this.addMessageToChat(message, options),
			renderSessionContext: context => this.renderSessionContext(context),
			buildTranscriptContext: () =>
				this.viewSession.buildTranscriptSessionContext({
					collapseCompactedHistory: settings.get("display.collapseCompacted"),
				}),
			isViewStreaming: () => this.viewSession?.isStreaming === true,
			streamingComponent: () => this.streamingComponent,
			pendingTools: this.pendingTools,
			isKnownSlashCommand: text => this.isKnownSlashCommand(text),
			pendingSubmission: () => this.#pendingSubmittedInput,
		});
		this.#layout = new HomeAnchorLayout({
			ui: this.ui,
			transcriptChildCount: () => this.chatContainer.children.length,
			hasHero: () => this.#welcomeController.hasHero,
		});
		this.#welcomeController = new WelcomeController({
			ui: this.ui,
			chatContainer: this.chatContainer,
			topFillRows: width => this.#layout.topFillRows(width),
			onHeroDismissed: removedRows => this.#layout.onHeroDismissed(removedRows),
			remeasureAnchor: () => this.#layout.sync(true),
		});
		this.pendingMessagesContainer = new AnchoredLiveContainer();
		this.statusContainer = new AnchoredLiveContainer();
		this.todoContainer = new AnchoredLiveContainer();
		this.subagentContainer = new AnchoredLiveContainer();
		this.btwContainer = new AnchoredLiveContainer();
		this.omfgContainer = new AnchoredLiveContainer();
		this.errorBannerContainer = new AnchoredLiveContainer();
		this.modelCycleContainer = new AnchoredLiveContainer();
		this.editor = new CustomEditor(getEditorTheme());
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		this.editor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		this.editor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#lendPopupMotion(this.editor);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.#layout.sync();
			this.ui.requestRender();
		};
		process.stdout.on("resize", this.#resizeHandler);
		this.ui.onFrameComposed = () => this.#layout.onFrameComposed();
		this.ui.onBeforeCompose = () => this.#layout.sync();
		try {
			this.historyStorage = HistoryStorage.open();
			this.editor.setHistoryStorage(this.historyStorage);
			this.historyStorage.setSessionResolver(() => this.sessionManager.getSessionId());
		} catch (error) {
			logger.warn("History storage unavailable", { error: String(error) });
		}
		this.hookWidgetContainerAbove = new Container();
		this.hookWidgetContainerAbove.addChild(new Spacer(1));
		this.hookWidgetContainerBelow = new Container();
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.#focusController = new SessionFocusController(this);
		this.composerShortcuts = new ComposerShortcutsBar();
		this.composerShortcuts.onChipClick = id => {
			if (id === "interrupt") this.editor.onEscape?.();
			else if (id === "background") this.editor.onBashBackground?.();
			else if (id === "dequeue") this.editor.onDequeue?.();
		};
		this.#refreshComposerShortcuts();
		this.#bashForegroundUnsubscribe = onForegroundBashWaitChange(() => this.#refreshComposerShortcuts());
		this.statusLine = new StatusLineComponent(session, { requestRender: () => this.ui.requestRender() });
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.statusLine.setBackgroundSessionCount(BackgroundSessions.global().size);
		this.#backgroundSessionsUnsubscribe = BackgroundSessions.global().subscribe(() => {
			this.statusLine.setBackgroundSessionCount(BackgroundSessions.global().size);
			this.ui.requestRender();
		});
		this.editor.setBorderVisible(false);
		this.editor.setPlaceholder(COMPOSER_PLACEHOLDER);
		this.composerHairline = new ComposerHairline();
		this.capabilityLine = new QuietZoneLine(width => this.#composerFootline(width), COMPOSER_INSET_COLS);
		this.capabilityLine.onClick = col => {
			const segmentId = this.statusLine.quietSegmentAt(col);
			if (segmentId === "mode" && (this.goalModeEnabled || this.goalModePaused)) {
				void this.openGoalDetail();
				return;
			}
			if (segmentId === "secrets") {
				this.showSecretList();
				return;
			}
			if (segmentId === "path" || segmentId === "git" || segmentId === "pr") {
				this.statusLine.togglePathExpanded(segmentId);
				this.ui.requestRender();
				return;
			}
			if (segmentId === "context_pct" || segmentId === "context_total") {
				this.handleContextCommand();
			}
		};

		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("proseOnlyThinking");
		this.toolOutputExpanded = settings.get("display.toolOutputExpanded");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
			category: "extensions",
		}));

		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
			category: "custom",
		}));

		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				skillCommandList.push({ name: commandName, description: skill.description, category: "skills" });
			}
		}

		const builtinCommands = buildTuiBuiltinSlashCommands({ ctx: this });
		this.#pendingSlashCommands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommandList];

		this.#uiHelpers = new UiHelpers(this);
		this.#btwController = new BtwController(this);
		this.#tanCommandController = new TanCommandController(this);
		this.#omfgController = new OmfgController(this);
		this.#extensionUiController = new ExtensionUiController(this);
		this.#eventController = new EventController(this);
		this.#commandController = new CommandController(this);
		this.#todoCommandController = new TodoCommandController(this);
		this.#selectorController = new SelectorController(this);
		this.#inputController = new InputController(this);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	#composerFootline(width: number): string | null {
		if (!settings.get("statusLine.enabled")) return this.statusLine.renderFocusBadge(width);
		return this.statusLine.renderQuietLine(width, { locationRight: this.#locationRightZone() });
	}

	#locationRightZone(): string | null {
		const draft = this.#draftTokenZone();
		const mcp = this.#mcpZoneText();
		if (draft !== null && mcp !== null) return `${draft}${theme.fg("dim", " · ")}${mcp}`;
		return draft ?? mcp;
	}

	#draftTokenZone(): string | null {
		const draft = this.editor.getText();
		const trimmed = draft.trim();
		if (trimmed.length === 0) return null;
		const tokens = Math.max(1, Math.ceil(trimmed.length / 4));
		return theme.fg("dim", `draft ~${tokens}t`);
	}

	#mcpZoneText(): string | null {
		const pending = this.#eventHandlers.mcpPendingServers.size;
		const failed = this.#eventHandlers.mcpFailedServers.size;
		if (pending > 0) {
			const label = pending === 1 ? "mcp connecting…" : `mcp connecting (${pending})…`;
			return theme.fg("dim", label);
		}
		if (failed > 0) {
			const label = failed === 1 ? "mcp: 1 failed" : `mcp: ${failed} failed`;
			return theme.fg("error", label);
		}
		return null;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());
		this.#refreshComposerShortcuts();

		this.#workingLoaderManager.startClockHeartbeat();

		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.editor.getText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			flushSettings: () => Settings.instance.flush(),
			disposeSession: reason =>
				this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS, reason }),
		});
		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		const modelName = this.session.model?.name ?? "";
		const providerName = this.session.model?.provider ?? "";

		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = settings.get("startup.quiet");
		this.#firstFrame?.release();

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		this.ui.addChild(this.#layout.topFill);
		if (!startupQuiet) {
			this.#welcomeController.mountHero(
				{ version: this.#version, modelName, providerName, recentSessions },
				this.#firstFrame?.hero,
			);
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.todoContainer);
		this.ui.addChild(this.subagentContainer);
		this.ui.addChild(this.btwContainer);
		this.ui.addChild(this.omfgContainer);
		this.ui.addChild(this.errorBannerContainer);
		this.ui.addChild(this.modelCycleContainer);
		this.ui.addChild(this.#layout.bottomFill);

		const composerZoneChildren = mountComposerZone(this.ui, {
			statusContainer: this.statusContainer,
			statusLine: this.statusLine,
			hookWidgetsAbove: this.hookWidgetContainerAbove,
			hairline: this.composerHairline,
			editorContainer: this.editorContainer,
			capabilityLine: this.capabilityLine,
			shortcuts: this.composerShortcuts,
			hookWidgetsBelow: this.hookWidgetContainerBelow,
		});
		this.ui.setPinnedFooterChildCount(composerZoneChildren);
		this.ui.setFocus(this.editor);
		this.#layout.seedAfterMount();

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#eventHandlers.scheduleObserverUiSync(kind);
		});

		this.#todoBoardManager.syncTodoSurfaceToView();

		if (this.#firstFrame) {
			const typedAtCard = this.#firstFrame.releaseInput();
			if (typedAtCard) this.editor.insertText(typedAtCard);
		} else {
			consumeRelaunchMarker();
			const flushed = flushPendingTtyInput();
			this.#startupInputGateRelease ??= this.ui.addInputListener(data =>
				matchesKey(data, "ctrl+c") ? undefined : { consume: true },
			);
			this.ui.start({ clearScrollback: this.settings.get("startup.clearScrollback") });
			setImmediate(() => {
				this.#startupInputGateRelease?.();
				this.#startupInputGateRelease = undefined;
			});
			if (!flushed) {
				logger.debug("No tty input flush available at startup; discarding buffered input until mount completes");
			}
		}

		this.#layout.sync();
		if (this.#layout.bottomFill.render(this.ui.terminal.columns).length > 0) this.ui.requestRender();
		pushTerminalTitle();
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();
		this.#eventBusUnsubscribers.push(
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.#handleSessionAccentInputsChanged();
			}),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		await this.initHooksAndCustomTools();

		this.session.setSessionSwitchReconciler?.(() => this.#reconcileModeFromSession({ preserveActiveGoal: true }));
		await this.#reconcileModeFromSession();

		const hasConversationContext = this.sessionManager.buildSessionContext().messages.length > 0;
		const hasExplicitMode = this.sessionManager.getEntries().some(entry => entry.type === "mode_change");
		const isFreshSession = !hasConversationContext && !hasExplicitMode;
		if (
			isFreshSession &&
			this.session.settings.get("plan.defaultOnStartup") &&
			this.session.settings.get("plan.enabled")
		) {
			await this.#planModeController.enterPlanMode();
		}

		try {
			const draft = await this.sessionManager.consumeDraft();
			if (draft && !this.editor.getText()) {
				this.editor.setText(draft);
				this.updateEditorBorderColor();
				this.ui.requestRender();
			}
		} catch (err) {
			logger.warn("Failed to restore session draft", { error: String(err) });
		}

		this.#subscribeToAgent();
		this.#subscribeToGoalSessionEvents();

		this.#eventBusUnsubscribers.push(
			() => {
				this.#goalUnsubscribe?.();
				this.#goalUnsubscribe = undefined;
			},
			onStatusLineSessionAccentChanged(() => {
				this.#syncStatusLineSettings();
				this.#handleSessionAccentInputsChanged();
			}),
			this.session.modelRegistry.authStorage.onCredentialFailover(event => {
				this.showWarning(
					`${formatProviderName(event.provider)}: ${event.from.label} could not authenticate (${event.cause}), now using ${event.to.label}`,
				);
			}),
			this.session.modelRegistry.authStorage.onUsageLimitWithheld(event => {
				const returnsAt = new Date(event.retryAtMs).toLocaleTimeString();
				const idle = event.idleSiblings === 1 ? "1 other account is" : `${event.idleSiblings} other accounts are`;
				this.showWarning(
					`${formatProviderName(event.provider)}: ${event.account.label} is out of quota until ${returnsAt}. ${idle} idle; turn on Account Load Balancing in /settings (Providers) to use them.`,
				);
			}),
		);
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				this.#workingLoaderManager.clearWorkingMessageAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					this.ui.requestRender();
					return;
				}
				this.ui.requestRender(true, { clearScrollback: this.settings.get("startup.clearScrollback") });
				this.#lifecycleManager.applyPaintGround();
			}),
		);

		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		this.ui.terminal.onBackgroundColorChange?.(hex => {
			this.#lifecycleManager.applyPaintGround();
			setDetectedTerminalGround(hex);
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});
		setDetectedTerminalGround(this.ui.terminal.backgroundColor);
		this.#lifecycleManager.applyPaintGround();

		this.#applyAutocompleteProvider();
	}

	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		const resolved = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		this.session.setTitleSystemPrompt(resolved);
	}

	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));

		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
			category: "custom",
		}));

		const reservedNames = new Set<string>();
		for (const command of this.#pendingSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}
		for (const command of fileSlashCommands) {
			reservedNames.add(command.name);
			for (const alias of command.aliases ?? []) reservedNames.add(alias);
		}

		const promptTemplateCommands: SlashCommand[] = this.session.promptTemplates
			.filter(template => !reservedNames.has(template.name))
			.map(template => ({
				name: template.name,
				description: template.description,
				category: "custom",
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			this.#pendingSlashCommands.concat(fileSlashCommands, promptTemplateCommands),
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	#applyAutocompleteProvider(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteProviderFactories) {
			const wrapped = factory(provider);
			if (
				wrapped &&
				typeof wrapped === "object" &&
				typeof (wrapped as AutocompleteProvider).getSuggestions === "function"
			) {
				provider = wrapped as AutocompleteProvider;
			}
		}
		this.editor.setAutocompleteProvider(provider);
	}

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	async applyCwdChange(newCwd: string): Promise<void> {
		await this.session.rescopeToCwd(newCwd);
		await this.refreshTitleSystemPrompt(newCwd);
		await this.refreshSlashCommandState(newCwd);
		this.statusLine.invalidate();
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#goalModeController.exitGoalMode({ reason: "completed", silent: true });
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#commandDispatcher.scheduleLoopAutoSubmit();
		this.#goalModeController.scheduleGoalContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		return this.#transcriptComposer.recordLocalSubmission(text, imageCount);
	}

	async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
		const release = this.recordLocalSubmission(text, options?.imageCount ?? 0);
		try {
			return await fn();
		} catch (error) {
			release();
			throw error;
		}
	}
	clearOptimisticUserMessage(): void {
		this.#transcriptComposer.clearOptimistic();
	}

	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void {
		this.#transcriptComposer.replaceOptimistic(message, options);
	}

	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		imageLinks?: (string | undefined)[];
		customType?: string;
		display?: boolean;
		streamingBehavior?: "steer" | "followUp";
	}): SubmittedUserInput {
		const submission: SubmittedUserInput = {
			text: input.text,
			images: input.images,
			imageLinks: input.imageLinks,
			customType: input.customType,
			display: input.display,
			streamingBehavior: input.streamingBehavior,
			cancelled: false,
			started: false,
		};
		this.#pendingSubmittedInput = submission;
		if (!submission.customType) {
			this.#goalModeController.goalUserTurnInFlight = true;
			this.#goalModeController.goalUserContinuationSuppressed = true;
			this.#goalModeController.cancelGoalContinuation();
			this.#transcriptComposer.showOptimistic(submission);
		} else {
			this.#transcriptComposer.clearOptimistic();
		}
		this.editor.setText("");
		this.editor.imageLinks = undefined;
		this.ensureLoadingAnimation();
		this.#layout.sync(true);
		this.ui.requestRender();
		return submission;
	}

	cancelPendingSubmission(): boolean {
		const submission = this.#pendingSubmittedInput;
		if (!submission || submission.started) {
			return false;
		}

		submission.cancelled = true;
		this.#pendingSubmittedInput = undefined;
		this.clearOptimisticUserMessage();
		if (submission.customType === "goal-continuation") {
			this.#goalModeController.goalContinuationTurnInFlight = false;
		}
		if (this.loadingAnimation) {
			this.#workingLoaderManager.stopLoadingAnimation(true);
		}
		if (!submission.customType) {
			this.editor.pendingImages = submission.images ? submission.images.slice() : [];
			this.editor.pendingImageLinks = submission.imageLinks ? submission.imageLinks.slice() : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.rebuildChatFromMessages();
			this.#goalModeController.resetGoalContinuationSuppression();
			this.#goalModeController.goalUserTurnInFlight = false;
			this.#goalModeController.scheduleGoalContinuation();
			this.editor.setText(submission.text);
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
		return true;
	}

	markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
		if (this.#pendingSubmittedInput !== input || input.cancelled) {
			return false;
		}
		input.started = true;
		return true;
	}

	finishPendingSubmission(input: SubmittedUserInput): void {
		const wasPendingSubmission = this.#pendingSubmittedInput === input;
		if (wasPendingSubmission) {
			this.#pendingSubmittedInput = undefined;
		}
		if (input.customType === "goal-continuation") {
			this.#goalModeController.goalContinuationTurnInFlight = false;
		}

		const quiesced = !this.session.isStreaming && !this.streamingComponent;
		this.#transcriptComposer.onSubmissionFinished({ owned: wasPendingSubmission, quiesced });
		if (wasPendingSubmission && quiesced) {
			if (this.loadingAnimation) {
				this.#workingLoaderManager.stopLoadingAnimation(true);
			}
		}
	}

	#computeEditorMaxHeight(): number {
		return computeEditorMaxHeight(this.ui.terminal.rows);
	}

	#syncEditorMaxHeight(): void {
		this.editor.setMaxHeight(this.#computeEditorMaxHeight());
	}

	#syncStatusLineSettings(): void {
		this.statusLine.updateSettings({
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			segmentOptions: settings.get("statusLine.segmentOptions"),
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
		});
	}

	#handleSessionAccentInputsChanged(): void {
		this.#workingLoaderManager.clearWorkingMessageAccentCache();
		this.statusLine.invalidate();
		this.updateEditorBorderColor();
	}

	updateEditorBorderColor(): void {
		const accentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		const sessionName = accentEnabled ? this.sessionManager.getSessionName() : undefined;
		const hex = sessionName
			? getSessionAccentHex(sessionName, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance)
			: undefined;
		const accents = resolveComposerAccents({
			bypass: this.session.isApprovalBypassed(),
			bashMode: this.isBashMode,
			pythonMode: this.isPythonMode,
			planMode: this.planModeEnabled && !this.planModePaused,
			focusedSubagent: this.focusedAgentId !== undefined,
			sessionAccentAnsi: getSessionAccentAnsi(hex),
			thinkingLevel: this.session.thinkingLevel ?? ThinkingLevel.Off,
		});
		this.editor.borderColor = accents.borderColor;
		this.editor.setPromptGutter(accents.promptGutter);
		this.editor.setPromptGutterContinuation(accents.promptGutterContinuation);
		this.editor.setRowBackground(undefined);
		this.ui.requestRender();
	}

	syncRunningSubagentBadge(options: { requestRender?: boolean } = {}): void {
		const registry = getRunningSubagentBadgeRegistry(this.collabGuest);
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				this.syncRunningSubagentBadge();
			});
		}
		const count = countRunningSubagentBadgeAgents(
			registry,
			this.collabGuest ? undefined : this.sessionManager.getSessionId(),
			this.focusedAgentId,
		);
		this.statusLine.setSubagentCount(count);
		if (options.requestRender !== false) this.ui.requestRender();
	}

	rebuildChatFromMessages(): void {
		this.#transcriptComposer.rebuild();
	}

	async #clearTransientModeState(): Promise<void> {
		if (this.planModeEnabled || this.planModePaused) {
			await this.#planModeController.exitPlanMode({ silent: true });
		}

		if (this.goalModeEnabled || this.goalModePaused) {
			await this.#goalModeController.exitGoalMode({ silent: true });
		}

		if (this.vibeModeEnabled) {
			await this.session.deactivateVibeTools(this.#vibeModePreviousTools ?? []);
			this.session.setVibeModeState(undefined);
			this.#vibeModeEnabled = false;
			this.#vibeModePreviousTools = undefined;
			await VibeSessionRegistry.global().killAll(
				this.session.getAgentId() ?? MAIN_AGENT_ID,
				this.session.asyncJobManager,
			);
			this.#commandDispatcher.updateVibeModeStatus();
		}
	}

	async #reconcileModeFromSession(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		await this.#clearTransientModeState();
		const sessionContext = this.sessionManager.buildSessionContext();
		const goalEnabled = this.session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			this.session.goalRuntime.clearAccounting();
			const stored = this.#goalModeController.goalFromModeData(sessionContext.modeData);
			logger.warn("goal mode is disabled; the session's stored goal stays inactive", {
				mode: sessionContext.mode,
				readable: stored !== undefined,
				goalId: stored?.id,
			});
			this.showWarning(
				stored
					? `Goal Mode is off in settings, so "${this.#goalModeController.goalSummary(stored.objective)}" stays stored and inactive.`
					: "Goal Mode is off in settings, so this session's stored goal stays inactive.",
			);
			return;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = this.#goalModeController.goalFromModeData(sessionContext.modeData);
			if (!goal) {
				logger.warn("stored goal record is unreadable; clearing goal mode", { mode: sessionContext.mode });
				this.showWarning("This session's stored goal could not be read and was cleared.");
				this.sessionManager.appendModeChange("none");
				return;
			}
			this.session.setGoalModeState({
				enabled: sessionContext.mode === "goal",
				mode: "active",
				goal,
			});
			const restored = await this.session.goalRuntime.onThreadResumed({
				preserveActiveGoal: options?.preserveActiveGoal,
			});
			this.goalModeEnabled = restored?.enabled === true;
			this.goalModePaused = restored?.enabled !== true && restored?.goal.status === "paused";
			if (restored?.goal) {
				const previousTools = this.session.getActiveToolNames();
				const goalTools = new Set(previousTools);
				goalTools.add("goal");
				await this.session.setActiveToolsByName(Array.from(goalTools));
			}
			this.#goalModeController.updateGoalModeStatus();
			return;
		}
		this.session.goalRuntime.clearAccounting();
		if (sessionContext.mode === "vibe") {
			await this.#commandDispatcher.enterVibeMode();
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused") {
				this.sessionManager.appendModeChange("none");
			}
			return;
		}
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.#planModeController.enterPlanMode({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeController.planModeHasEntered = true;
			this.#planModeController.updatePlanModeStatus();
		}
	}

	showPlanReview(
		planContent: string,
		title: string,
		options: string[],
		dialogOptions?: {
			helpText?: string;
			disabledIndices?: number[];
			onExternalEditor?: () => void;
			onPlanEdited?: (content: string) => void;
			onFeedbackChange?: (feedback: string) => void;
			initialIndex?: number;
		},
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#planModeController.showPlanReview(planContent, title, options, dialogOptions, extra);
	}

	handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		return this.#planModeController.handlePlanModeCommand(initialPrompt);
	}

	handleVibeModeCommand(initialPrompt?: string): Promise<void> {
		return this.#commandDispatcher.handleVibeModeCommand(initialPrompt);
	}

	handleGoalModeCommand(rest?: string): Promise<void> {
		return this.#goalModeController.handleGoalModeCommand(rest);
	}

	handleGuidedGoalCommand(rest?: string): Promise<void> {
		return this.#goalModeController.handleGuidedGoalCommand(rest);
	}

	openGoalDetail(): Promise<void> {
		return this.#goalModeController.openGoalDetail();
	}

	openPlanReview(): Promise<void> {
		return this.#planModeController.openPlanReview();
	}

	handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		return this.#planModeController.handlePlanApproval(details);
	}

	flushPendingModelSwitch(): Promise<void> {
		return this.#planModeController.flushPendingModelSwitch();
	}

	stop(): void {
		this.#lifecycleManager.stop();
	}

	shutdown(): Promise<void> {
		return this.#lifecycleManager.shutdown();
	}

	requestRelaunch(spec: { argv: string[]; env?: Record<string, string | undefined> }): void {
		this.#lifecycleManager.requestRelaunch(spec);
	}

	checkShutdownRequested(): Promise<void> {
		return this.#lifecycleManager.checkShutdownRequested();
	}

	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#toolUiContextSetter(uiContext, hasUI);
	}

	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#extensionUiController.initializeHookRunner(uiContext, hasUI);
	}

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const previousEditor = this.editor;
		const previousText = previousEditor.getText();
		const nextEditor = factory
			? factory(this.ui, getEditorTheme(), this.keybindings)
			: new CustomEditor(getEditorTheme());

		nextEditor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		nextEditor.setAutocompleteMaxVisible(this.settings.get("autocompleteMaxVisible"));
		nextEditor.onAutocompleteCancel = () => {
			this.ui.requestRender(true);
		};
		nextEditor.onAutocompleteUpdate = () => {
			this.ui.requestRender();
		};
		this.#lendPopupMotion(nextEditor);
		previousEditor.disposeAutocompleteMotion();
		nextEditor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		nextEditor.setBorderVisible(false);
		nextEditor.setPlaceholder(COMPOSER_PLACEHOLDER);
		nextEditor.setMaxHeight(this.#computeEditorMaxHeight());
		if (this.historyStorage) {
			nextEditor.setHistoryStorage(this.historyStorage);
		}
		nextEditor.setText(previousText);

		this.editorContainer.clear();
		this.editor = nextEditor;
		this.editorContainer.addChild(nextEditor);
		this.ui.setFocus(nextEditor);

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		void this.refreshSlashCommandState().catch(error => {
			logger.warn("Failed to refresh slash command state for custom editor", { error: String(error) });
		});

		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	#lendPopupMotion(editor: CustomEditor): void {
		editor.setAutocompleteMotion({
			requestRender: () => this.ui.requestRender(),
			enabled: pointerMotionEnabled(),
			ground: modalRevealGround(),
		});
	}

	present(content: Component | readonly Component[]): void {
		if (Array.isArray(content)) {
			for (const item of content) this.#mountChatChild(item);
		} else {
			this.#mountChatChild(content as Component);
		}
		this.ui.requestRender();
	}

	#mountChatChild(item: Component): void {
		this.chatContainer.addChild(item);
		if (item instanceof ChatBlock) {
			item.mount(this.#chatHost);
		}
		this.#layout.sync();
	}

	resetTranscript(): void {
		this.chatContainer.dispose();
		this.chatContainer.clear();
	}

	showStatus(message: string, options?: { dim?: boolean }): void {
		this.#uiHelpers.showStatus(message, options);
	}

	showError(message: string): void {
		this.#pendingSubmittedInput = undefined;
		this.clearOptimisticUserMessage();
		if (this.loadingAnimation) {
			this.#workingLoaderManager.stopLoadingAnimation(true);
		}
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
		this.#planModeController.dismissPlanReview();
		this.errorBannerContainer.clear();
		this.errorBannerContainer.addChild(new ErrorBannerComponent(message));
		this.ui.requestRender();
	}

	clearPinnedError(): void {
		if (this.errorBannerContainer.children.length === 0) return;
		this.errorBannerContainer.clear();
		this.ui.requestRender();
	}

	showWarning(message: string): void {
		this.#uiHelpers.showWarning(message);
	}

	ensureLoadingAnimation(): void {
		this.#workingLoaderManager.ensureLoadingAnimation();
	}

	clearWorkingLoader(): boolean {
		return this.#workingLoaderManager.clearWorkingLoader();
	}

	setWorkingMessage(message?: string): void {
		this.#workingLoaderManager.setWorkingMessage(message);
	}

	applyPendingWorkingMessage(): void {
		this.#workingLoaderManager.applyPendingWorkingMessage();
	}

	showUpdateReadyNotification(newVersion: string, warnings?: readonly string[]): void {
		this.#uiHelpers.showUpdateReadyNotification(newVersion, warnings);
	}

	showUpdateFailedNotification(newVersion: string, error: string): void {
		this.#uiHelpers.showUpdateFailedNotification(newVersion, error);
	}

	showNewVersionNotification(newVersion: string): void {
		this.#uiHelpers.showNewVersionNotification(newVersion);
	}

	showPluginUpdatesNotification(count: number): void {
		this.#uiHelpers.showPluginUpdatesNotification(count);
	}

	showPluginUpdatesInstalledNotification(count: number): void {
		this.#uiHelpers.showPluginUpdatesInstalledNotification(count);
	}

	showUnparseableSettingsNotification(files: readonly QuarantinedSettingsFile[]): void {
		this.#uiHelpers.showUnparseableSettingsNotification(files);
	}

	showSettingsSaveFailureNotification(failure: SettingsSaveFailure): void {
		this.#uiHelpers.showSettingsSaveFailureNotification(failure);
	}

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	refreshComposerShortcuts(): void {
		this.#refreshComposerShortcuts();
	}

	#refreshComposerShortcuts(): void {
		this.composerShortcuts.setShortcuts(
			buildComposerShortcuts(this.keybindings, {
				busy: this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork,
				hasDraft: this.editor.getText().trim().length > 0,
				hasQueue: this.session.queuedMessageCount > 0,
				focused: this.focusedAgentId !== undefined,
				canBackgroundBash: hasForegroundBashWait(),
			}),
		);
		this.ui.requestComponentRender(this.composerShortcuts);
	}

	dismissWelcome(): void {
		this.#welcomeController.dismiss();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.compactionQueuedMessages.push({ text, mode, images });
	}

	async flushCompactionQueue(_options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) return;
		const queued = this.compactionQueuedMessages.slice();
		this.compactionQueuedMessages = [];
		for (const item of queued) {
			if (item.mode === "steer") {
				await this.session.steer(item.text, item.images);
			} else {
				await this.session.followUp(item.text, item.images);
			}
		}
	}

	flushPendingBashComponents(): void {
		this.#uiHelpers.flushPendingBashComponents();
	}

	isKnownSlashCommand(text: string): boolean {
		return this.#uiHelpers.isKnownSlashCommand(text);
	}

	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[] {
		return this.#uiHelpers.addMessageToChat(message, options);
	}

	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void {
		for (const message of sessionContext.messages) {
			this.noteDisplayableThinkingContent(message);
		}
		this.#uiHelpers.renderSessionContext(sessionContext, options);
	}

	renderInitialMessages(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): void {
		this.#uiHelpers.renderInitialMessages(options);
	}

	getUserMessageText(message: Message): string {
		return this.#uiHelpers.getUserMessageText(message);
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		return this.#uiHelpers.findLastAssistantMessage();
	}

	extractAssistantText(message: AssistantMessage): string {
		return this.#uiHelpers.extractAssistantText(message);
	}

	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	handleDumpCommand(): Promise<void> {
		return this.#commandController.handleDumpCommand();
	}

	handleAdvisorDumpCommand(isRaw?: boolean): void {
		this.#commandController.handleAdvisorDumpCommand(isRaw);
	}

	handleDebugTranscriptCommand(): Promise<void> {
		return this.#commandController.handleDebugTranscriptCommand();
	}

	handleShareCommand(): Promise<void> {
		return this.#commandController.handleShareCommand();
	}

	handleTodoCommand(args: string): Promise<void> {
		return this.#todoCommandController.handleTodoCommand(args);
	}

	handleSessionCommand(): Promise<void> {
		return this.#commandController.handleSessionCommand();
	}

	handleAdvisorStatusCommand(): Promise<void> {
		return this.#commandController.handleAdvisorStatusCommand();
	}

	handleJobsCommand(): Promise<void> {
		return this.#commandController.handleJobsCommand();
	}

	handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		return this.#commandController.handleUsageCommand(reports);
	}

	handleChangelogCommand(): Promise<void> {
		return this.#commandController.handleChangelogCommand();
	}

	handleHotkeysCommand(): void {
		this.#commandController.handleHotkeysCommand();
	}

	handleToolsCommand(): void {
		this.#commandController.handleToolsCommand();
	}

	handleContextCommand(): void {
		this.#commandController.handleContextCommand();
	}

	#prepareSessionSwitch(): void {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.clearPinnedError();
		this.#planModeController.hidePlanReview();
	}

	handleClearCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleClearCommand();
	}

	handleFreshCommand(): Promise<void> {
		return this.#commandController.handleFreshCommand();
	}

	handleDropCommand(): Promise<void> {
		this.#prepareSessionSwitch();
		return this.#commandController.handleDropCommand();
	}

	handleForkCommand(): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		return this.#commandController.handleForkCommand();
	}

	handleMoveCommand(targetPath?: string): Promise<void> {
		return this.#commandController.handleMoveCommand(targetPath);
	}

	handleRenameCommand(title: string): Promise<void> {
		return this.#commandController.handleRenameCommand(title);
	}

	handleMemoryCommand(text: string): Promise<void> {
		return this.#commandController.handleMemoryCommand(text);
	}

	handleSTTToggle(): Promise<void> {
		return this.#commandDispatcher.handleSTTToggle();
	}

	showDebugSelector(): Promise<void> {
		return this.#selectorController.showDebugSelector();
	}

	resetObserverRegistry(): void {
		this.#observerRegistry.resetSessions();
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
	}

	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handleBashCommand(command, excludeFromContext);
	}

	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void> {
		return this.#commandController.handlePythonCommand(code, excludeFromContext);
	}

	async handleMCPCommand(text: string): Promise<void> {
		const controller = new MCPCommandController(this);
		await controller.handle(text);
	}

	async handleSSHCommand(text: string): Promise<void> {
		const controller = new SSHCommandController(this);
		await controller.handle(text);
	}

	handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome?: CompactionOutcome) => Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		return this.#commandController.handleCompactCommand(customInstructions, mode, beforeFlush, internalGuidance);
	}

	handleHandoffCommand(customInstructions?: string): Promise<void> {
		return this.#commandController.handleHandoffCommand(customInstructions);
	}

	handleShakeCommand(mode: ShakeMode): Promise<void> {
		return this.#commandController.handleShakeCommand(mode);
	}

	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome> {
		return this.#commandController.executeCompaction(customInstructionsOrOptions, isAuto);
	}

	openInBrowser(url: string): void {
		this.#commandController.openInBrowser(url);
	}

	focusActiveEditorArea(): void {
		this.#selectorController.focusActiveEditorArea();
	}

	async showFullWelcome(): Promise<void> {
		const recentSessions = await getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
			sessions.map(s => ({ name: s.name, timeAgo: s.timeAgo })),
		);
		this.#welcomeController.showFull({
			version: this.#version,
			modelName: this.session.model?.name ?? "",
			providerName: this.session.model?.provider ?? "",
			recentSessions,
		});
	}

	showSettingsSelector(initialItemId?: string): void {
		this.#selectorController.showSettingsSelector(initialItemId);
	}

	showAdvisorConfigure(): Promise<void> {
		return this.#selectorController.showAdvisorConfigure();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(options?: { requireContent?: boolean; processScope?: boolean }): void {
		this.#selectorController.showAgentsDashboard(this.#observerRegistry, options);
	}

	showSecretList(): void {
		this.#commandController.showSecretList();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showThinkingSelector(): void {
		this.#selectorController.showThinkingSelector();
	}

	showSubcommandPicker(
		commandName: string,
		subcommands: readonly SubcommandDef[],
		onSelect: (subcommand: SubcommandDef) => void,
	): void {
		this.#selectorController.showSubcommandPicker(commandName, subcommands, onSelect);
	}

	showPluginSelector(mode?: "install" | "uninstall"): void {
		void this.#selectorController.showPluginSelector(mode);
	}

	showUserMessageSelector(): void {
		this.#selectorController.showUserMessageSelector();
	}

	showCopySelector(): void {
		this.#selectorController.showCopySelector();
	}

	showTreeSelector(): void {
		this.#selectorController.showTreeSelector();
	}

	showSessionSelector(): void {
		void this.#selectorController.showSessionSelector();
	}

	handleResumeSession(targetSessionFile: string): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.resetObserverRegistry();
		return this.#selectorController.handleResumeSession(targetSessionFile);
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showAccountManager(providerId?: string): Promise<void> {
		return this.#selectorController.showAccountManager(providerId);
	}

	showLogin(providerId?: string): Promise<void> {
		return this.#selectorController.showLogin(providerId);
	}

	showLogout(providerId?: string): Promise<void> {
		return this.#selectorController.showLogout(providerId);
	}

	showResetUsageSelector(): Promise<void> {
		return this.#selectorController.showResetUsageSelector();
	}

	showProviderSetup(): Promise<void> {
		return runProviderSetupWizard(this);
	}

	showHookConfirm(title: string, message: string): Promise<boolean> {
		return this.#extensionUiController.showHookConfirm(title, message);
	}

	handleCtrlC(): void {
		this.#inputController.handleCtrlC();
	}

	handleCtrlD(): void {
		this.#inputController.handleCtrlD();
	}

	handleCtrlZ(): void {
		this.#inputController.handleCtrlZ();
	}

	handleDequeue(): void {
		this.#inputController.handleDequeue();
	}

	handleImagePaste(): Promise<boolean> {
		return this.#inputController.handleImagePaste();
	}

	handleQueueCommand(text: string): Promise<void> {
		return this.#inputController.handleQueueCommand(text);
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	handleTanCommand(topic = ""): Promise<void> {
		return this.#tanCommandController.start(topic);
	}

	hasActiveBtw(): boolean {
		return this.#btwController.hasActiveRequest();
	}

	handleBtwEscape(): boolean {
		return this.#btwController.handleEscape();
	}

	canBranchBtw(): boolean {
		return this.#btwController.canBranch();
	}

	handleBtwBranchKey(): Promise<boolean> {
		return this.#btwController.handleBranch();
	}

	canCopyBtw(): boolean {
		return this.#btwController.canCopy();
	}

	handleBtwCopyKey(): Promise<boolean> {
		return this.#btwController.handleCopy();
	}

	async handleBtwBranch(question: string, assistantMessage: AssistantMessage): Promise<void> {
		try {
			const result = await this.session.branchFromBtw(question, assistantMessage);
			if (result.cancelled) {
				this.showStatus("/btw branch cancelled", { dim: true });
				return;
			}
			this.#btwController.dispose();
			this.#omfgController.dispose();
			this.renderInitialMessages({ clearTerminalHistory: true });
			this.updateEditorBorderColor();
			this.showStatus(
				result.sessionFile ? `Branched /btw to ${path.basename(result.sessionFile)}` : "Branched /btw",
			);
		} catch (error) {
			this.showError(`Cannot branch /btw: ${errorMessage(error)}`);
		}
	}

	handleOmfgCommand(complaint: string): Promise<void> {
		return this.#omfgController.start(complaint);
	}

	hasActiveOmfg(): boolean {
		return this.#omfgController.hasActiveRequest();
	}

	handleOmfgEscape(): boolean {
		return this.#omfgController.handleEscape();
	}

	cycleThinkingLevel(): void {
		this.#inputController.cycleThinkingLevel();
	}

	cycleRoleModel(direction?: "forward" | "backward"): Promise<void> {
		return this.#inputController.cycleRoleModel(direction);
	}

	toggleToolOutputExpansion(): void {
		this.#inputController.toggleToolOutputExpansion();
	}

	setToolsExpanded(expanded: boolean): void {
		this.#inputController.setToolsExpanded(expanded);
	}

	toggleThinkingBlockVisibility(): void {
		this.#inputController.toggleThinkingBlockVisibility();
	}

	toggleTodoExpansion(): void {
		this.#todoBoardManager.toggleTodoExpansion();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		this.#todoBoardManager.setTodos(todos as TodoPhase[]);
	}

	reloadTodos(): Promise<void> {
		this.#todoBoardManager.reloadTodos();
		return Promise.resolve();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	initHooksAndCustomTools(): Promise<void> {
		return this.#extensionUiController.initHooksAndCustomTools();
	}

	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void> {
		return this.#extensionUiController.emitCustomToolSessionEvent(reason, previousSessionFile);
	}

	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		this.#extensionUiController.setHookWidget(key, content, options);
	}

	setHookStatus(key: string, text: string | undefined): void {
		this.#extensionUiController.setHookStatus(key, text);
	}

	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
		extra?: { slider?: HookSelectorSlider },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookSelector(title, options, dialogOptions, extra);
	}

	hideHookSelector(): void {
		this.#extensionUiController.hideHookSelector();
	}

	showAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		return this.#extensionUiController.showAskDialog(questions, dialogOptions);
	}

	showHookInput(
		title: string,
		placeholder?: string,
		inputOptions?: { mask?: string; hint?: string },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder, undefined, inputOptions);
	}

	hideHookInput(): void {
		this.#extensionUiController.hideHookInput();
	}

	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#extensionUiController.showHookEditor(title, prefill, dialogOptions, editorOptions);
	}

	hideHookEditor(): void {
		this.#extensionUiController.hideHookEditor();
	}

	showHookNotify(message: string, type?: "info" | "warning" | "error"): void {
		this.#extensionUiController.showHookNotify(message, type);
	}

	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T> {
		return this.#extensionUiController.showHookCustom(factory, options);
	}

	showExtensionError(extensionPath: string, error: string): void {
		this.#extensionUiController.showExtensionError(extensionPath, error);
	}

	showToolError(toolName: string, error: string): void {
		this.#extensionUiController.showToolError(toolName, error);
	}

	#subscribeToAgent(): void {
		this.#eventController.subscribeToAgent();
	}

	#goalUnsubscribe?: () => void;

	#subscribeToGoalSessionEvents(): void {
		this.#goalUnsubscribe = this.session.subscribe(event => {
			return this.#goalModeController.handleGoalSessionEvent(event).catch(error => {
				logger.warn("Goal mode session event handler failed", {
					event: event.type,
					error: errorMessage(error),
				});
				this.showWarning(`Goal mode update failed: ${errorMessage(error)}`);
			});
		});
	}

	attachMainSession(next: AgentSession): KeptSession {
		const previous = this.session;
		if (next === previous) return BackgroundSessions.global().describeAttached(previous);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.#goalUnsubscribe?.();
		this.#goalUnsubscribe = undefined;
		this.session = next;
		this.sessionManager = next.sessionManager;
		this.settings = next.settings;
		this.agent = next.agent;
		this.#eventController.resetTranscriptAnchors();
		this.#subscribeToAgent();
		this.#subscribeToGoalSessionEvents();
		this.statusLine.setSession(next);
		if (next.isStreaming) void this.#eventController.handleEvent({ type: "agent_start" });
		return BackgroundSessions.global().keep(previous);
	}

	handleLoopCommand(args = ""): Promise<string | undefined> {
		return this.#commandDispatcher.handleLoopCommand(args);
	}

	disableLoopMode(message?: string): void {
		this.#commandDispatcher.disableLoopMode(message);
	}

	pauseLoop(): void {
		this.#commandDispatcher.pauseLoop();
	}

	showModelCycleTrack(track: string): void {
		this.#eventHandlers.showModelCycleTrack(track);
	}
}
