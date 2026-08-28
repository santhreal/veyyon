import type { AgentMessage } from "@veyyon/agent-core";
import type { CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Usage, UsageReport } from "@veyyon/ai";
import type { Component, Container, EditorTheme, Loader, Spacer, Text, TUI } from "@veyyon/tui";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import type { KeybindingsManager } from "../config/keybindings";
import type { QuarantinedSettingsFile, Settings, SettingsSaveFailure } from "../config/settings";
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
import type { MCPManager } from "../mcp";
import type { PlanApprovalDetails } from "../plan-mode/approved-plan";
import type { AgentSession } from "../session/agent-session";
import type { InteractiveSessionFactory, KeptSession } from "../session/background-sessions";
import type { CompactMode } from "../session/compact-modes";
import type { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import type { SubcommandDef } from "../slash-commands/types";
import type { LspStartupServerInfo } from "../tools";
import type { EventBus } from "../utils/event-bus";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import type { CustomEditor } from "./components/custom-editor";
import type { EvalExecutionComponent } from "./components/eval-execution";
import type { HookEditorComponent } from "./components/hook-editor";
import type { HookInputComponent } from "./components/hook-input";
import type { HookSelectorComponent, HookSelectorOptions } from "./components/hook-selector";
import type { StatusLineComponent } from "./components/status-line";
import type { ToolExecutionHandle } from "./components/tool-execution";
import type { TranscriptContainer } from "./components/transcript-container";
import type { EventController } from "./controllers/event-controller";
import type { LoopLimitRuntime } from "./loop-limit";
import type { OAuthManualInputManager } from "./oauth-manual-input";
import type { Theme } from "./theme/theme";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

export type SubmittedUserInput = {
	text: string;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	customType?: string;
	synthetic?: boolean;
	userInitiated?: boolean;
	display?: boolean;
	streamingBehavior?: "steer" | "followUp";
	cancelled: boolean;
	started: boolean;
};

import type { TodoItem, TodoPhase } from "../tools/todo";

export type { TodoItem, TodoPhase, TodoStatus } from "../tools/todo";

export type InteractiveSelectorDialogOptions = ExtensionUIDialogOptions & Pick<HookSelectorOptions, "disabledIndices">;

export interface InteractiveModeUi {
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
	hookWidgetContainerAbove: Container;
	hookWidgetContainerBelow: Container;
	statusLine: StatusLineComponent;
}

export interface InteractiveModeSession {
	session: AgentSession;
	sessionManager: SessionManager;
	readonly sessionName: string | undefined;
	readonly viewSession: AgentSession;
	readonly focusedAgentId: string | undefined;
	focusAgentSession(id: string): Promise<void>;
	focusParentSession(): Promise<void>;
	unfocusSession(): Promise<void>;
	createNextSession?: InteractiveSessionFactory;
	attachMainSession(next: AgentSession): KeptSession;
	clearTransientSessionUi(): void;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: AgentSession["agent"];
	historyStorage?: HistoryStorage;
	mcpManager?: MCPManager;
	lspServers?: LspStartupServerInfo[];
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;
	eventController: EventController;
	eventBus?: EventBus;
}

export interface InteractiveModeState {
	isInitialized: boolean;
	initialChatRendered: boolean;
	isBashMode: boolean;
	toolOutputExpanded: boolean;
	todoExpanded: boolean;
	planModeEnabled: boolean;
	vibeModeEnabled: boolean;
	goalModeEnabled: boolean;
	goalModePaused: boolean;
	loopModeEnabled: boolean;
	loopPrompt?: string;
	loopLimit?: LoopLimitRuntime;
	planModePlanFilePath?: string;
	hideThinkingBlock: boolean;
	readonly effectiveHideThinkingBlock: boolean;
	readonly hasDisplayableThinkingContent: boolean;
	noteDisplayableThinkingContent(message: AgentMessage): boolean;
	proseOnlyThinking: boolean;
	compactionQueuedMessages: CompactionQueuedMessage[];
	pendingTools: Map<string, ToolExecutionHandle>;
	settledToolCalls: Set<string>;
	pendingBashComponents: BashExecutionComponent[];
	bashComponent: BashExecutionComponent | undefined;
	pendingPythonComponents: EvalExecutionComponent[];
	pythonComponent: EvalExecutionComponent | undefined;
	isPythonMode: boolean;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	lastAssistantUsage: Usage | undefined;
	loadingAnimation: Loader | undefined;
	clearWorkingLoader(): boolean;
	autoCompactionLoader: Loader | undefined;
	retryLoader: Loader | undefined;
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	optimisticUserMessageSignature: string | undefined;
	locallySubmittedUserSignatures: Set<string>;
	lastSigintTime: number;
	lastEscapeTime: number;
	lastLeftTapTime: number;
	shutdownRequested: boolean;
	readonly isShuttingDown: boolean;
	hookSelector: HookSelectorComponent | undefined;
	hookInput: HookInputComponent | undefined;
	hookEditor: HookEditorComponent | undefined;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Text | undefined;
	fileSlashCommands: Set<string>;
	skillCommands: Map<string, Skill>;
	oauthManualInput: OAuthManualInputManager;
	todoPhases: TodoPhase[];
}

export interface InteractiveModeLifecycle {
	init(): Promise<void>;
	shutdown(): Promise<void>;
	checkShutdownRequested(): Promise<void>;
	requestRelaunch(spec: { argv: string[]; env?: Record<string, string | undefined> }): void;
}

export interface InteractiveModeExtensions {
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
	initializeHookRunner(uiContext: ExtensionUIContext, hasUI: boolean): void;
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;
	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;
}

export interface InteractiveModeHelpers {
	present(content: Component | readonly Component[]): void;
	resetTranscript(): void;
	showStatus(message: string, options?: { dim?: boolean }): void;
	showModelCycleTrack(track: string): void;
	showError(message: string): void;
	showPinnedError(message: string): void;
	clearPinnedError(): void;
	showWarning(message: string): void;
	showNewVersionNotification(newVersion: string): void;
	showUpdateReadyNotification(newVersion: string, warnings?: readonly string[]): void;
	showUpdateFailedNotification(newVersion: string, error: string): void;
	showPluginUpdatesNotification(count: number): void;
	showPluginUpdatesInstalledNotification(count: number): void;
	showUnparseableSettingsNotification(files: readonly QuarantinedSettingsFile[]): void;
	showSettingsSaveFailureNotification(failure: SettingsSaveFailure): void;
	clearEditor(): void;
	focusActiveEditorArea(): void;
	updatePendingMessagesDisplay(): void;
	refreshComposerShortcuts(): void;
	dismissWelcome(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	flushPendingModelSwitch(): Promise<void>;
	setWorkingMessage(message?: string): void;
	applyPendingWorkingMessage(): void;
	ensureLoadingAnimation(): void;
	startPendingSubmission(input: {
		text: string;
		images?: ImageContent[];
		imageLinks?: (string | undefined)[];
		customType?: string;
		display?: boolean;
		streamingBehavior?: "steer" | "followUp";
	}): SubmittedUserInput;
	cancelPendingSubmission(): boolean;
	markPendingSubmissionStarted(input: SubmittedUserInput): boolean;
	finishPendingSubmission(input: SubmittedUserInput): void;
	recordLocalSubmission(text: string, imageCount?: number): () => void;
	withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T>;
	clearOptimisticUserMessage(): void;
	replaceOptimisticUserMessage(
		message: AgentMessage,
		options?: { imageLinks?: readonly (string | undefined)[] },
	): void;
	isKnownSlashCommand(text: string): boolean;
	addMessageToChat(
		message: AgentMessage,
		options?: { populateHistory?: boolean; imageLinks?: readonly (string | undefined)[] },
	): Component[];
	renderSessionContext(
		sessionContext: SessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean },
	): void;
	renderInitialMessages(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): void;
	getUserMessageText(message: Message): string;
	findLastAssistantMessage(): AssistantMessage | undefined;
	extractAssistantText(message: AssistantMessage): string;
	syncRunningSubagentBadge(): void;
	updateEditorBorderColor(): void;
	rebuildChatFromMessages(): void;
	setTodos(todos: TodoItem[] | TodoPhase[]): void;
	reloadTodos(): Promise<void>;
	toggleTodoExpansion(): void;
}

export interface InteractiveModeCommands {
	handleExportCommand(text: string): Promise<void>;
	handleShareCommand(): Promise<void>;
	handleTodoCommand(args: string): Promise<void>;
	handleSessionCommand(): Promise<void>;
	handleAdvisorStatusCommand(): Promise<void>;
	handleJobsCommand(): Promise<void>;
	handleUsageCommand(reports?: UsageReport[] | null): Promise<void>;
	handleChangelogCommand(): Promise<void>;
	handleHotkeysCommand(): void;
	handleToolsCommand(): void;
	handleContextCommand(): void;
	handleDumpCommand(): Promise<void>;
	handleAdvisorDumpCommand(isRaw?: boolean): void;
	handleDebugTranscriptCommand(): Promise<void>;
	handleClearCommand(): Promise<void>;
	handleFreshCommand(): Promise<void>;
	handleDropCommand(): Promise<void>;
	handleForkCommand(): Promise<void>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handlePythonCommand(code: string, excludeFromContext?: boolean): Promise<void>;
	handleMCPCommand(text: string): Promise<void>;
	handleSSHCommand(text: string): Promise<void>;
	handleCompactCommand(customInstructions?: string, mode?: CompactMode): Promise<CompactionOutcome>;
	handleHandoffCommand(customInstructions?: string): Promise<void>;
	handleShakeCommand(mode: ShakeMode): Promise<void>;
	handleMoveCommand(targetPath?: string): Promise<void>;
	handleRenameCommand(title: string): Promise<void>;
	handleMemoryCommand(text: string): Promise<void>;
	handleSTTToggle(): Promise<void>;
	executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto?: boolean,
	): Promise<CompactionOutcome>;
	openInBrowser(urlOrPath: string): void;
	refreshSlashCommandState(cwd?: string): Promise<void>;
	applyCwdChange(newCwd: string): Promise<void>;
	showFullWelcome(): Promise<void>;
}

export interface InteractiveModeSelectors {
	showSettingsSelector(initialItemId?: string): void;
	showAdvisorConfigure(): Promise<void>;
	showHistorySearch(): void;
	showExtensionsDashboard(): void;
	showAgentsDashboard(options?: { requireContent?: boolean; processScope?: boolean }): void;
	showSecretList(): void;
	showModelSelector(options?: { temporaryOnly?: boolean }): void;
	showThinkingSelector(): void;
	showSubcommandPicker(
		commandName: string,
		subcommands: readonly SubcommandDef[],
		onSelect: (subcommand: SubcommandDef) => void,
	): void;
	showPluginSelector(mode?: "install" | "uninstall"): void;
	showUserMessageSelector(): void;
	showCopySelector(): void;
	showTreeSelector(): void;
	showSessionSelector(): void;
	handleResumeSession(sessionPath: string): Promise<void>;
	handleSessionDeleteCommand(): Promise<void>;
	showAccountManager(providerId?: string): Promise<void>;
	showLogin(providerId?: string): Promise<void>;
	showLogout(providerId?: string): Promise<void>;
	showResetUsageSelector(): Promise<void>;
	showProviderSetup(): Promise<void>;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showDebugSelector(): Promise<void>;
	resetObserverRegistry(): void;
}

export interface InteractiveModeInput {
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	handleDequeue(): void;
	handleImagePaste(): Promise<boolean>;
	handleQueueCommand(message: string): Promise<void>;
	handleBtwCommand(question: string): Promise<void>;
	handleTanCommand(work: string): Promise<void>;
	hasActiveBtw(): boolean;
	handleBtwEscape(): boolean;
	handleBtwBranchKey(): Promise<boolean>;
	canBranchBtw(): boolean;
	canCopyBtw(): boolean;
	handleBtwCopyKey(): Promise<boolean>;
	handleBtwBranch(question: string, assistantMessage: AssistantMessage): Promise<void>;
	handleOmfgCommand(complaint: string): Promise<void>;
	hasActiveOmfg(): boolean;
	handleOmfgEscape(): boolean;
	cycleThinkingLevel(): void;
	cycleRoleModel(direction?: "forward" | "backward"): Promise<void>;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	toggleThinkingBlockVisibility(): void;
	openExternalEditor(): void;
	registerExtensionShortcuts(): void;
	handlePlanModeCommand(initialPrompt?: string): Promise<void>;
	handleVibeModeCommand(initialPrompt?: string): Promise<void>;
	handleGoalModeCommand(rest?: string): Promise<void>;
	openGoalDetail(): Promise<void>;
	handleGuidedGoalCommand(rest?: string): Promise<void>;
	handleLoopCommand(args?: string): Promise<string | undefined>;
	disableLoopMode(): void;
	pauseLoop(): void;
	handlePlanApproval(details: PlanApprovalDetails): Promise<void>;
	openPlanReview(): Promise<void>;
}

export interface InteractiveModeHooks {
	initHooksAndCustomTools(): Promise<void>;
	emitCustomToolSessionEvent(
		reason: "start" | "switch" | "branch" | "tree" | "shutdown",
		previousSessionFile?: string,
	): Promise<void>;
	setHookWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	setHookStatus(key: string, text: string | undefined): void;
	showHookSelector(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
	): Promise<string | undefined>;
	showAskDialog(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined>;
	hideHookSelector(): void;
	showHookInput(
		title: string,
		placeholder?: string,
		inputOptions?: { mask?: string; hint?: string },
	): Promise<string | undefined>;
	hideHookInput(): void;
	showHookEditor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
	hideHookEditor(): void;
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void;
	showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: { overlay?: boolean },
	): Promise<T>;
	showExtensionError(extensionPath: string, error: string): void;
	showToolError(toolName: string, error: string): void;
}

export interface InteractiveModeContext
	extends InteractiveModeUi,
		InteractiveModeSession,
		InteractiveModeState,
		InteractiveModeLifecycle,
		InteractiveModeExtensions,
		InteractiveModeHelpers,
		InteractiveModeCommands,
		InteractiveModeSelectors,
		InteractiveModeInput,
		InteractiveModeHooks {}
