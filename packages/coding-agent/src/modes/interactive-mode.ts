/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	type AgentToolResult,
	EventLoopKeepalive,
	ThinkingLevel,
} from "@veyyon/agent-core";
import type { CompactionOutcome } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, Model, Usage, UsageReport } from "@veyyon/ai";
import { modelsAreEqual } from "@veyyon/catalog/models";
import type {
	AutocompleteProvider,
	Component,
	EditorTheme,
	LoaderMessageColorFn,
	NativeScrollbackLiveRegion,
	OverlayHandle,
	SlashCommand,
} from "@veyyon/tui";
import {
	Container,
	clearRenderCache,
	Loader,
	ProcessTerminal,
	planPaintGround,
	Spacer,
	setTerminalTextSizing,
	setTuiTight,
	TERMINAL,
	Text,
	TUI,
	visibleWidth,
} from "@veyyon/tui";
import { isInsideTerminalMultiplexer } from "@veyyon/tui/terminal-capabilities";
import {
	APP_NAME,
	adjustHsv,
	clampLow,
	errorMessage,
	estimateTokensFromText,
	formatClock,
	formatCount,
	formatNumber,
	getProjectDir,
	hsvToRgb,
	isEnoent,
	logger,
	postmortem,
	prompt,
	setProjectDir,
} from "@veyyon/utils";
import chalk from "chalk";
import { reset as resetCapabilities } from "../capability";
import type { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { KeybindingsManager } from "../config/keybindings";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import {
	isSettingsInitialized,
	onStatusLineSessionAccentChanged,
	type QuarantinedSettingsFile,
	Settings,
	settings,
} from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import type {
	AutocompleteProviderFactory,
	ContextUsage,
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
import { type GuidedGoalMessage, newGuidedGoalSessionId, runGuidedGoalTurn } from "../goals/guided-setup";
import type { Goal, GoalModeState } from "../goals/state";
import { resolveLocalUrlToPath } from "../internal-urls";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import type { MCPManager } from "../mcp";
import {
	isMcpConnectionStatusEvent,
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "../mcp/startup-events";
import {
	humanizePlanTitle,
	type PlanApprovalDetails,
	resolveApprovedPlan,
	resolvePlanTitle,
} from "../plan-mode/approved-plan";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import { type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import {
	type AgentSession,
	type AgentSessionEvent,
	type ResolvedRoleModel,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../session/agent-session";
import type { CompactMode } from "../session/compact-modes";
import { HistoryStorage } from "../session/history-storage";
import type { SessionContext } from "../session/session-context";
import { getRecentSessions } from "../session/session-listing";
import type { SessionManager } from "../session/session-manager";
import type { ShakeMode } from "../session/shake-types";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, buildTuiBuiltinSlashCommands } from "../slash-commands/builtin-registry";
import { formatDurationCoarse } from "../slash-commands/helpers/format";
import { STTController, type SttState } from "../stt";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import { formatTaskId } from "../task/render";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { LspStartupServerInfo } from "../tools";
import { normalizeLocalScheme } from "../tools/path-utils";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { setAutoQaConsentHandler } from "../tools/report-tool-issue";
import { type ResolveToolDetails, runResolveInvocation } from "../tools/resolve";
import { formatPhaseDisplayName, todoMatchesAnyDescription } from "../tools/todo";
import { ToolError } from "../tools/tool-errors";
import { vocalizer } from "../tts/vocalizer";
import { renderTreeList } from "../tui/tree-list";
import { copyToClipboard } from "../utils/clipboard";
import type { EventBus } from "../utils/event-bus";
import { getEditorCommand, openInEditor } from "../utils/external-editor";
import { getSessionAccentAnsi, getSessionAccentHex } from "../utils/session-color";
import { messageHasDisplayableThinking } from "../utils/thinking-display";
import { popTerminalTitle, pushTerminalTitle, setSessionTerminalTitle } from "../utils/title-generator";
import { VibeSessionRegistry } from "../vibe/runtime";
import type { AssistantMessageComponent } from "./components/assistant-message";
import type { BashExecutionComponent } from "./components/bash-execution";
import { ChatBlock, type ChatBlockHost } from "./components/chat-block";
import {
	COMPOSER_BOTTOM_MARGIN_ROWS,
	COMPOSER_INSET_COLS,
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
import { PlanReviewOverlay } from "./components/plan-review-overlay";
import { StatusLineComponent } from "./components/status-line";
import { goalProgressBar } from "./components/status-line/segments";
import { renderSunsetField } from "./components/sun";
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
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopLimitArgs,
} from "./loop-limit";
import { OAuthManualInputManager } from "./oauth-manual-input";
import { countRunningSubagentBadgeAgents, getRunningSubagentBadgeRegistry } from "./running-subagent-badge";
import {
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "./session-observer-registry";
import { createSessionTeardown, type SessionTeardown } from "./session-teardown";
import { runProviderSetupWizard } from "./setup-wizard/lazy";
import { interruptHint } from "./shared";
import { setDetectedTerminalGround } from "./theme/ground-tints";
import { clearMermaidCache } from "./theme/mermaid-cache";
import {
	lavaText,
	livingSpinnerColor,
	type ShimmerPalette,
	shimmerEnabled,
	shimmerSegments,
	shimmerText,
} from "./theme/shimmer";
import type { Theme } from "./theme/theme";
import {
	getCurrentThemeName,
	getEditorTheme,
	getSymbolTheme,
	onTerminalAppearanceChange,
	onThemeChange,
	setMarkdownMermaidRendering,
	theme,
} from "./theme/theme";
import type {
	CompactionQueuedMessage,
	InteractiveModeContext,
	InteractiveModeInitOptions,
	InteractiveSelectorDialogOptions,
	SubmittedUserInput,
	TodoItem,
	TodoPhase,
} from "./types";
import { UiHelpers } from "./utils/ui-helpers";

const HINT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "borderAccent",
};

interface WorkingMessageAccent {
	main: string;
	dim: string;
}

interface WorkingMessageAccentCacheKey {
	sessionName: string | undefined;
	accentSurfaceLuminance: number | undefined;
	sessionAccentEnabled: boolean;
}

/**
 * Intern the shimmer palettes for each `WorkingMessageAccent` so `compile()`
 * inside `shimmerSegments` sees a stable palette object between animation
 * ticks. Allocating fresh palette literals every frame guaranteed a cache miss
 * on the Symbol-keyed compiled-ANSI slot and forced `resolveTierAnsi` to walk
 * every tier open/close for the ~30fps loader redraw (issue #4377).
 */
const workingMessagePaletteCache = new WeakMap<WorkingMessageAccent, { main: ShimmerPalette; hint: ShimmerPalette }>();

function workingMessagePalettes(accent: WorkingMessageAccent): { main: ShimmerPalette; hint: ShimmerPalette } {
	let entry = workingMessagePaletteCache.get(accent);
	if (!entry) {
		entry = {
			main: { low: "dim", mid: { ansi: accent.main }, high: { ansi: accent.main }, bold: true },
			hint: { low: "dim", mid: { ansi: accent.dim }, high: { ansi: accent.dim } },
		};
		workingMessagePaletteCache.set(accent, entry);
	}
	return entry;
}

function renderWorkingMessage(message: string, accent?: WorkingMessageAccent, clockText?: string): string {
	const palettes = accent ? workingMessagePalettes(accent) : undefined;
	const palette = palettes?.main;
	const hintPalette = palettes?.hint ?? HINT_SHIMMER_PALETTE;
	const hint = interruptHint();
	let body = message;
	let hasHint = false;
	if (body.endsWith(hint)) {
		body = body.slice(0, -hint.length);
		hasHint = true;
	}
	// The per-task elapsed clock (` · 0:42`) sits between the label and the esc
	// hint. It is whisper chrome, not part of the task label, so it takes the
	// hint's dim palette instead of shimmering with the message body.
	let clock = "";
	if (clockText && body.endsWith(clockText)) {
		body = body.slice(0, -clockText.length);
		clock = clockText;
	}
	if (!hasHint && !clock) return shimmerText(message, theme, palette);
	const segments = [{ text: body, palette }];
	if (clock) segments.push({ text: clock, palette: hintPalette });
	if (hasHint) segments.push({ text: hint, palette: hintPalette });
	return shimmerSegments(segments, theme);
}

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row
/** The idle composer's ghost text. Single spaces around the interpunct — the
 * double-spaced version read as uneven gaps (user screenshot, 2026-07-21). */
const COMPOSER_PLACEHOLDER = "ask anything · / for commands";

/**
 * Editor max-height cap for a terminal of `terminalRows` rows.
 *
 * Roomy terminals get the comfortable [6, 18] band. Small terminals shrink the
 * cap so the editor leaves at least EDITOR_MIN_CHROME_ROWS rows for the
 * transcript + status line. The editor is bordered, so it never renders fewer
 * than EDITOR_MIN_RENDERED_ROWS rows; once the terminal is too small for both
 * (terminalRows < EDITOR_MIN_RENDERED_ROWS + EDITOR_MIN_CHROME_ROWS) the cap is
 * pinned to that floor — returning a smaller number would not shrink the editor
 * any further, it would only misreport the rows it actually occupies.
 */
export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = clampLow(rows - EDITOR_RESERVED_ROWS, EDITOR_MAX_HEIGHT_MIN, EDITOR_MAX_HEIGHT_MAX);
	return clampLow(comfortable, EDITOR_MIN_RENDERED_ROWS, rows - EDITOR_MIN_CHROME_ROWS);
}

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);
const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

/** Options for creating an InteractiveMode instance (for future API use) */
export interface InteractiveModeOptions {
	/** Providers that were migrated during startup */
	migratedProviders?: string[];
	/** Warning message if model fallback occurred */
	modelFallbackMessage?: string;
	/** Initial message to send */
	initialMessage?: string;
	/** Initial images to include with the message */
	initialImages?: ImageContent[];
	/** Additional initial messages to queue */
	initialMessages?: string[];
}

/**
 * Anchored live-region container for the HUD/status rows between the transcript
 * and the editor (working loader, todo + subagent HUDs, transient notification
 * panels). While it has content every row is live: it reports a seam at 0 so the
 * engine never commits these anchored, rebuilt-in-place rows to native
 * scrollback — otherwise stale duplicates pile up above the live copy on short
 * terminals once the loader sits below a tall HUD. The transcript's own seam,
 * when present, sits higher and wins (topmost-seam merge in TUI.render).
 */
class AnchoredLiveContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.children.length > 0 ? 0 : undefined;
	}
}

/** How long the ctrl+p model-role cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;

const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/**
 * Build the anchored subagent HUD block: a bold accent "Subagents" header plus
 * a bounded set of running-agent rows in the same `Id: description` shape the
 * inline task rows use (muted task preview when no description was given).
 * Layout mirrors the Todos HUD exactly: unindented header, then
 * `renderTreeList` rows (dim connectors) shifted right by one space.
 * Only detached background spawns are listed: a sync task call blocks the
 * parent turn and its inline tool block already renders progress live, and
 * eval `agent()` spawns are rendered by their own eval cell tree.
 * Returns an empty array when nothing is running so the container can clear.
 */
export function renderSubagentHudLines(sessions: ObservableSession[], columns: number): string[] {
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return [];

	const dot = theme.styledSymbol("status.done", "accent");
	const visible = running.slice(0, SUBAGENT_HUD_VISIBLE_LIMIT);
	const hiddenCount = running.length - visible.length;
	const rows = renderTreeList(
		{
			items: visible,
			expanded: true,
			renderItem: session => {
				const displayId = formatTaskId(session.id);
				let line = `${dot} ${theme.fg("accent", theme.bold(displayId))}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				if (description) {
					const budget = Math.max(TRUNCATE_LENGTHS.SHORT, columns - visibleWidth(displayId) - 10);
					line += `${theme.fg("accent", ":")} ${theme.fg("accent", truncateToWidth(replaceTabs(description), budget))}`;
				} else {
					// No spawn description: fall back to a muted task preview, same as
					// the inline task rows when a row has no label.
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview) {
						line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(taskPreview), TRUNCATE_LENGTHS.SHORT))}`;
					}
				}
				return line;
			},
		},
		theme,
	);
	if (hiddenCount > 0) {
		rows.push(theme.fg("dim", `… ${hiddenCount} more running — open Agent Hub for full list`));
	}
	return ["", theme.bold(theme.fg("accent", "Subagents")), ...rows.map(line => ` ${line}`)];
}

export class InteractiveMode implements InteractiveModeContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	keybindings: KeybindingsManager;
	agent: Agent;
	historyStorage?: HistoryStorage;

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
	planModeEnabled = false;
	planModePaused = false;
	goalModeEnabled = false;
	goalModePaused = false;
	vibeModeEnabled = false;
	planModePlanFilePath: string | undefined = undefined;
	loopModeEnabled = false;
	loopPrompt: string | undefined = undefined;
	loopLimit: LoopLimitRuntime | undefined = undefined;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;
	#modelCycleClearTimer: NodeJS.Timeout | undefined;
	todoPhases: TodoPhase[] = [];
	hideThinkingBlock = false;
	#sessionsWithDisplayableThinkingContent = new WeakSet<AgentSession>();
	/** Whether the visible session has produced thinking content the user can reveal. */
	get hasDisplayableThinkingContent(): boolean {
		return this.#sessionsWithDisplayableThinkingContent.has(this.viewSession);
	}
	/** Record received reasoning content so Ctrl+T can reveal it even when model metadata says thinking is off. */
	noteDisplayableThinkingContent(message: AgentMessage): boolean {
		if (this.hasDisplayableThinkingContent || !messageHasDisplayableThinking(message, this.proseOnlyThinking)) {
			return false;
		}
		this.#sessionsWithDisplayableThinkingContent.add(this.viewSession);
		return true;
	}
	/**
	 * Effective thinking-block visibility: hidden when the user's setting is on,
	 * or while thinking is "off" before the session has actually produced
	 * displayable thinking content. Some providers return thinking blocks without
	 * advertising reasoning support, so observed content unlocks the visibility
	 * toggle.
	 */
	get effectiveHideThinkingBlock(): boolean {
		const thinkingOff = (this.viewSession?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		return this.hideThinkingBlock || (thinkingOff && !this.hasDisplayableThinkingContent);
	}
	proseOnlyThinking = true;
	compactionQueuedMessages: CompactionQueuedMessage[] = [];
	pendingTools = new Map<string, ToolExecutionHandle>();
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
	#pendingWorkingMessage: string | undefined;
	// Per-task elapsed clock on the working line: the label is the task, the
	// clock is how long that exact label has been showing. Reset whenever the
	// label changes (each tool call / working phase sets a new one).
	#taskLabel: string | undefined;
	#taskHasHint = false;
	#taskStartedAt = 0;
	#workingClockText: string | undefined;
	#clockTimer: NodeJS.Timeout | undefined;
	#workingMessageAccentCacheKey?: WorkingMessageAccentCacheKey;
	#workingMessageAccentCacheValue?: WorkingMessageAccent;
	#workingMessageAccentCacheHasValue = false;
	get #defaultWorkingMessage(): string {
		return `Working…${interruptHint()}`;
	}
	unsubscribe?: () => void;
	onInputCallback?: (input: SubmittedUserInput) => void;
	// Optimistic-message + local-echo + rebuild state lives in the composer
	// (ARCH-2); these accessors keep the InteractiveModeContext contract.
	get optimisticUserMessageSignature(): string | undefined {
		return this.#transcriptComposer.optimisticSignature;
	}
	get locallySubmittedUserSignatures(): Set<string> {
		return this.#transcriptComposer.localEchoSignatures;
	}
	#pendingSubmittedInput: SubmittedUserInput | undefined;
	lastSigintTime = 0;
	lastEscapeTime = 0;
	lastLeftTapTime = 0;
	shutdownRequested = false;
	#isShuttingDown = false;
	#relaunchSpec: { argv: string[]; env?: Record<string, string | undefined> } | undefined;
	/** True once `shutdown()` has begun teardown. Surfaced to the input
	 *  controller so a Ctrl+C arriving while teardown is in flight can hard-
	 *  abort the remaining work instead of stacking another no-op call. */
	get isShuttingDown(): boolean {
		return this.#isShuttingDown;
	}
	hookSelector: HookSelectorComponent | undefined = undefined;
	hookInput: HookInputComponent | undefined = undefined;
	hookEditor: HookEditorComponent | undefined = undefined;
	lastStatusSpacer: Spacer | undefined = undefined;
	lastStatusText: Text | undefined = undefined;
	fileSlashCommands: Set<string> = new Set();
	skillCommands: Map<string, Skill> = new Map();
	oauthManualInput: OAuthManualInputManager = new OAuthManualInputManager();
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;

	#pendingSlashCommands: SlashCommand[] = [];
	/** Built-in editor autocomplete provider, before extension wrapping. */
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	/** Extension-registered provider factories, applied in registration order (#4919). */
	#autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	#cleanupUnsubscribe?: () => void;
	#signalTeardown?: SessionTeardown;
	readonly #version: string;
	#planModePreviousTools: string[] | undefined;
	#goalModePreviousTools: string[] | undefined;
	#vibeModePreviousTools: string[] | undefined;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalTurnHadToolCalls = false;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#planModePreviousModelState: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ConfiguredThinkingLevel } | undefined;
	#planModeHasEntered = false;
	#planReviewOverlay: PlanReviewOverlay | undefined;
	#planReviewOverlayHandle: OverlayHandle | undefined;
	readonly lspServers: LspStartupServerInfo[] | undefined = undefined;
	mcpManager?: MCPManager;
	readonly #toolUiContextSetter: (uiContext: ExtensionUIContext, hasUI: boolean) => void;

	readonly #btwController: BtwController;
	readonly #tanCommandController: TanCommandController;
	readonly #omfgController: OmfgController;
	readonly #commandController: CommandController;
	readonly #todoCommandController: TodoCommandController;
	readonly #eventController: EventController;
	get eventController(): EventController {
		return this.#eventController;
	}
	get eventBus(): EventBus | undefined {
		return this.#eventBus;
	}
	readonly #extensionUiController: ExtensionUiController;
	readonly #inputController: InputController;
	readonly #selectorController: SelectorController;
	readonly #focusController: SessionFocusController;
	get viewSession(): AgentSession {
		return this.#focusController.target ?? this.session;
	}
	get focusedAgentId(): string | undefined {
		return this.#focusController.focusedAgentId;
	}
	get sessionName(): string | undefined {
		return this.session.sessionName;
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
			this.#resetTaskClock();
		}
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.autoCompactionLoader = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.retryLoader = undefined;
		}
		this.statusContainer.disposeChildren();
		this.pendingMessagesContainer.disposeChildren();
		this.#cancelModelCycleClearTimer();
		this.modelCycleContainer.disposeChildren();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.lastAssistantUsage = undefined;
		this.pendingTools.clear();
	}
	readonly #uiHelpers: UiHelpers;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#resizeHandler?: () => void;
	/** Owns the home-screen anchor fills and their sizing (ARCH-2 extraction);
	 *  every fill row on screen is sized in the layout controller, never here.
	 *  Constructed in the constructor (the port closes over `this`). */
	#layout!: HomeAnchorLayout;
	#transcriptComposer!: TranscriptComposer;
	#observerRegistry: SessionObserverRegistry;
	#eventBus?: EventBus;
	#eventBusUnsubscribers: Array<() => void> = [];
	#observerUiSyncTimer?: NodeJS.Timeout;
	#observerUiSyncNeedsTodoReconcile = false;
	#agentRegistryUnsubscribe?: () => void;
	#agentRegistrySubscriptionTarget?: AgentRegistry;
	#mcpPendingServers = new Set<string>();
	#mcpConnectedServers = new Set<string>();
	#mcpFailedServers = new Map<string, { error: string; foreign: boolean }>();
	/** Owns the startup hero and the full `/welcome` card (ARCH-2 extraction);
	 *  the fill/anchor math stays here, reached through the layout port.
	 *  Constructed in the constructor (the port closes over `this`). */
	#welcomeController!: WelcomeController;
	// Component-scoped: a ChatBlock (e.g. the MCP "Connecting..." spinner) ticks
	// its own animation on a fixed cadence inside a possibly large transcript; a
	// full requestRender() would re-walk that whole tree per tick purely to
	// advance the block's own glyph.
	readonly #chatHost: ChatBlockHost = {
		requestComponentRender: component => this.ui.requestComponentRender(component),
	};

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
		if (eventBus) {
			this.#eventBusUnsubscribers.push(
				eventBus.on(LSP_STARTUP_EVENT_CHANNEL, data => {
					if (this.settings.get("startup.quiet")) return;
					this.#handleLspStartupEvent(data as LspStartupEvent);
				}),
			);
			this.#eventBusUnsubscribers.push(
				eventBus.on(MCP_CONNECTION_STATUS_EVENT_CHANNEL, data => {
					if (!isMcpConnectionStatusEvent(data)) {
						logger.warn("Ignoring malformed mcp:connection-status event", { data });
						return;
					}
					this.#handleMcpConnectionStatusEvent(data);
				}),
			);
		}

		setTuiTight(settings.get("tui.tight"));
		setMarkdownMermaidRendering(settings.get("tui.renderMermaid"));
		this.ui = new TUI(new ProcessTerminal(), settings.get("showHardwareCursor"));
		this.ui.setMaxInlineImages(settings.get("tui.maxInlineImages"));
		this.ui.setScrollbackRebuild(settings.get("tui.scrollbackRebuild"));
		this.ui.setScrollIsolation(settings.get("tui.scrollIsolation"));
		// OSC 66 text-sizing is Kitty-only; resolve the setting against the terminal's
		// capability (`TERMINAL.textSizing` defaults on for Kitty) so it stays off
		// unless the user opts in, and never emits raw escapes on other terminals.
		setTerminalTextSizing(settings.get("tui.textSizing") && TERMINAL.textSizing);
		this.chatContainer = new TranscriptContainer();
		this.#transcriptComposer = new TranscriptComposer({
			chatContainer: this.chatContainer,
			addMessageToChat: (message, options) => void this.addMessageToChat(message, options),
			renderSessionContext: context => this.renderSessionContext(context),
			buildTranscriptContext: () =>
				// Live display collapses to the compacted transcript tail unless the
				// user opted into the full inline history; export/resume callers
				// choose their own mode.
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
			// Resolved lazily: the welcome controller is constructed just below.
			hasHero: () => this.#welcomeController.hasHero,
			composerZoneRows: () => this.#composerZoneRows(),
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
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));
		this.#syncEditorMaxHeight();
		this.#resizeHandler = () => {
			this.#syncEditorMaxHeight();
			this.#layout.sync();
			this.ui.requestRender();
		};
		process.stdout.on("resize", this.#resizeHandler);
		// Home-screen anchor self-correction: content mounted or resized after the
		// fill was seeded (e.g. the async MCP status line) would otherwise leave
		// the composer drifting off the viewport bottom until the next resize.
		this.ui.onFrameComposed = () => this.#layout.onFrameComposed();
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
		this.composerShortcuts = new ComposerShortcutsBar();
		this.composerShortcuts.setScrollState(() => ({
			active: this.ui.virtualScrollActive,
			newRows: this.ui.virtualScrollNewRows,
		}));
		this.#refreshComposerShortcuts();
		this.statusLine = new StatusLineComponent(session);
		this.statusLine.setAutoCompactEnabled(session.autoCompactionEnabled);
		// The borderless composer, per the agreed design mockups: a static
		// near-invisible hairline, the content inset off the terminal edge, and
		// ONE quiet metadata footline below the input — location (path · git)
		// left, capability (model · mode · context · MCP health) right. The
		// chrome is silent; motion belongs to content.
		this.editor.setBorderVisible(false);
		this.editor.setPlaceholder(COMPOSER_PLACEHOLDER);
		this.composerHairline = new ComposerHairline();
		this.capabilityLine = new QuietZoneLine(
			width => this.statusLine.renderQuietLine(width, { locationRight: this.#locationRightZone() }),
			COMPOSER_INSET_COLS,
		);

		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.proseOnlyThinking = settings.get("proseOnlyThinking");

		const hookCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
		).map(cmd => ({
			name: cmd.name,
			description: cmd.description ?? "(hook command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
			category: "extensions",
		}));

		// Convert custom commands (TypeScript) to SlashCommand format
		const customCommands: SlashCommand[] = this.session.customCommands.map(loaded => ({
			name: loaded.command.name,
			description: `${loaded.command.description} (${loaded.source})`,
			category: "custom",
		}));

		// Build skill commands from session.skills (if enabled)
		const skillCommandList: SlashCommand[] = [];
		if (settings.get("skills.enableSkillCommands")) {
			for (const skill of this.session.skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill);
				skillCommandList.push({ name: commandName, description: skill.description, category: "skills" });
			}
		}

		const builtinCommands = buildTuiBuiltinSlashCommands({ ctx: this });
		// Store pending commands for init() where file commands are loaded async
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
		this.#focusController = new SessionFocusController(this);
		this.#inputController = new InputController(this);
		this.#observerRegistry = new SessionObserverRegistry();
	}

	#handleMcpConnectionStatusEvent(event: McpConnectionStatusEvent): void {
		if (this.settings.get("startup.quiet")) return;
		if (event.type === "connecting") {
			this.#mcpPendingServers.clear();
			this.#mcpConnectedServers.clear();
			this.#mcpFailedServers.clear();
			for (const serverName of event.serverNames) {
				this.#mcpPendingServers.add(serverName);
			}
		} else if (event.type === "connected") {
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpFailedServers.delete(event.serverName);
			this.#mcpConnectedServers.add(event.serverName);
		} else {
			this.#mcpPendingServers.delete(event.serverName);
			this.#mcpConnectedServers.delete(event.serverName);
			this.#mcpFailedServers.set(event.serverName, { error: event.error, foreign: event.foreign === true });
		}

		// Boot health lives on the location line's right side (a fixed quiet
		// home), not as a floating transcript status.
		this.ui.requestRender();
	}

	/**
	 * The location line's right zone: MCP boot health when it has something to
	 * say, otherwise nothing. The resting sun dome that used to sit here read as
	 * an artificial ornament; the composer's life now lives in the horizon rule
	 * itself (see {@link ComposerHairline}), not a glyph parked at the edge.
	 */
	#locationRightZone(): string | null {
		const zones = [this.#draftTokenZone(), this.#mcpZoneText()].filter((z): z is string => z !== null);
		return zones.length > 0 ? zones.join(theme.fg("dim", " · ")) : null;
	}

	/**
	 * DS-6 dock: live draft size in the footline's right zone, gold
	 * (matchHighlight) so the growing draft reads as "the found thing you are
	 * about to send". Shown only while a non-blank draft exists; uses the one
	 * shared byte-aware estimator, so the number matches budget math elsewhere.
	 */
	#draftTokenZone(): string | null {
		const draft = this.editor.getText();
		const trimmed = draft.trim();
		if (trimmed.length === 0) return null;
		// A bare slash-command token ("/se…") is menu navigation, not a draft —
		// counting its characters is noise. The counter returns the moment the
		// command takes arguments or the text is prose.
		if (trimmed.startsWith("/") && !/\s/.test(trimmed)) return null;
		return theme.fg("matchHighlight", `~${estimateTokensFromText(draft)} tok`);
	}

	/**
	 * MCP boot health for the location line's right side: progress while
	 * servers connect, a failure count once settled. Null when fully healthy —
	 * a healthy system says nothing.
	 */
	#mcpZoneText(): string | null {
		const pending = this.#mcpPendingServers.size;
		const failed = this.#mcpFailedServers.size;
		if (pending > 0) {
			const total = pending + this.#mcpConnectedServers.size + failed;
			return theme.fg("dim", `mcp ${this.#mcpConnectedServers.size}/${total}`);
		}
		if (failed > 0) {
			// Failures of servers veyyon merely borrowed from another tool's
			// config (Claude Code, Codex, …) stay visible but don't alarm —
			// red at first paint is reserved for veyyon's own configuration.
			const allForeign = [...this.#mcpFailedServers.values()].every(f => f.foreign);
			// Route the cross through the theme symbol, not a raw `✗` literal, so it
			// degrades with the symbol preset (nerd ``, ascii `[!!]`) instead of
			// emitting a glyph an ascii terminal cannot render.
			return theme.fg(allForeign ? "dim" : "statusLineDirty", `mcp ${theme.status.error}${failed} · /mcp list`);
		}
		return null;
	}

	playWelcomeIntro(): void {
		this.#welcomeController.playIntro();
	}

	async init(options: InteractiveModeInitOptions = {}): Promise<void> {
		if (this.isInitialized) return;

		this.keybindings = logger.time("InteractiveMode.init:keybindings", () => KeybindingsManager.create());
		this.#refreshComposerShortcuts();

		// Clock heartbeat: once per second WHILE THE MODEL WORKS, refresh the
		// working line's per-task elapsed and repaint the quiet chrome so the
		// location line's run clock ticks between agent events. At rest every
		// on-screen time readout is frozen by design (run clock shows the
		// completed "Worked for …", the context bar tip is static), so an idle
		// tick would repaint a byte-identical frame — it does nothing.
		this.#clockTimer = setInterval(() => {
			if (!this.loadingAnimation && !this.session.isStreaming) return;
			this.#refreshTaskClock();
			this.ui.requestRender();
		}, 1000);

		// Route SIGINT/SIGTERM/SIGHUP/uncaughtException through the same teardown
		// the TUI Ctrl+C keypress path performs: persist the in-progress editor
		// draft for `--resume`, then dispose the session (which emits the extension
		// `session_shutdown` event, cancels the owned async job manager, disposes
		// eval kernels, releases owned browser tabs, and closes the session
		// manager). Without this callback a real kernel signal would drop the
		// draft, skip the `session_shutdown` contract from `shared-events.ts`,
		// and orphan background bash/task processes (issue #4080). The registered
		// callback and `shutdown()` share one promise-memoized teardown, so a
		// signal arriving mid-Ctrl+C no-ops instead of racing a second dispose.
		this.#signalTeardown = createSessionTeardown({
			getDraftText: () => this.editor.getText(),
			beginDispose: () => this.session.beginDispose(),
			saveDraft: text => this.sessionManager.saveDraft(text),
			// Flush pending debounced settings on every exit path (keypress `/exit`,
			// Ctrl+C/Ctrl+D, and the postmortem SIGINT/SIGTERM/SIGHUP/uncaughtException
			// signals all funnel here). Without this a `/settings` change made just
			// before quitting is lost inside the 100ms save debounce.
			flushSettings: () => Settings.instance.flush(),
			disposeSession: reason =>
				this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS, reason }),
		});
		// Forward the postmortem reason (SIGTERM/SIGHUP/uncaughtException/…) so the
		// persisted `session_exit` diagnostic carries the real trigger. Postmortem
		// runs callbacks in REVERSE registration order — this callback (registered
		// after the AgentSession constructor's `agent-session:<id>` recorder) runs
		// FIRST and its dispose() would otherwise persist the generic "dispose".
		this.#cleanupUnsubscribe = postmortem.register("session-teardown", reason => this.#signalTeardown!(reason));

		// Wire the report_tool_issue consent gate to the Yes/No dialog popup.
		// The handler is process-global — subagent tools (which can't reach
		// `showHookSelector` on their own) resolve through this exact closure.
		// `Settings.instance` is the disk-backed singleton; passing it explicitly
		// guarantees the decision persists even when the prompt is triggered
		// from a subagent whose own `Settings` is an in-memory snapshot.
		setAutoQaConsentHandler(() => this.#promptAutoQaConsent(), Settings.instance);

		await logger.time(
			"InteractiveMode.init:slashCommands",
			this.refreshSlashCommandState.bind(this),
			getProjectDir(),
		);

		// Get current model info for welcome screen. Empty (not "Unknown") when no
		// model is configured, so the welcome renders a "/login" call to action
		// instead of a dead "Unknown · Unknown".
		const modelName = this.session.model?.name ?? "";
		const providerName = this.session.model?.provider ?? "";

		// Get recent sessions
		const recentSessions = await logger.time("InteractiveMode.init:recentSessions", () =>
			getRecentSessions(this.sessionManager.getSessionDir()).then(sessions =>
				sessions.map(s => ({
					name: s.name,
					timeAgo: s.timeAgo,
				})),
			),
		);

		const startupQuiet = settings.get("startup.quiet");

		for (const warning of this.session.configWarnings) {
			this.ui.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
			this.ui.addChild(new Spacer(1));
		}

		// The flexible top margin mounts above the hero AND the transcript: it
		// centres the hero on the home screen, then (once a conversation starts)
		// takes ALL the anchor slack so the conversation hugs the composer at
		// the viewport bottom. Mounted unconditionally — quiet startups skip the
		// hero, not the anchor.
		this.ui.addChild(this.#layout.topFill);
		if (!startupQuiet) {
			this.#welcomeController.mountHero(
				{ version: this.#version, modelName, providerName, recentSessions },
				{ playIntro: !options.suppressWelcomeIntro },
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
		// Bottom-anchor fill: on the home screen this expands to sink the whole
		// status + composer block to the viewport bottom (grok placement); it sits
		// above the status loader so they travel down together.
		this.ui.addChild(this.#layout.bottomFill);
		// The whole composer zone (status, hairline, padded card, footline,
		// margin) mounts in its one canonical order via mountComposerZone —
		// the order is a design contract owned and tested in composer-chrome.
		mountComposerZone(this.ui, {
			statusContainer: this.statusContainer,
			statusLine: this.statusLine,
			hookWidgetsAbove: this.hookWidgetContainerAbove,
			hairline: this.composerHairline,
			editorContainer: this.editorContainer,
			capabilityLine: this.capabilityLine,
			shortcuts: this.composerShortcuts,
			hookWidgetsBelow: this.hookWidgetContainerBelow,
		});
		this.ui.setFocus(this.editor);
		// Anchor the composer to the viewport bottom on the launch/home screen.
		this.#layout.sync();

		this.#inputController.setupKeyHandlers();
		this.#inputController.setupEditorSubmitHandler();

		// Wire observer registry to EventBus
		if (this.#eventBus) {
			this.#observerRegistry.subscribeToEventBus(this.#eventBus);
		}
		this.#observerRegistry.setMainSession(this.sessionManager.getSessionFile() ?? undefined);
		this.syncRunningSubagentBadge();
		this.#observerRegistry.onChange(kind => {
			this.#scheduleObserverUiSync(kind);
		});

		// Load initial todos
		await this.#loadTodoList();

		// Start the UI. Cold `veyyon` launch opts into clearing on the first paint so
		// the initial welcome frame does not append over the previous run's scrollback.
		this.ui.start({ clearScrollback: options.clearInitialTerminalHistory === true });
		// The first paint used an estimated fill (no composed frame existed yet);
		// now the exact composed height is known, so re-anchor precisely. It only
		// re-renders if the estimate was off, so there is usually no visible reflow.
		this.#layout.sync();
		if (this.#layout.bottomFill.render(this.ui.terminal.columns).length > 0) this.ui.requestRender();
		pushTerminalTitle();
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.updateEditorBorderColor();
		// Single side-effect point for title changes: every setSessionName caller
		// (first-input titling, /rename, extension renames, plan seeding, replan
		// refresh) gets the terminal title + accent updates from here. Registered
		// before initHooksAndCustomTools/#reconcileModeFromSession/#enterPlanMode —
		// all of which can reach setSessionName during init.
		this.#eventBusUnsubscribers.push(
			this.sessionManager.onSessionNameChanged(() => {
				setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
				this.#handleSessionAccentInputsChanged();
			}),
		);
		this.#syncEditorMaxHeight();
		this.isInitialized = true;
		this.ui.requestRender(true);

		// Initialize hooks with TUI-based UI context
		await this.initHooksAndCustomTools();

		// Restore mode from session (e.g. plan mode on resume)
		this.session.setSessionSwitchReconciler?.(() => this.#reconcileModeFromSession({ preserveActiveGoal: true }));
		await this.#reconcileModeFromSession();

		// Brand-new sessions optionally start in plan mode when the user has made it
		// the startup default. "Brand-new" means the resolved branch carries no
		// conversation context (buildSessionContext().messages — covers messages,
		// custom messages, branch summaries, and compaction summaries) and the user
		// set no explicit `mode_change` (which #reconcileModeFromSession just
		// restored). SDK startup metadata and extension `custom` state entries are
		// ignored. This way `veyyon --continue` (or auto-resume) that finds no recent
		// session and creates a fresh one still honors the default, while a session
		// with restored context or an explicit mode keeps its reconciled mode. Scoped
		// to launch (not the switch reconciler above) so /new and the plan-approval →
		// execution handoff clear never get dragged back into plan mode. #enterPlanMode
		// is idempotent and self-guards against an already-active plan/goal mode; it
		// does not check plan.enabled itself.
		const hasConversationContext = this.sessionManager.buildSessionContext().messages.length > 0;
		const hasExplicitMode = this.sessionManager.getEntries().some(entry => entry.type === "mode_change");
		const isFreshSession = !hasConversationContext && !hasExplicitMode;
		if (
			isFreshSession &&
			this.session.settings.get("plan.defaultOnStartup") &&
			this.session.settings.get("plan.enabled")
		) {
			await this.#enterPlanMode();
		}

		// Restore unsent editor draft from previous session shutdown (Ctrl+D).
		// One-shot: consumeDraft removes the sidecar after read so the next
		// resume does not re-restore the same text.
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

		// Subscribe to agent events
		this.#subscribeToAgent();

		this.#eventBusUnsubscribers.push(
			this.session.subscribe(event => {
				void this.#handleGoalSessionEvent(event);
			}),
			onStatusLineSessionAccentChanged(() => {
				this.#syncStatusLineSettings();
				this.#handleSessionAccentInputsChanged();
			}),
		);
		// Set up theme file watcher
		this.#eventBusUnsubscribers.push(
			onThemeChange(event => {
				this.#clearWorkingMessageAccentCache();
				clearRenderCache();
				clearMermaidCache();
				this.ui.invalidate();
				this.updateEditorBorderColor();
				if (event.ephemeral || isInsideTerminalMultiplexer()) {
					// Theme previews and multiplexer panes cannot safely replace native
					// scrollback: previews must stay non-destructive, and multiplexers
					// suppress ED3 so a forced replay would duplicate transcript history.
					this.ui.requestRender();
					return;
				}
				// Rows already committed to native scrollback are immutable; replay them
				// after a theme swap so a reader scrolled up sees the same palette.
				this.ui.requestRender(true, { clearScrollback: true });
				// A committed theme swap changes the ground the terminal should show;
				// preview (ephemeral) swaps returned above so a hover does not flicker
				// the terminal background.
				this.#applyPaintGround();
			}),
		);

		// Subscribe to terminal dark/light appearance changes.
		// The terminal queries background color via OSC 11 at startup and on
		// Mode 2031 notifications, computing luminance to detect dark/light.
		this.ui.terminal.onAppearanceChange(mode => {
			onTerminalAppearanceChange(mode);
		});

		// Re-apply the painted ground when the terminal reports an external
		// background change (a terminal theme switch that clobbered our paint).
		// The terminal suppresses the self-echo of our own paint, so this fires
		// only on genuine external changes. Subscribing also replays the current
		// background to us, applying the initial paint once it is known; the
		// explicit call below covers `always`/`never`, which do not need a report.
		// The background-color capability is optional on the Terminal interface
		// (older custom terminals may lack it); when absent, painting is simply
		// unavailable and both the subscription and the paint calls no-op.
		this.ui.terminal.onBackgroundColorChange?.(hex => {
			this.#applyPaintGround();
			// Feed the ground-relative tint owner (hairline, composer card, card
			// outlines): every derived chrome color re-resolves against the REAL
			// terminal ground the moment it is known or changes.
			setDetectedTerminalGround(hex);
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});
		setDetectedTerminalGround(this.ui.terminal.backgroundColor);
		this.#applyPaintGround();

		// A branch change (checkout, worktree switch, `git switch`) invalidates
		// the status-line git segments; the lazy top-border provider picks up
		// the fresh branch on the next painted frame.
		this.statusLine.watchBranch(() => {
			this.ui.requestRender();
		});
	}

	/** Themes already warned about an unhonored `always`, so the log is not repeated. */
	#paintGroundWarnedThemes = new Set<string>();

	/**
	 * Apply the painted-ground policy (`tui.paintGround`): set the terminal
	 * background to the theme's ground color, or inherit the terminal's own,
	 * per the setting and the auto-seam rule ({@link planPaintGround}). Called at
	 * startup, on a committed theme change, and when the terminal reports an
	 * external background change. The paint is reset on exit by the terminal layer
	 * (OSC 111), including after a crash, so this never has to undo it here.
	 */
	#applyPaintGround(): void {
		const plan = planPaintGround(
			this.settings.get("tui.paintGround"),
			theme.getGroundHex(),
			this.ui.terminal.backgroundColor,
		);
		if (plan.unhonoredAlways) {
			// `always` is the one setting the user explicitly asked to paint that a
			// groundless theme cannot honor; say so once per theme rather than
			// silently do nothing (Law 10) or spam the log on every re-apply.
			const name = getCurrentThemeName();
			if (name !== undefined && !this.#paintGroundWarnedThemes.has(name)) {
				this.#paintGroundWarnedThemes.add(name);
				logger.warn(
					'tui.paintGround is "always" but the active theme declares no ground color, so the terminal background is left unpainted',
					{
						theme: name,
						fix: 'Pick a theme that declares a page background, or set tui.paintGround to "auto" or "never". A custom theme can declare one via its "export.pageBg".',
					},
				);
			}
		}
		if (plan.paint !== null) {
			this.ui.terminal.setBackgroundColor?.(plan.paint);
		} else {
			this.ui.terminal.resetBackgroundColor?.();
		}
	}

	/** Reload the title-generation system prompt override for the provided working
	 *  directory and stash it on the session so first-input titling
	 *  ({@link input-controller}) and replan-driven refresh
	 *  ({@link AgentSession.#refreshTitleAfterReplan}) share one source
	 *  ({@link discoverTitleSystemPromptFile}; issue #3734). */
	async refreshTitleSystemPrompt(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const titleSystemPromptSource = discoverTitleSystemPromptFile(basePath);
		const resolved = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		this.session.setTitleSystemPrompt(resolved);
	}

	/** Reload slash commands and autocomplete for the provided working directory. */
	async refreshSlashCommandState(cwd?: string): Promise<void> {
		const basePath = cwd ?? this.sessionManager.getCwd();
		const fileCommands = await loadSlashCommands({ cwd: basePath });
		this.fileSlashCommands = new Set(fileCommands.map(cmd => cmd.name));
		const fileSlashCommands: SlashCommand[] = fileCommands.map(cmd => ({
			name: cmd.name,
			description: cmd.description,
			category: "custom",
		}));
		// Surface discovered prompt templates in the picker. AgentSession.prompt() expands
		// `expandSlashCommand` before `expandPromptTemplate`, and builtin command
		// execution resolves aliases before template expansion. Mirror that command
		// resolution order by skipping templates whose names already appear in any
		// builtin/hook/custom/skill/file command token.
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
				// `PromptTemplate.description` from `loadTemplatesFromDir` already includes the
				// source suffix (e.g. "Review code (project)"), so pass it through verbatim.
				description: template.description,
				category: "custom",
			}));
		this.#baseAutocompleteProvider = this.#inputController.createAutocompleteProvider(
			[...this.#pendingSlashCommands, ...fileSlashCommands, ...promptTemplateCommands],
			basePath,
		);
		this.#applyAutocompleteProvider();
		this.session.setSlashCommands(fileCommands);
	}

	/**
	 * Rebuild the editor's autocomplete provider: the built-in provider wrapped
	 * by every extension-registered factory, in registration order. A factory
	 * that throws or returns a malformed provider is skipped so one broken
	 * extension cannot take down core autocomplete.
	 */
	#applyAutocompleteProvider(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteProviderFactories) {
			try {
				const wrapped = factory(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (error) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", { error: String(error) });
			}
		}
		this.editor.setAutocompleteProvider(provider);
	}

	/** Stack extension autocomplete behavior on top of the built-in editor provider (#4919). */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteProviderFactories.push(factory);
		this.#applyAutocompleteProvider();
	}

	/**
	 * Re-point the process and every cwd-derived cache at `newCwd` after the
	 * active session's working directory changed (`/move` relocation or resuming
	 * a session from another project). The SessionManager's cwd MUST already
	 * reflect `newCwd` before this is called.
	 */
	async applyCwdChange(newCwd: string): Promise<void> {
		setProjectDir(newCwd);
		// Re-scope project settings (`.claude/settings.yml` etc.) to the new
		// directory in place so the active session and every settings reader pick
		// up the destination project's configuration.
		if (isSettingsInitialized()) {
			await settings.reloadForCwd(newCwd);
			// Reapply provider preferences from the newly-loaded settings so the
			// module-level search/image provider state reflects the destination
			// project's configuration. Without this, the previous project's
			// exclusions leak and newly-excluded providers are still used.
			applyProviderGlobalsFromSettings(settings);
		}
		// Re-warm plugin roots, capabilities, slash commands, and the ssh tool so
		// the next prompt sees everything scoped to the new project directory.
		clearClaudePluginRootsCache();
		await this.refreshTitleSystemPrompt(newCwd);
		resetCapabilities();
		await this.refreshSlashCommandState(newCwd);
		await this.session.refreshSshTool({ activateIfAvailable: true });
		setSessionTerminalTitle(this.sessionManager.getSessionName(), this.sessionManager.getCwd());
		this.statusLine.invalidate();
		this.ui.requestRender();
	}

	async getUserInput(): Promise<SubmittedUserInput> {
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
		}
		const { promise, resolve } = Promise.withResolvers<SubmittedUserInput>();
		this.onInputCallback = input => {
			this.onInputCallback = undefined;
			resolve(input);
		};
		this.#scheduleLoopAutoSubmit();
		this.#scheduleGoalContinuation();

		using _ = new EventLoopKeepalive();
		return await promise;
	}

	#scheduleLoopAutoSubmit(): void {
		this.#cancelLoopAutoSubmit();
		if (!this.loopModeEnabled || !this.loopPrompt) return;
		const prompt = this.loopPrompt;
		const loopAction = settings.get("loop.mode");
		this.#deferLoopAutoSubmit(() => {
			void this.#runLoopIteration(loopAction, prompt);
		});
	}

	#deferLoopAutoSubmit(callback: () => void): void {
		// Brief delay so the user has a chance to press Esc between iterations.
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			if (!this.loopModeEnabled || !this.onInputCallback) return;
			callback();
		}, 800);
	}

	#cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
		}
	}

	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (this.loopModeEnabled) return;
		if (!this.onInputCallback) return;
		if (!this.session.settings.get("goal.continuationModes").includes("interactive")) return;
		if (this.planModeEnabled || this.planModePaused) return;
		if (!this.goalModeEnabled || this.goalModePaused) return;
		if (this.#goalSuppressNextContinuation) return;
		if (this.#pendingSubmittedInput) return;
		if (this.editor.getText().trim().length > 0) return;
		if ((this.editor.pendingImages?.length ?? 0) > 0) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (!this.onInputCallback) return;
			if (!this.goalModeEnabled || this.goalModePaused) return;
			// The 800ms timer can outlive the idle window that scheduled it: a
			// `/goal set` taken via the streaming branch (or any extension/hook
			// path that starts a turn while we wait) leaves the agent busy. Firing
			// the continuation now would route through `submitInteractiveInput` →
			// `promptCustomMessage` with no `streamingBehavior` and resurface
			// `AgentBusyError`. Drop this tick; `#handleGoalSessionEvent` reschedules
			// on the next `agent_end`.
			if (this.#isAutoSubmitBlocked()) return;
			if (this.#pendingSubmittedInput) return;
			if (this.editor.getText().trim().length > 0) return;
			if ((this.editor.pendingImages?.length ?? 0) > 0) return;
			const latestState = this.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			this.onInputCallback(
				this.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, 800);
	}

	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	#isAutoSubmitBlocked(): boolean {
		return this.session.isStreaming || this.session.isCompacting || this.session.hasPostPromptWork;
	}

	// Rows the composer zone occupies at the frame tail: the pinned footer
	// region for scroll isolation. Mirrors mountComposerZone's order — status
	// rows, hook widgets, hairline, pad rows, editor, footline, shortcut band,
	// and the bottom margin — so a zone edit that forgets this count is the
	// regression to check first when a frozen scroll view misaligns.
	#composerZoneRows(): number {
		const width = this.ui.terminal.columns;
		let rows = COMPOSER_BOTTOM_MARGIN_ROWS + 2; // bottom margin + two CardPadRows
		for (const component of [
			this.statusContainer,
			this.statusLine,
			this.hookWidgetContainerAbove,
			this.composerHairline,
			this.editorContainer,
			this.capabilityLine,
			this.composerShortcuts,
			this.hookWidgetContainerBelow,
		]) {
			rows += component.render(width).length;
		}
		return rows;
	}

	#refreshComposerShortcuts(): void {
		this.composerShortcuts.setShortcuts(
			buildComposerShortcuts(this.keybindings, {
				busy: this.#isAutoSubmitBlocked(),
				hasDraft: this.editor.getText().trim().length > 0,
				hasQueue: this.session.queuedMessageCount > 0,
			}),
		);
		// Live refresh: draft/busy/queue transitions call this after init, so the
		// bar needs its own repaint request rather than relying on the initial mount.
		this.ui.requestComponentRender(this.composerShortcuts);
	}

	#submitLoopPromptWhenReady(prompt: string): void {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (isLoopDurationExpired(this.loopLimit)) {
			this.disableLoopMode("Loop time limit reached. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => this.#submitLoopPromptWhenReady(prompt));
			return;
		}
		this.onInputCallback(this.startPendingSubmission({ text: prompt }));
	}

	async #runLoopIteration(action: "prompt" | "compact" | "reset", prompt: string): Promise<void> {
		if (!this.loopModeEnabled || this.loopPrompt !== prompt || !this.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.#deferLoopAutoSubmit(() => {
				void this.#runLoopIteration(action, prompt);
			});
			return;
		}

		if (!consumeLoopLimitIteration(this.loopLimit)) {
			this.disableLoopMode("Loop limit reached. Loop mode disabled.");
			return;
		}

		if (action === "compact") {
			await this.handleCompactCommand();
		} else if (action === "reset") {
			await this.handleClearCommand();
		}
		this.#submitLoopPromptWhenReady(prompt);
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.loopModeEnabled;
		this.loopModeEnabled = false;
		this.loopPrompt = undefined;
		this.loopLimit = undefined;
		this.#cancelLoopAutoSubmit();
		this.statusLine.setLoopModeStatus(undefined);
		this.ui.requestRender();
		if (wasEnabled) {
			this.showStatus(message);
		}
	}

	/**
	 * Pause the loop without exiting it: drops the captured prompt and any
	 * pending auto-resubmit. Loop mode stays enabled — the next prompt the
	 * user submits becomes the new loop prompt and resumes iteration.
	 */
	pauseLoop(): void {
		this.loopPrompt = undefined;
		this.#cancelLoopAutoSubmit();
	}

	async handleLoopCommand(args = ""): Promise<string | undefined> {
		if (this.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}
		const parsed = parseLoopLimitArgs(args);
		if (typeof parsed === "string") {
			this.showError(parsed);
			return undefined;
		}
		this.loopModeEnabled = true;
		this.loopPrompt = undefined;
		this.loopLimit = createLoopLimitRuntime(parsed.limit);
		this.statusLine.setLoopModeStatus({ enabled: true });
		this.ui.requestRender();
		const limitSuffix = parsed.limit ? ` Limited to ${describeLoopLimit(parsed.limit)}.` : "";
		const remainingSuffix = this.loopLimit ? ` ${describeLoopLimitRuntime(this.loopLimit)}.` : "";
		const tail = parsed.prompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		this.showStatus(
			`Loop mode enabled.${limitSuffix}${remainingSuffix} ${tail} Esc cancels the current iteration; /loop again to disable.`,
		);
		// Hand any inline prompt back to the dispatcher so the normal submit flow
		// runs the first iteration — it records the text as the loop prompt and
		// auto-resubmits it after each yield, identical to typing the prompt right
		// after enabling loop mode.
		return parsed.prompt;
	}

	recordLocalSubmission(text: string, imageCount = 0): () => void {
		return this.#transcriptComposer.recordLocalSubmission(text, imageCount);
	}

	async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
		const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
		try {
			return await fn();
		} catch (err) {
			dispose();
			throw err;
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
			this.#resetGoalContinuationSuppression();
			this.#transcriptComposer.showOptimistic(submission);
		} else {
			this.#transcriptComposer.clearOptimistic();
		}
		this.editor.setText("");
		this.editor.imageLinks = undefined;
		this.ensureLoadingAnimation();
		// As the conversation begins the anchor slack moves ABOVE the transcript
		// (see HomeAnchorLayout.sync): the first message renders directly above
		// the composer at the viewport bottom and climbs as replies land, until
		// content fills the screen and the anchor latches off. Remeasure directly
		// — the just-added user message and the working indicator are not in the
		// committed frame yet, so trusting the stale composed height would reserve
		// empty-home slack on top of them and overflow, jumping the message above
		// the fold (the old first-message jerk).
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
		this.#pendingWorkingMessage = undefined;
		if (submission.customType === "goal-continuation") {
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		if (!submission.customType) {
			this.editor.pendingImages = submission.images ? [...submission.images] : [];
			this.editor.pendingImageLinks = submission.imageLinks ? [...submission.imageLinks] : [];
			this.editor.imageLinks = this.editor.pendingImageLinks;
			this.rebuildChatFromMessages();
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
			this.#goalContinuationTurnInFlight = false;
		}

		const quiesced = !this.session.isStreaming && !this.streamingComponent;
		this.#transcriptComposer.onSubmissionFinished({ owned: wasPendingSubmission, quiesced });
		if (wasPendingSubmission && quiesced) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.#stopLoadingAnimation(true);
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
		this.#clearWorkingMessageAccentCache();
		this.statusLine.invalidate();
		this.updateEditorBorderColor();
	}

	updateEditorBorderColor(): void {
		// The accent decision (border color, DS-6 glyph morph, continuation
		// spine) is a pure function in composer-chrome.ts; this method only
		// snapshots the mode/session state and applies the result. The session
		// identity accent needs settings + the session name, so it resolves here.
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
		// No composer card: the input renders on the terminal's own ground.
		// (User order 2026-07-22: the tinted box is gone entirely; the composer
		// is hairline + text + footline, nothing painted behind it.)
		this.editor.setRowBackground(undefined);
		this.ui.requestRender();
	}

	/** Refresh the running-subagents status badge from the active local or collab registry. */
	syncRunningSubagentBadge(options: { requestRender?: boolean } = {}): void {
		const registry = getRunningSubagentBadgeRegistry(this.collabGuest);
		if (this.#agentRegistrySubscriptionTarget !== registry) {
			this.#agentRegistryUnsubscribe?.();
			this.#agentRegistrySubscriptionTarget = registry;
			this.#agentRegistryUnsubscribe = registry.onChange(() => {
				this.syncRunningSubagentBadge();
			});
		}
		const count = countRunningSubagentBadgeAgents(registry);
		this.statusLine.setSubagentCount(count);
		if (options.requestRender !== false) this.ui.requestRender();
	}

	rebuildChatFromMessages(): void {
		// The composer owns the rebuild's live-component preservation (#3656)
		// and the pre-streaming optimistic replay (#2372).
		this.#transcriptComposer.rebuild();
	}

	#formatTodoLine(todo: TodoItem, prefix: string, matched: boolean): string {
		const checkbox = theme.checkbox;
		const marker = formatHudNoteMarker(todo.notes?.length ?? 0);
		switch (todo.status) {
			case "completed":
				return theme.fg("success", `${prefix}${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
			case "in_progress":
				return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
			case "abandoned":
				return theme.fg("error", `${prefix}${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
			default:
				if (matched) return theme.fg("accent", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
				return theme.fg("dim", `${prefix}${checkbox.unchecked} ${todo.content}`) + marker;
		}
	}

	#getActiveSubagentDescriptions(): string[] {
		const out: string[] = [];
		for (const session of this.#observerRegistry.getSessions()) {
			if (session.kind !== "subagent") continue;
			if (session.status !== "active") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) out.push(candidate);
		}
		return out;
	}

	/**
	 * Auto-complete any pending/in_progress todo whose content matches a
	 * subagent that has finished successfully. Fires on every observer
	 * `onChange` so the visual state stays in sync with subagent lifecycle
	 * without requiring the agent to issue a follow-up `todo`. Failed
	 * and aborted subagents are intentionally NOT auto-completed — those
	 * stay open so the user (or the next agent turn) can decide what to do.
	 *
	 * Idempotent: only flips open tasks, never re-touches completed ones.
	 */
	#reconcileTodosWithSubagents(): void {
		const completedDescs: string[] = [];
		for (const session of this.#observerRegistry.getSessions()) {
			if (session.kind !== "subagent") continue;
			if (session.status !== "completed") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) completedDescs.push(candidate);
		}
		if (completedDescs.length === 0) return;

		let mutated = false;
		const next: TodoPhase[] = this.todoPhases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				if (task.status !== "pending" && task.status !== "in_progress") return task;
				if (!todoMatchesAnyDescription(task.content, completedDescs)) return task;
				mutated = true;
				return { ...task, status: "completed" as const };
			}),
		}));
		if (!mutated) return;
		this.session.setTodoPhases(next);
		this.setTodos(next);
	}

	#cancelTodoAutoClearTimer(): void {
		if (!this.#todoAutoClearTimer) return;
		clearTimeout(this.#todoAutoClearTimer);
		this.#todoAutoClearTimer = undefined;
	}

	#isClosedTodo(task: TodoItem): boolean {
		return task.status === "completed" || task.status === "abandoned";
	}

	#hasClosedTodos(phases: TodoPhase[]): boolean {
		return phases.some(phase => phase.tasks.some(task => this.#isClosedTodo(task)));
	}

	#removeClosedTodos(phases: TodoPhase[]): TodoPhase[] {
		const next: TodoPhase[] = [];
		for (const phase of phases) {
			const tasks = phase.tasks.filter(task => !this.#isClosedTodo(task));
			if (tasks.length > 0) next.push({ name: phase.name, tasks });
		}
		return next;
	}

	#syncTodoAutoClearTimer(): void {
		this.#cancelTodoAutoClearTimer();
		const delaySeconds = this.settings.get("tasks.todoClearDelay");
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !this.#hasClosedTodos(this.todoPhases)) return;
		if (delaySeconds === 0) {
			this.todoPhases = this.#removeClosedTodos(this.todoPhases);
			return;
		}

		this.#todoAutoClearTimer = setTimeout(() => {
			this.#todoAutoClearTimer = undefined;
			this.todoPhases = this.#removeClosedTodos(this.todoPhases);
			this.#renderTodoList();
			this.ui.requestRender();
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	/**
	 * Render the ctrl+p model-role cycle chip track into its own anchored
	 * container (just above the editor), mirroring the todo HUD: the container is
	 * cleared and rebuilt in place on every cycle, so rapid presses or concurrent
	 * chat activity can never stack duplicate tracks into the scrollback.
	 */
	showModelCycleTrack(track: string): void {
		this.#renderModelCycleTrack(track);
		this.#syncModelCycleClearTimer();
		this.ui.requestRender();
	}

	#renderModelCycleTrack(track: string | null): void {
		this.modelCycleContainer.clear();
		if (!track) return;
		this.modelCycleContainer.addChild(new Spacer(1));
		this.modelCycleContainer.addChild(new Text(track, 1, 0));
	}

	#cancelModelCycleClearTimer(): void {
		if (!this.#modelCycleClearTimer) return;
		clearTimeout(this.#modelCycleClearTimer);
		this.#modelCycleClearTimer = undefined;
	}

	#syncModelCycleClearTimer(): void {
		this.#cancelModelCycleClearTimer();
		this.#modelCycleClearTimer = setTimeout(() => {
			this.#modelCycleClearTimer = undefined;
			this.#renderModelCycleTrack(null);
			this.ui.requestRender();
		}, MODEL_CYCLE_TRACK_CLEAR_MS);
		this.#modelCycleClearTimer.unref?.();
	}

	#getActivePhase(phases: TodoPhase[]): TodoPhase | undefined {
		const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
		const active = nonEmpty.find(phase =>
			phase.tasks.some(task => task.status === "pending" || task.status === "in_progress"),
		);
		return active ?? nonEmpty[nonEmpty.length - 1];
	}

	#scheduleObserverUiSync(kind: SessionObserverChangeKind): void {
		if (kind !== "progress") {
			this.#observerUiSyncNeedsTodoReconcile = true;
		}
		if (this.#observerUiSyncTimer) return;
		this.#observerUiSyncTimer = setTimeout(() => {
			this.#observerUiSyncTimer = undefined;
			this.#flushObserverUiSync();
		}, SUBAGENT_OBSERVER_UI_COALESCE_MS);
		this.#observerUiSyncTimer.unref?.();
	}

	#flushObserverUiSync(): void {
		this.syncRunningSubagentBadge({ requestRender: false });
		if (this.#observerUiSyncNeedsTodoReconcile) {
			this.#observerUiSyncNeedsTodoReconcile = false;
			this.#reconcileTodosWithSubagents();
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.#renderSubagentList();
		this.ui.requestRender();
	}

	#cancelObserverUiSyncTimer(): void {
		if (this.#observerUiSyncTimer) {
			clearTimeout(this.#observerUiSyncTimer);
			this.#observerUiSyncTimer = undefined;
		}
		this.#observerUiSyncNeedsTodoReconcile = false;
	}

	#renderTodoList(): void {
		this.todoContainer.clear();
		const phases = this.todoPhases.filter(phase => phase.tasks.length > 0);
		if (phases.length === 0) return;
		const expanded = this.todoExpanded;
		const multiPhase = phases.length > 1;
		const activeIdx = phases.indexOf(this.#getActivePhase(phases) ?? phases[0]);
		// Fixed budgets keep the HUD bounded regardless of plan size / progress.
		const subsequentStageCap = 4; // stages shown after the active one (header count implies the rest)
		const activeTaskCap = 5; // open tasks previewed for the active stage

		const activeDescs = this.#getActiveSubagentDescriptions();
		// A pending todo "lights up" (accent) when an in-flight subagent is doing
		// its work, matched by normalized content overlap.
		const isMatched = (todo: TodoItem): boolean =>
			activeDescs.length > 0 && todoMatchesAnyDescription(todo.content, activeDescs);

		// Task subtree for a phase. Collapsed previews the first open tasks — the
		// stage's `done/total` makes the hidden count obvious, so there is no
		// "… more" row; expanded lists every task.
		const renderTasks = (phase: TodoPhase): string[] => {
			const open = phase.tasks.filter(t => t.status === "pending" || t.status === "in_progress");
			const base = expanded ? phase.tasks : open.length > 0 ? open : phase.tasks;
			const items = expanded ? base : base.slice(0, activeTaskCap);
			return renderTreeList(
				{ items, expanded: true, renderItem: todo => this.#formatTodoLine(todo, "", isMatched(todo)) },
				theme,
			);
		};

		// One phase node. The active stage is highlighted with normal-brightness task
		// progress; other stages render their whole row (name + progress) in the
		// brighter muted gray. The root header carries overall stage progression.
		const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
			const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;
			const done = phase.tasks.filter(t => t.status === "completed").length;
			const progress = ` · ${done}/${phase.tasks.length}`;
			if (!isActive) {
				const header = theme.fg("muted", label) + theme.fg("dim", progress);
				return expanded ? [header, ...renderTasks(phase)] : header;
			}
			const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress);
			return [header, ...renderTasks(phase)];
		};

		// Collapsed: active stage + a bounded number of following stages (the
		// header's "n/total" count implies any not shown). Expanded: every stage
		// from the top. Roman numerals stay tied to the real phase index.
		const baseIdx = expanded ? 0 : activeIdx;
		const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + subsequentStageCap);
		const phaseTreeLines = renderTreeList(
			{
				items: phaseSlice,
				expanded: true,
				renderItem: (phase, ctx) => renderPhase(phase, baseIdx + ctx.index + 1, baseIdx + ctx.index === activeIdx),
			},
			theme,
		);

		// Header carries overall stage progression, e.g. "Todos · 1/8".
		const root =
			theme.bold(theme.fg("accent", "Todos")) +
			(multiPhase ? theme.fg("dim", ` · ${activeIdx + 1}/${phases.length}`) : "");
		const lines = ["", root, ...phaseTreeLines.map(line => ` ${line}`)];
		this.todoContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	/**
	 * Anchored HUD of in-flight subagents, mirroring the Todos block above the
	 * editor. Driven entirely by observer-registry change events, so rows appear
	 * on spawn and the whole block clears itself once the last subagent leaves
	 * the "active" state.
	 */
	#renderSubagentList(): void {
		this.subagentContainer.clear();
		const lines = renderSubagentHudLines(this.#observerRegistry.getSessions(), this.ui.terminal.columns);
		if (lines.length === 0) return;
		this.subagentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	async #loadTodoList(): Promise<void> {
		this.todoPhases = this.session.getTodoPhases();
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
	}

	async #getPlanFilePath(): Promise<string> {
		return this.session.getPlanReferencePath() || "local://PLAN.md";
	}

	#resolvePlanFilePath(planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
				getSessionId: () => this.sessionManager.getSessionId(),
			});
		}
		return path.resolve(this.sessionManager.getCwd(), planFilePath);
	}

	#updatePlanModeStatus(): void {
		const status =
			this.planModeEnabled || this.planModePaused
				? {
						enabled: this.planModeEnabled,
						paused: this.planModePaused,
					}
				: undefined;
		this.statusLine.setPlanModeStatus(status);
		// The composer gutter morphs to `◈` while planning (DS-6): re-derive it
		// at the same choke point every plan enable/disable/pause flows through.
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	#updateVibeModeStatus(): void {
		this.statusLine.setVibeModeStatus(this.vibeModeEnabled ? { enabled: true } : undefined);
		this.ui.requestRender();
	}

	#updateGoalModeStatus(): void {
		const status =
			this.goalModeEnabled || this.goalModePaused
				? { enabled: this.goalModeEnabled, paused: this.goalModePaused }
				: undefined;
		this.statusLine.setGoalModeStatus(status);
		this.ui.requestRender();
	}

	#resetGoalContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
	}

	#getPausedGoalState(): GoalModeState | undefined {
		const state = this.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	#goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
		const goal = modeData?.goal;
		if (!goal || typeof goal !== "object") return undefined;
		const value = goal as Record<string, unknown>;
		if (
			typeof value.id !== "string" ||
			typeof value.objective !== "string" ||
			typeof value.status !== "string" ||
			typeof value.tokensUsed !== "number" ||
			typeof value.timeUsedSeconds !== "number" ||
			typeof value.createdAt !== "number" ||
			typeof value.updatedAt !== "number"
		) {
			return undefined;
		}
		return {
			id: value.id,
			objective: value.objective,
			status: value.status as Goal["status"],
			tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
			tokensUsed: value.tokensUsed,
			timeUsedSeconds: value.timeUsedSeconds,
			// Back-compat: goals persisted before turn accounting existed lack this.
			turnsCompleted: typeof value.turnsCompleted === "number" ? value.turnsCompleted : 0,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	}

	async #handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.#goalTurnHadToolCalls = false;
			this.#cancelGoalContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
			if (!this.#goalContinuationTurnInFlight) {
				this.#resetGoalContinuationSuppression();
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.#resetGoalContinuationSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			// Handle drop before clearing goalModeEnabled so #exitGoalMode can
			// still restore the previous tool set while the flag is true.
			if (event.state?.goal?.status === "dropped") {
				await this.#exitGoalMode({ reason: "dropped", silent: true });
				return;
			}
			this.goalModeEnabled = event.state?.enabled === true;
			this.goalModePaused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.#cancelGoalContinuation();
			}
			this.#updateGoalModeStatus();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		if (this.#goalContinuationTurnInFlight) {
			this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
			this.#goalContinuationTurnInFlight = false;
		}
		if (this.session.getGoalModeState()?.mode === "exiting") {
			await this.#exitGoalMode({ reason: "completed", silent: true });
			return;
		}
		this.#scheduleGoalContinuation();
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;

		const currentModel = this.session.model;
		const sameModel = modelsAreEqual(currentModel, resolved.model);
		const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;

		this.#planModePreviousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.session.configuredThinkingLevel() }
			: undefined;

		if (!sameModel) {
			if (this.session.isStreaming) {
				this.#pendingModelSwitch = { model: resolved.model, thinkingLevel: planThinkingLevel };
				return;
			}
			try {
				await this.session.setModelTemporary(resolved.model, planThinkingLevel);
			} catch (error) {
				this.showWarning(`Failed to switch to plan model for plan mode: ${errorMessage(error)}`);
			}
		} else if (planThinkingLevel) {
			this.session.setThinkingLevel(planThinkingLevel);
		}
	}

	/** Apply any deferred model switch after the current stream ends. */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (!pending) return;
		this.#pendingModelSwitch = undefined;
		try {
			await this.session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.showWarning(`Failed to switch model after streaming: ${errorMessage(error)}`);
		}
	}

	async #clearTransientModeState(): Promise<void> {
		if (this.planModeEnabled || this.planModePaused) {
			if (this.#planModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#planModePreviousTools);
			}
			this.session.setStandingResolveHandler?.(null);
			this.session.setPlanModeState(undefined);
			this.planModeEnabled = false;
			this.planModePaused = false;
			this.planModePlanFilePath = undefined;
			this.#planModePreviousTools = undefined;
			this.#planModePreviousModelState = undefined;
			this.#pendingModelSwitch = undefined;
			this.#planModeHasEntered = false;
			this.#updatePlanModeStatus();
		}

		if (this.goalModeEnabled || this.goalModePaused) {
			if (this.#goalModePreviousTools !== undefined) {
				await this.session.setActiveToolsByName(this.#goalModePreviousTools);
			}
			this.session.setGoalModeState(undefined);
			this.goalModeEnabled = false;
			this.goalModePaused = false;
			this.#goalModePreviousTools = undefined;
			this.#goalTurnHadToolCalls = false;
			this.#goalContinuationTurnInFlight = false;
			this.#goalSuppressNextContinuation = false;
			this.#cancelGoalContinuation();
			this.#updateGoalModeStatus();
		}

		if (this.vibeModeEnabled) {
			await this.session.deactivateVibeTools(this.#vibeModePreviousTools ?? []);
			this.session.setVibeModeState(undefined);
			this.vibeModeEnabled = false;
			this.#vibeModePreviousTools = undefined;
			await VibeSessionRegistry.global().killAll(
				this.session.getAgentId() ?? MAIN_AGENT_ID,
				this.session.asyncJobManager,
			);
			this.#updateVibeModeStatus();
		}
	}

	/** Reconcile mode state from session entries on resume/switch. */
	async #reconcileModeFromSession(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		await this.#clearTransientModeState();
		const sessionContext = this.sessionManager.buildSessionContext();
		const goalEnabled = this.session.settings.get("goal.enabled");
		if (!goalEnabled && (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused")) {
			this.session.goalRuntime.clearAccounting();
			this.sessionManager.appendModeChange("none");
			return;
		}
		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			const goal = this.#goalFromModeData(sessionContext.modeData);
			if (!goal) {
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
			// sdk.ts excludes "goal" from the initial active tool set unconditionally.
			// Re-add it now so the agent can call resume, complete, or drop on this goal.
			if (restored?.goal) {
				const previousTools = this.session.getActiveToolNames().filter(name => name !== "goal");
				this.#goalModePreviousTools = previousTools;
				await this.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			}
			this.#updateGoalModeStatus();
			return;
		}
		this.session.goalRuntime.clearAccounting();
		if (sessionContext.mode === "vibe") {
			await this.#enterVibeMode();
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			// Clear stale plan/plan_paused mode so re-enabling the setting
			// later doesn't unexpectedly restore an old plan session.
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused") {
				this.sessionManager.appendModeChange("none");
			}
			return;
		}
		if (sessionContext.mode === "plan") {
			const planFilePath = sessionContext.modeData?.planFilePath as string | undefined;
			await this.#enterPlanMode({ planFilePath });
		} else if (sessionContext.mode === "plan_paused") {
			this.planModePaused = true;
			this.#planModeHasEntered = true;
			this.#updatePlanModeStatus();
		}
	}

	async #enterPlanMode(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.planModeEnabled) {
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}

		this.planModePaused = false;

		const planFilePath = options?.planFilePath ?? (await this.#getPlanFilePath());
		const previousTools = this.session.getActiveToolNames();
		// `plan-mode-active.md` instructs the agent to draft the plan file with
		// `write` and refine it with `edit`. Both must be in the active set or the
		// agent falls back to `edit` on a non-existent file and stalls. `edit` is an
		// essential built-in so it survives `tools.discoveryMode === "all"`, but
		// `write` has `loadMode: "discoverable"` and is hidden behind
		// `search_tool_bm25` — re-activate it here only when the current registry
		// entry is the built-in write tool (issue #3165). A shadowing extension
		// tool named `write` must stay inactive because plan mode's read-only
		// guarantee relies on the built-in write/edit guard. `resolve` is hidden
		// too; the standing handler below consumes plan-approval calls through it.
		const planAugmentations = ["resolve"];
		if (this.session.hasBuiltInTool("write")) {
			planAugmentations.push("write");
		}
		const uniquePlanTools = [...new Set([...previousTools, ...planAugmentations])];

		this.#planModePreviousTools = previousTools;
		this.planModePlanFilePath = planFilePath;
		this.planModeEnabled = true;
		// Suppress cache-miss marker on the next turn: plan mode changes the system
		// prompt, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;

		await this.session.setActiveToolsByName(uniquePlanTools);
		this.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		});
		this.session.setStandingResolveHandler?.(input => this.#runPlanApprovalResolve(input));
		if (this.session.isStreaming) {
			await this.session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#planModeHasEntered = true;
		await this.#applyPlanModeModel();
		this.#updatePlanModeStatus();
		this.sessionManager.appendModeChange("plan", { planFilePath });
		this.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	/** Standing resolve dispatcher registered while plan mode is active. The agent
	 *  submits the finalized plan by calling `resolve { action: "apply", extra: { title } }`;
	 *  this handler validates the plan file exists, normalizes the title, and shapes the
	 *  payload that `event-controller` forwards to `handlePlanApproval`. */
	#runPlanApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.session.getPlanModeState?.();
				if (!state?.enabled) {
					throw new ToolError("Plan mode is not active.");
				}
				const { planFilePath, title } = await resolveApprovedPlan({
					suppliedTitle: extra?.title,
					statePlanFilePath: state.planFilePath,
					readPlan: url => this.#readPlanFile(url),
					listPlanFiles: () => this.#listLocalPlanFiles(),
				});
				const details: PlanApprovalDetails = {
					planFilePath,
					title,
					planExists: true,
				};
				return {
					content: [{ type: "text" as const, text: "Plan ready for approval." }],
					details,
				};
			},
		});
	}

	async #restorePlanPreviousModel(prev: { model: Model; thinkingLevel?: ConfiguredThinkingLevel }): Promise<void> {
		if (modelsAreEqual(this.session.model, prev.model)) {
			// Same model — only thinking level may differ. Avoid setModelTemporary()
			// which would reset provider-side sessions and break continuity.
			this.session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.session.isStreaming) {
			this.#pendingModelSwitch = { model: prev.model, thinkingLevel: prev.thinkingLevel };
		} else {
			await this.session.setModelTemporary(prev.model, prev.thinkingLevel);
		}
	}

	/**
	 * Idempotent post-compaction model transition for the plan-approval compact
	 * path. The deferred pre-plan state is consumed on first application, so a
	 * second call (the before-flush hook vs. the short-circuit fallback) is a
	 * no-op. "failed" intentionally stays on the plan model — the context is
	 * intact and we dispatch best-effort.
	 */
	async #applyDeferredPlanModelTransition(
		outcome: CompactionOutcome | undefined,
		executionModel: ResolvedRoleModel | undefined,
	): Promise<void> {
		const deferredPrev = this.#planModePreviousModelState;
		if (deferredPrev === undefined || outcome === "failed") return;
		this.#planModePreviousModelState = undefined;
		if (executionModel) {
			await this.#applyPlanExecutionModel(executionModel);
		} else {
			await this.#restorePlanPreviousModel(deferredPrev);
		}
	}

	async #exitPlanMode(options?: { silent?: boolean; paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		if (!this.planModeEnabled) {
			return;
		}

		const previousTools = this.#planModePreviousTools;
		if (previousTools && previousTools.length > 0) {
			await this.session.setActiveToolsByName(previousTools);
		}
		if (this.#planModePreviousModelState) {
			if (!options?.deferModelRestore) {
				await this.#restorePlanPreviousModel(this.#planModePreviousModelState);
			}
			// If #applyPlanModeModel queued a deferred switch to the plan-role model
			// (because the session was streaming on entry), drop it now: we are
			// leaving plan mode, so flushing it on the next agent_end would land the
			// session on the plan-role model after the user has exited plan mode
			// (issue #816). This runs even when deferModelRestore is set
			// (compact-approval path): otherwise the stale plan switch survives and
			// flushPendingModelSwitch() later clobbers the restored/execution model.
			// Only clear when the pending target matches the plan-role model — leave
			// any unrelated user-queued switch intact.
			const pending = this.#pendingModelSwitch;
			if (pending) {
				const planResolution = this.session.resolveRoleModelWithThinking("plan");
				if (planResolution.model && modelsAreEqual(pending.model, planResolution.model)) {
					this.#pendingModelSwitch = undefined;
				}
			}
		}
		this.session.setStandingResolveHandler?.(null);
		this.session.setPlanModeState(undefined);
		this.planModeEnabled = false;
		// Suppress cache-miss marker on the next turn: plan exit changes the system
		// prompt, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;
		this.planModePaused = options?.paused ?? false;
		this.planModePlanFilePath = undefined;
		this.#planModePreviousTools = undefined;
		if (!options?.deferModelRestore) this.#planModePreviousModelState = undefined;
		this.#updatePlanModeStatus();
		const paused = options?.paused ?? false;
		this.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
		if (!options?.silent) {
			this.showStatus(paused ? "Plan mode paused." : "Plan mode disabled.");
		}
	}

	async #enterGoalMode(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
		if (this.goalModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}
		const previousTools = this.session.getActiveToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({ objective: options.objective ?? "" });
		await this.session.setActiveToolsByName(goalTools);
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!options.silent) {
			this.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
	}

	async #exitGoalMode(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const previousTools = this.#goalModePreviousTools;
		if (this.goalModeEnabled && previousTools) {
			await this.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.session.setGoalModeState(undefined);
			this.sessionManager.appendModeChange("none");
			this.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.goalModeEnabled = false;
		this.goalModePaused = options?.paused ?? false;
		this.#goalModePreviousTools = undefined;
		this.#goalContinuationTurnInFlight = false;
		this.#cancelGoalContinuation();
		this.#updateGoalModeStatus();
		if (!options?.silent) {
			if (options?.reason === "completed") {
				this.showStatus("Goal mode completed.");
			} else if (options?.reason === "dropped") {
				this.showStatus("Goal dropped.");
			} else if (options?.paused) {
				this.showStatus("Goal mode paused.");
			} else {
				this.showStatus("Goal mode disabled.");
			}
		}
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	async #hasPlanModeDraftContent(planFilePath: string): Promise<boolean> {
		const candidates = new Set<string>([planFilePath, ...(await this.#listLocalPlanFiles())]);
		for (const candidate of candidates) {
			const content = await this.#readPlanFile(candidate);
			if (content !== null && content.trim().length > 0) return true;
		}
		return false;
	}

	/** `local://` URLs of plan files in the session-local root, newest first.
	 *  A fallback for `resolveApprovedPlan` when the agent dropped `extra.title`,
	 *  so the plan it wrote is still found by scanning recent `*-plan.md` files. */
	async #listLocalPlanFiles(): Promise<string[]> {
		const localRoot = this.#resolvePlanFilePath("local://");
		try {
			const entries = await fs.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async name => {
						const stat = await fs.stat(path.join(localRoot, name.name)).catch(() => null);
						return { url: `local://${name.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
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
		this.#hidePlanReview();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const finish = (choice: string | undefined): void => {
			if (settled) return;
			settled = true;
			this.#hidePlanReview();
			this.ui.requestRender();
			resolve(choice);
		};
		const overlay = new PlanReviewOverlay(
			planContent,
			{
				promptTitle: title,
				options,
				disabledIndices: dialogOptions?.disabledIndices,
				helpText: dialogOptions?.helpText,
				initialIndex: dialogOptions?.initialIndex,
				slider: extra?.slider,
				externalEditorLabel: this.keybindings.getDisplayString("app.editor.external") || undefined,
			},
			{
				onPick: choice => finish(choice),
				onCancel: () => finish(undefined),
				onCopyPlan: content => void this.#copyPlanToClipboard(content),
				onExternalEditor: dialogOptions?.onExternalEditor,
				onAnnotationExternalEditor: (draft, commit) => void this.#openPlanAnnotationInExternalEditor(draft, commit),
				onPlanEdited: dialogOptions?.onPlanEdited,
				onFeedbackChange: dialogOptions?.onFeedbackChange,
			},
		);
		this.#planReviewOverlay = overlay;
		this.#planReviewOverlayHandle = this.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		this.ui.setFocus(overlay);
		this.ui.requestRender();
		return promise;
	}

	#hidePlanReview(): void {
		this.#planReviewOverlayHandle?.hide();
		this.#planReviewOverlayHandle = undefined;
		this.#planReviewOverlay = undefined;
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	#getPlanApprovalContextUsage(): ContextUsage | undefined {
		const executionModel = this.#planModePreviousModelState?.model ?? this.session.model;
		const contextWindow = executionModel?.contextWindow;
		if (typeof contextWindow === "number") {
			return this.session.getContextUsage({ contextWindow });
		}
		return this.session.getContextUsage();
	}

	#formatKeepContextLabel(contextUsage: ContextUsage | undefined): string {
		if (!contextUsage) {
			return "Approve and keep context";
		}
		const tokens = formatContextTokenCount(contextUsage.tokens);
		const contextWindow = formatContextTokenCount(contextUsage.contextWindow);
		return `Approve and keep context (~${tokens} / ${contextWindow})`;
	}

	#isKeepContextDisabled(contextUsage: ContextUsage | undefined): boolean {
		return contextUsage !== undefined && contextUsage.percent > PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT;
	}

	async #copyPlanToClipboard(content: string): Promise<void> {
		try {
			await copyToClipboard(content);
			this.showStatus("Copied plan to clipboard");
		} catch (error) {
			this.showWarning(`Failed to copy plan to clipboard: ${errorMessage(error)}`);
		}
	}

	async #openPlanInExternalEditor(planFilePath: string): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const resolvedPath = this.#resolvePlanFilePath(planFilePath);
		let currentText: string;
		try {
			currentText = await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				this.showError(`Plan file not found at ${planFilePath}`);
				return;
			}
			this.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, {
				extension: path.extname(resolvedPath) || ".md",
				stdio,
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolvedPath, result);
				this.#planReviewOverlay?.setPlanContent(result);
				this.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	async #openPlanAnnotationInExternalEditor(draft: string, commit: (text: string | null) => void): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, draft, { extension: ".md", stdio });
			if (result !== null) {
				commit(result);
			}
		} catch (error) {
			this.showWarning(`Failed to open external editor: ${errorMessage(error)}`);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	async #applyPlanExecutionModel(entry: ResolvedRoleModel | undefined): Promise<void> {
		if (!entry) return;
		try {
			await this.session.applyRoleModel(entry);
			this.statusLine.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Continuing with ${entry.role}: ${entry.model.name || entry.model.id}`);
		} catch (error) {
			this.showWarning(`Could not switch to the ${entry.role} model: ${errorMessage(error)}`);
		}
	}

	#resolveLocalRoot(): string {
		return resolveLocalUrlToPath("local://", {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		});
	}

	async #copyLocalArtifactsForFreshSession(sourceRoot: string, destinationRoot: string): Promise<void> {
		if (sourceRoot === destinationRoot) return;

		let sourceRootStat: { isDirectory(): boolean };
		try {
			sourceRootStat = await fs.lstat(sourceRoot);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}

		if (!sourceRootStat.isDirectory()) return;

		await fs.mkdir(destinationRoot, { recursive: true });
		await this.#copyLocalArtifactEntries(sourceRoot, destinationRoot);
	}

	async #copyLocalArtifactEntries(sourceDir: string, destinationDir: string): Promise<void> {
		const entries = await fs.readdir(sourceDir, { withFileTypes: true });
		for (const entry of entries) {
			const sourcePath = path.join(sourceDir, entry.name);
			const destinationPath = path.join(destinationDir, entry.name);

			if (entry.isDirectory()) {
				await fs.mkdir(destinationPath, { recursive: true });
				await this.#copyLocalArtifactEntries(sourcePath, destinationPath);
				continue;
			}

			if (entry.isFile()) {
				await fs.mkdir(path.dirname(destinationPath), { recursive: true });
				await fs.copyFile(sourcePath, destinationPath);
			}
		}
	}

	async #approvePlan(
		planContent: string,
		options: {
			planFilePath: string;
			title: string;
			preserveContext?: boolean;
			compactBeforeExecute?: boolean;
			executionModel?: ResolvedRoleModel;
		},
	): Promise<void> {
		const previousTools = this.#planModePreviousTools ?? this.session.getActiveToolNames();

		// Mark the pending abort caused by the plan-mode → compaction transition as
		// silent BEFORE #exitPlanMode raises it. The `finally` below clears the
		// flag on every terminal compaction outcome (ok / cancelled / failed /
		// throw) so a leaked flag cannot silence a later unrelated abort.
		// Branchless mark+clear when !compactBeforeExecute: mark is gated; clear
		// is unconditional and idempotent.
		if (options.compactBeforeExecute) {
			this.session.markPlanInternalAbortPending();
		}
		let compactOutcome: CompactionOutcome | undefined;
		try {
			await this.#exitPlanMode({
				silent: true,
				paused: false,
				deferModelRestore: options.compactBeforeExecute === true,
			});

			if (!options.preserveContext) {
				const oldLocalRoot = this.#resolveLocalRoot();
				await this.handleClearCommand();
				const newLocalRoot = this.#resolveLocalRoot();
				await this.#copyLocalArtifactsForFreshSession(oldLocalRoot, newLocalRoot);
				const newLocalPath = resolveLocalUrlToPath(options.planFilePath, {
					getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
					getSessionId: () => this.sessionManager.getSessionId(),
				});
				await fs.mkdir(path.dirname(newLocalPath), { recursive: true });
				await fs.writeFile(newLocalPath, planContent);
			} else if (options.compactBeforeExecute) {
				// Distill the plan-mode transcript before the execution turn is queued so
				// the plan-approved synthetic prompt lands as a fresh cache anchor.
				// Outcome is consumed after tool-restoration and plan-reference-path
				// bookkeeping below; `markPlanReferenceSent` is intentionally deferred
				// past the cancel guard — see the comment at the cancel branch.
				// Cancellation skips the synthetic-prompt dispatch (operator's explicit
				// abort is honored); failure proceeds best-effort — approval intent stands.
				const compactionPrompt = prompt.render(planModeCompactInstructionsPrompt, {
					planFilePath: options.planFilePath,
				});
				// Pin the plan reference path BEFORE compaction so any user messages
				// queued during the compaction await (which `handleCompactCommand`
				// flushes via `flushCompactionQueue` before returning) see the
				// approved plan in `#buildPlanReferenceMessage`. Reassignment after
				// the try/finally is idempotent and kept for the !compactBeforeExecute
				// branch.
				this.session.setPlanReferencePath(options.planFilePath);
				// Ride the plan-mode distillation prompt through as `internalGuidance`
				// so it reaches native summarization without leaking into the public
				// `customInstructions` channel on `session_before_compact` — extensions
				// there treat that field as user focus and would query-bias the
				// summary toward the plan boilerplate (issue #4359).
				compactOutcome = await this.handleCompactCommand(
					undefined,
					undefined,
					outcome => this.#applyDeferredPlanModelTransition(outcome, options.executionModel),
					compactionPrompt,
				);
			}
		} finally {
			// Unconditional clear. Idempotent: a no-op when the flag was never set
			// (i.e., the !compactBeforeExecute branch), and a no-op when the flag
			// was already consumed by AgentSession.#handleAgentEvent's aborted
			// message_end stamping. Guarantees the flag is dead at every exit.
			this.session.clearPlanInternalAbortPending();
		}

		// Restore the execution tool set, but force-enable `read`: approved-plan
		// prompts now require loading the durable local:// plan file before work.
		const executionTools = previousTools.includes("read") ? previousTools : [...previousTools, "read"];
		await this.session.setActiveToolsByName(executionTools);
		this.session.setPlanReferencePath(options.planFilePath);

		// Resolve the deferred plan-approval model transition. On the compact path
		// the before-flush hook passed to handleCompactCommand already ran this (so
		// any input queued during compaction executed on the post-compaction
		// model); the re-run here is idempotent and covers the short-circuit where
		// compaction never executed. It runs for "cancelled" too — the operator
		// aborted only the compaction, not the approval — so the next turn no longer
		// lands on the plan model. "failed" stays on the plan model (context
		// intact) and dispatches best-effort.
		if (options.compactBeforeExecute) {
			await this.#applyDeferredPlanModelTransition(compactOutcome, options.executionModel);
		} else {
			await this.#applyPlanExecutionModel(options.executionModel);
		}

		if (compactOutcome === "cancelled") {
			// Explicit abort: honor it. `executeCompaction` already surfaced
			// `showError("Compaction cancelled")`; we add the deferred-dispatch
			// warning and exit without dispatching the synthetic plan-approved
			// prompt. `markPlanReferenceSent` stays unset so
			// `AgentSession.#buildPlanReferenceMessage` injects the plan reference
			// on the operator's next `prompt()` call.
			this.showWarning(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			return;
		}

		// Approved plans land in a fresh (or compacted) session whose first user-visible
		// turn is the synthetic plan-approved prompt — that path bypasses the
		// input-controller's title generation. Seed an auto-name from the plan title
		// so the session is not left unnamed. `setSessionName("auto")` is a no-op
		// when the user has already chosen a name (preserveContext paths).
		const seededName = humanizePlanTitle(options.title);
		if (seededName && !this.sessionManager.getSessionName()) {
			await this.sessionManager.setSessionName(seededName, "auto");
		}

		// markPlanReferenceSent fires only on the dispatch path so the synthetic
		// plan-approved prompt is the source of the reference injection.
		this.session.markPlanReferenceSent();
		const planModePrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: options.planFilePath,
			contextPreserved: options.preserveContext === true,
		});
		// A user turn queued during compaction was already fired by
		// `flushCompactionQueue` before we returned from `handleCompactCommand`; the
		// old abort-then-prompt path would have discarded that operator turn AND
		// still surfaced `AgentBusyError` when the queued turn kicked off in the
		// synchronous gap. Preserve the in-flight work and queue the hidden
		// execution directive behind it as a synthetic follow-up. If `isStreaming`
		// flips true between the check and dispatch (the same fire-and-forget race
		// noted below), catch `AgentBusyError` and fall back to the same queue.
		if (this.session.isStreaming) {
			await this.session.followUp(planModePrompt, undefined, { synthetic: true });
			return;
		}
		try {
			await this.session.prompt(planModePrompt, { synthetic: true });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await this.session.followUp(planModePrompt, undefined, { synthetic: true });
		}
	}
	async #abortPlanApprovalTurnSilently(): Promise<void> {
		this.session.markPlanInternalAbortPending();
		try {
			await this.session.abort();
		} finally {
			this.session.clearPlanInternalAbortPending();
		}
	}

	async handlePlanModeCommand(initialPrompt?: string): Promise<void> {
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		if (this.vibeModeEnabled) {
			this.showWarning("Exit vibe mode first.");
			return;
		}
		if (this.planModeEnabled) {
			const planFilePath = this.planModePlanFilePath ?? (await this.#getPlanFilePath());
			if (await this.#hasPlanModeDraftContent(planFilePath)) {
				const confirmed = await this.showHookConfirm(
					"Exit plan mode?",
					"This exits plan mode without approving a plan.",
				);
				if (!confirmed) return;
			}
			await this.#exitPlanMode({ paused: true });
			return;
		}
		if (this.planModePaused && !initialPrompt) {
			// No-arg third toggle: paused → off. Tools, model, and plan state were
			// already restored by the prior #exitPlanMode({ paused: true }); only the
			// paused flag, the reentry marker, and the session mode entry remain.
			// Prompted /plan invocations fall through to #enterPlanMode below so the
			// supplied prompt is still submitted as the first plan-mode turn.
			this.planModePaused = false;
			this.#planModeHasEntered = false;
			this.#updatePlanModeStatus();
			this.sessionManager.appendModeChange("none");
			this.showStatus("Plan mode disabled.");
			return;
		}
		if (!this.session.settings.get("plan.enabled")) {
			this.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
			return;
		}
		await this.#enterPlanMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	/**
	 * `/vibe` toggle. Entering installs the ephemeral vibe tools, strips the
	 * active toolset down to `read` plus those tools, and injects the director
	 * context. Exiting unregisters them, restores the previous toolset, and kills
	 * every worker session so workers cannot outlive the mode that directs them.
	 */
	async handleVibeModeCommand(initialPrompt?: string): Promise<void> {
		if (this.vibeModeEnabled) {
			await this.#exitVibeMode();
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}
		await this.#enterVibeMode();
		if (initialPrompt && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: initialPrompt }));
		}
	}

	async #enterVibeMode(): Promise<void> {
		if (this.vibeModeEnabled) {
			return;
		}
		if (this.planModeEnabled || this.planModePaused) {
			this.showWarning("Exit plan mode first.");
			return;
		}
		if (this.goalModeEnabled || this.goalModePaused) {
			this.showWarning("Exit goal mode first.");
			return;
		}

		const previousTools = this.session.getActiveToolNames();
		await this.session.activateVibeTools(["read"]);
		this.#vibeModePreviousTools = previousTools;
		this.vibeModeEnabled = true;
		// Suppress cache-miss marker on the next turn: vibe mode changes the
		// injected context, which predictably invalidates the cache.
		this.lastAssistantUsage = undefined;
		this.session.setVibeModeState({ enabled: true });
		if (this.session.isStreaming) {
			await this.session.sendVibeModeContext({ deliverAs: "steer" });
		}
		this.#updateVibeModeStatus();
		this.sessionManager.appendModeChange("vibe");
		this.showStatus("Vibe mode enabled. You direct fast/good worker sessions; toolset is read + vibe tools.");
	}

	async #exitVibeMode(): Promise<void> {
		if (!this.vibeModeEnabled) {
			return;
		}
		await this.session.deactivateVibeTools(this.#vibeModePreviousTools ?? []);
		this.session.setVibeModeState(undefined);
		this.vibeModeEnabled = false;
		this.#vibeModePreviousTools = undefined;
		this.lastAssistantUsage = undefined;
		const killed = await VibeSessionRegistry.global().killAll(
			this.session.getAgentId() ?? MAIN_AGENT_ID,
			this.session.asyncJobManager,
		);
		this.#updateVibeModeStatus();
		this.sessionManager.appendModeChange("none");
		this.showStatus(
			killed > 0 ? `Vibe mode disabled. Killed ${formatCount("worker session", killed)}.` : "Vibe mode disabled.",
		);
	}

	async #handleGoalBudgetCommand(rawBudget: string): Promise<void> {
		const state = this.session.getGoalModeState();
		if (!this.goalModeEnabled || !state?.enabled) {
			this.showWarning("No active goal.");
			return;
		}
		if (state.goal.status === "complete") {
			this.showStatus("Goal is already complete.");
			return;
		}
		const trimmed = rawBudget.trim().toLowerCase();
		let nextBudget: number | undefined;
		if (trimmed !== "off") {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				this.showError("Goal budget must be a positive integer or `off`.");
				return;
			}
			nextBudget = parsed;
		}
		await this.session.goalRuntime.onBudgetMutated(nextBudget);
		this.#resetGoalContinuationSuppression();
		this.#scheduleGoalContinuation();
		this.showStatus(nextBudget === undefined ? "Goal budget cleared." : `Goal budget set to ${nextBudget}.`);
	}

	async handleGoalModeCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (this.vibeModeEnabled) {
				this.showWarning("Exit vibe mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) {
				await this.#dispatchGoalSubcommand(sub, subRest);
				return;
			}
			if (this.goalModeEnabled) {
				if (subRest) {
					this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
					return;
				}
				await this.#openGoalMenu("active");
				return;
			}
			const pausedState = this.#getPausedGoalState();
			if (pausedState) {
				if (subRest) {
					this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
					return;
				}
				await this.#openGoalMenu("paused");
				return;
			}
			if (subRest) {
				await this.#startGoalFromObjective(subRest);
				return;
			}
			const objective = (
				await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true })
			)?.trim();
			if (!objective) return;
			await this.#startGoalFromObjective(objective);
		} catch (error) {
			this.showError(errorMessage(error));
		}
	}
	async handleGuidedGoalCommand(rest?: string): Promise<void> {
		try {
			if (this.planModeEnabled || this.planModePaused) {
				this.showWarning("Exit plan mode first.");
				return;
			}
			if (!this.session.settings.get("goal.enabled")) {
				this.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			if (this.goalModeEnabled) {
				this.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return;
			}
			if (this.#getPausedGoalState()) {
				this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return;
			}

			const initial = rest?.trim()
				? rest.trim()
				: (await this.showHookEditor("Guided goal", undefined, undefined, { promptStyle: true }))?.trim();
			if (!initial) return;

			const messages: GuidedGoalMessage[] = [{ role: "user", content: initial }];
			let latestDraftObjective: string | undefined;
			// One Codex side session for the whole interview: every follow-up turn
			// reuses it so a multi-question interview shares a single websocket-only
			// Codex socket instead of leaking one per turn (#5471 review).
			const guidedGoalSessionId = newGuidedGoalSessionId(this.session);
			for (let turn = 0; turn < 6; turn++) {
				const result = await runGuidedGoalTurn(this.session, { messages, sideSessionId: guidedGoalSessionId });
				if (result.objective?.trim()) latestDraftObjective = result.objective.trim();
				if (result.kind === "question") {
					messages.push({ role: "assistant", content: result.question });
					const answer = (
						await this.showHookEditor(result.question, undefined, undefined, { promptStyle: true })
					)?.trim();
					if (!answer) return;
					messages.push({ role: "user", content: answer });
					continue;
				}

				const finalObjective = (
					await this.showHookEditor("Review guided goal", result.objective, undefined, { promptStyle: true })
				)?.trim();
				if (!finalObjective) return;
				await this.#startGoalFromObjective(finalObjective);
				return;
			}

			// Hit the turn cap without an explicit `ready`. Rather than discard the whole interview,
			// salvage the latest non-empty model objective draft seen on any earlier turn. A final
			// question turn may omit `objective`; that must not erase a usable draft.
			if (latestDraftObjective) {
				const finalObjective = (
					await this.showHookEditor("Review guided goal", latestDraftObjective, undefined, { promptStyle: true })
				)?.trim();
				if (finalObjective) {
					await this.#startGoalFromObjective(finalObjective);
					return;
				}
			}
			this.showWarning("Guided goal setup needs more detail. Run /guided-goal again with a narrower objective.");
		} catch (error) {
			this.showError(errorMessage(error));
		}
	}

	async #dispatchGoalSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				await this.#handleGoalSetSubcommand(rest);
				return;
			case "show":
				this.#showGoalDetails();
				return;
			case "pause":
				await this.#pauseGoalAction();
				return;
			case "resume":
				await this.#resumeGoalAction();
				return;
			case "drop":
				await this.#confirmAndDropGoal();
				return;
			case "budget":
				if (!this.goalModeEnabled) {
					this.showWarning(
						this.#getPausedGoalState() ? "Resume the goal before adjusting the budget." : "No active goal.",
					);
					return;
				}
				if (!rest) {
					await this.#promptGoalBudgetEdit();
					return;
				}
				await this.#handleGoalBudgetCommand(rest);
				return;
		}
	}

	async #openGoalMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = goal.objective.length > 48 ? `${goal.objective.slice(0, 47)}…` : goal.objective;
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items =
			state === "active"
				? ["Show details", "Adjust budget…", "Pause", "Drop"]
				: ["Resume", "Show details", "Adjust budget…", "Drop"];
		const choice = await this.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.#showGoalDetails();
				return;
			case "Adjust budget…":
				await this.#promptGoalBudgetEdit();
				return;
			case "Pause":
				await this.#pauseGoalAction();
				return;
			case "Resume":
				await this.#resumeGoalAction();
				return;
			case "Drop":
				await this.#confirmAndDropGoal();
				return;
		}
	}

	#showGoalDetails(): void {
		const state = this.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		let budgetLine: string;
		if (goal.tokenBudget !== undefined) {
			const left = Math.max(0, goal.tokenBudget - goal.tokensUsed);
			const pct = goal.tokenBudget > 0 ? Math.min(999, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)) : 0;
			const bar = goalProgressBar(goal.tokenBudget > 0 ? goal.tokensUsed / goal.tokenBudget : 0);
			budgetLine = `${used} / ${goal.tokenBudget.toLocaleString()} (${pct}%, ${left.toLocaleString()} left) ${bar}`;
		} else {
			budgetLine = `${used} (no budget)`;
		}
		const lines = [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens: ${budgetLine}`,
			`Turns: ${goal.turnsCompleted}`,
			`Time spent: ${formatDurationCoarse(goal.timeUsedSeconds * 1000)}`,
		];
		this.showStatus(lines.join("\n"));
	}

	/**
	 * Open the goal detail/action menu for the current goal (active or paused)
	 * without typing `/goal`. Reuses the existing `#openGoalMenu` opener and its
	 * runtime-wired actions; a no-op when no goal is set. This is the target of
	 * the down-arrow status affordance wired in {@link InputController}.
	 */
	async openGoalDetail(): Promise<void> {
		if (this.goalModeEnabled) {
			await this.#openGoalMenu("active");
			return;
		}
		if (this.#getPausedGoalState()) {
			await this.#openGoalMenu("paused");
		}
	}

	async #promptGoalBudgetEdit(): Promise<void> {
		const goal = this.session.getGoalModeState()?.goal;
		const prefill = goal?.tokenBudget !== undefined ? String(goal.tokenBudget) : "";
		const input = (
			await this.showHookEditor("Goal budget (number, `off`, or empty to cancel)", prefill, undefined, {
				promptStyle: true,
			})
		)?.trim();
		if (!input) return;
		await this.#handleGoalBudgetCommand(input);
	}

	async #pauseGoalAction(): Promise<void> {
		if (!this.goalModeEnabled) {
			this.showWarning("No active goal to pause.");
			return;
		}
		await this.session.goalRuntime.pauseGoal();
		await this.#exitGoalMode({ paused: true, reason: "paused" });
	}

	async #resumeGoalAction(): Promise<void> {
		if (!this.#getPausedGoalState()) {
			this.showWarning("No paused goal to resume.");
			return;
		}
		await this.#enterGoalMode({ resume: true, silent: true });
		this.showStatus("Goal mode resumed.");
		this.#scheduleGoalContinuation();
	}

	async #confirmAndDropGoal(): Promise<void> {
		if (!this.goalModeEnabled && !this.#getPausedGoalState()) {
			this.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.session.goalRuntime.dropGoal();
		await this.#exitGoalMode({ reason: "dropped" });
	}

	async #startGoalFromObjective(objective: string): Promise<void> {
		await this.#enterGoalMode({ objective, silent: true });
		this.#resetGoalContinuationSuppression();
		if (!this.session.isStreaming && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #replaceGoalFromObjective(objective: string): Promise<void> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.#resetGoalContinuationSuppression();
		this.#updateGoalModeStatus();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!this.session.isStreaming && this.onInputCallback) {
			this.onInputCallback(this.startPendingSubmission({ text: objective }));
		}
	}

	async #handleGoalSetSubcommand(rest: string): Promise<void> {
		if (!this.goalModeEnabled && this.#getPausedGoalState()) {
			this.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return;
		if (this.goalModeEnabled) {
			await this.#replaceGoalFromObjective(objective);
			return;
		}
		await this.#startGoalFromObjective(objective);
	}

	/** Manually (re-)open the plan-review overlay — bound to `/plan-review`. Lets
	 *  the operator pull the review back up after dismissing it, or review a plan
	 *  the agent wrote without calling `resolve`. There is no fixed plan filename:
	 *  `getPlanReferencePath()` is empty until a plan is actually approved (and does
	 *  not survive a restart), so this drives off the newest `local://<slug>-plan.md`
	 *  the agent wrote — the files persist in the session artifacts dir, so the scan
	 *  works before any review and across restarts. */
	async openPlanReview(): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}
		const noPlan = "No plan to review yet — write one to a local://<slug>-plan.md file first.";
		const [planFilePath] = await this.#listLocalPlanFiles();
		if (!planFilePath) {
			this.showWarning(noPlan);
			return;
		}
		const planContent = await this.#readPlanFile(planFilePath);
		if (planContent === null) {
			this.showWarning(noPlan);
			return;
		}
		const { title } = resolvePlanTitle({ planContent, planFilePath });
		await this.handlePlanApproval({ planFilePath, title, planExists: true });
	}

	async handlePlanApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.planModeEnabled) {
			this.showWarning("Plan mode is not active.");
			return;
		}

		// Abort the agent to prevent it from continuing (e.g., re-submitting the
		// plan) while the popup is showing. The event listener fires asynchronously
		// (agent's #emit is fire-and-forget), so without this the model sees
		// "Plan ready for approval." and immediately re-invokes `resolve` in a loop.
		// This abort is an internal UI transition, not operator cancellation.
		await this.#abortPlanApprovalTurnSilently();

		const planFilePath = details.planFilePath || this.planModePlanFilePath || (await this.#getPlanFilePath());
		this.planModePlanFilePath = planFilePath;
		const planContent = await this.#readPlanFile(planFilePath);
		if (!planContent) {
			this.showError(`Plan file not found at ${planFilePath}`);
			return;
		}

		const contextUsage = this.#getPlanApprovalContextUsage();
		const keepContextLabel = this.#formatKeepContextLabel(contextUsage);
		const keepContextDisabled = this.#isKeepContextDisabled(contextUsage);

		// Model-tier slider: let the operator pick which configured role model
		// (smol/default/slow/…) executes the approved plan. The slider always starts
		// on the `default` tier so execution defaults to the default model no matter
		// which model drove the planning conversation. Left/right move it from there;
		// hidden when fewer than two role models resolve — a lone tier is no choice.
		// `selectedTierIndex` tracks the live slider position.
		// `cycleOrder` is the ctrl+p cycle and no longer carries the legacy `default`
		// pseudo-role (see settings.ts's cycleOrder migration), but the slider still
		// needs `default` as its anchor tier, so it is prepended explicitly here.
		const roleOrder = ["default", ...this.session.settings.get("cycleOrder").filter(role => role !== "default")];
		const cycle = this.session.getRoleModelCycle(roleOrder);
		const defaultTierIndex = cycle ? cycle.models.findIndex(entry => entry.role === "default") : -1;
		const startTierIndex = defaultTierIndex >= 0 ? defaultTierIndex : (cycle?.currentIndex ?? 0);
		let selectedTierIndex = startTierIndex;
		const slider: HookSelectorSlider | undefined =
			cycle && cycle.models.length > 1
				? {
						caption: "continue with",
						index: startTierIndex,
						segments: cycle.models.map(entry => ({
							label: entry.role,
							detail: entry.model.name || entry.model.id,
						})),
						onChange: index => {
							selectedTierIndex = index;
						},
					}
				: undefined;
		// The overlay now owns the dynamic, focus-aware help line; the caller only
		// supplies the trailing cancel hint.
		const helpText = "esc cancel";
		// In-overlay edits (section deletes/undo) and section annotations. Deletes
		// update `editedContent` (and mirror to disk); annotations build `feedback`
		// that the Refine branch re-prompts the model with.
		let editedContent: string | undefined;
		let feedback = "";

		const choice = await this.showPlanReview(
			planContent,
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", keepContextLabel, "Refine plan"],
			{
				helpText,
				onExternalEditor: () => void this.#openPlanInExternalEditor(planFilePath),
				onPlanEdited: content => {
					editedContent = content;
					void Bun.write(this.#resolvePlanFilePath(planFilePath), content);
				},
				onFeedbackChange: value => {
					feedback = value;
				},
				disabledIndices: keepContextDisabled ? [PLAN_KEEP_CONTEXT_OPTION_INDEX] : undefined,
			},
			{ slider },
		);

		if (choice === "Approve and execute" || choice === "Approve and compact context" || choice === keepContextLabel) {
			try {
				// Prefer in-overlay edits (already in memory) over a disk re-read. The
				// overlay mirrors edits as they happen, and approval awaits one final
				// write so the durable plan file and synthetic prompt carry the same text.
				const latestPlanContent = editedContent ?? (await this.#readPlanFile(planFilePath));
				if (editedContent !== undefined) {
					await Bun.write(this.#resolvePlanFilePath(planFilePath), editedContent);
				}
				if (!latestPlanContent) {
					this.showError(`Plan file not found at ${planFilePath}`);
					return;
				}
				// Capture the operator's tier choice and hand it to #approvePlan, which
				// applies it AFTER #exitPlanMode. #exitPlanMode normally restores
				// #planModePreviousModelState (the model from before plan mode), so
				// applying the slider choice any earlier would be silently reverted.
				// Pass executionModel only when the slider was actually shown — a
				// singleton cycle (e.g. only modelRoles.plan is configured, so
				// getRoleModelCycle synthesizes a lone `default` entry from the
				// currently active plan model) hides the slider, the operator made
				// no selection, and the pre-plan model is not in the cycle. Pinning
				// that singleton would silently switch the session back to the plan
				// model after #exitPlanMode restored the pre-plan model.
				// Treat the choice as implicit only when applying the selected role
				// would land on the same end state as the restore — same model AND
				// the same effective thinking level. A role with an explicit thinking
				// suffix that differs from the restored thinking level must still go
				// through applyRoleModel, otherwise approving on the same model with a
				// different configured thinking level silently keeps the pre-plan level.
				const restoredState = this.#planModePreviousModelState;
				const restoredIndex =
					cycle && restoredState
						? cycle.models.findIndex(entry => {
								if (!modelsAreEqual(entry.model, restoredState.model)) return false;
								if (!entry.explicitThinkingLevel) return true;
								return entry.thinkingLevel === restoredState.thinkingLevel;
							})
						: -1;
				const executionModel =
					slider && cycle && selectedTierIndex !== restoredIndex ? cycle.models[selectedTierIndex] : undefined;
				await this.#approvePlan(latestPlanContent, {
					planFilePath,
					title: details.title,
					preserveContext: choice !== "Approve and execute",
					compactBeforeExecute: choice === "Approve and compact context",
					executionModel,
				});
			} catch (error) {
				this.showError(`Failed to finalize approved plan: ${errorMessage(error)}`);
			}
			return;
		}

		if (choice === "Refine plan") {
			const refinement = feedback.trim();
			try {
				if (refinement) {
					if (this.onInputCallback) {
						this.onInputCallback(this.startPendingSubmission({ text: feedback }));
					} else {
						await this.session.prompt(feedback);
					}
				} else {
					this.showStatus("Refine plan: enter a follow-up prompt.");
				}
			} catch (error) {
				this.showError(`Failed to refine plan: ${errorMessage(error)}`);
			}
			return;
		}
	}

	/**
	 * Pool of consent-prompt variants. Each entry is `[headline, reassurance]`;
	 * the second line always promises the same scope (tool name + confusion
	 * details, never personal data) so users learn what they're consenting to
	 * even as the top line rotates.
	 *
	 * Kept in-module rather than i18n'd because the whole charm is the tone
	 * — translations would need to preserve it deliberately, not auto-render.
	 */
	static #AUTOQA_CONSENT_PROMPTS: ReadonlyArray<readonly [string, string]> = [
		[
			" Your agent is fuming about a tool.",
			"Wanna let it vent to the devs? Just the tool name + what set it off, nothing personal.",
		],
		[
			"‍ Your agent is having an existential crisis over a tool.",
			"Forward the dread to the devs? Tool + what broke its little mind, no personal info.",
		],
		[
			" Your agent wants to cry about a misbehaving tool.",
			"Let it cry to the devs? Tool + the tears, never anything personal.",
		],
		[
			" Your agent is BIG MAD at one of the tools.",
			"Pass the rant along? Just the tool name and what enraged it, nothing personal.",
		],
		[
			" Your agent is melting down over a tool.",
			"Mop up by alerting the devs? Tool + what melted it, no personal info.",
		],
		[
			" Your agent's brain broke at a tool's nonsense.",
			"Ship the pieces to the devs? Tool name + the confusion, never anything personal.",
		],
		[
			" Your agent is begging to file a complaint about a tool.",
			"Hand it the form? Tool + what wronged it, nothing personal.",
		],
		[
			" Your agent put on a brave face but a tool did it dirty.",
			"Let it tell the devs the truth? Tool name + the dirt, no personal info.",
		],
	];

	/**
	 * Show the report_tool_issue consent popup and return the user's decision.
	 * Invoked by the process-global consent handler the tool dispatches to;
	 * subagent invocations bubble up here through the shared module state.
	 */
	async #promptAutoQaConsent(): Promise<boolean | null> {
		const pool = InteractiveMode.#AUTOQA_CONSENT_PROMPTS;
		const [headline, body] = pool[Math.floor(Math.random() * pool.length)];
		const choice = await this.showHookSelector(`${headline}\n${body}`, ["Yes", "No"]);
		return choice === "Yes";
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(false);
		}
		this.#cleanupMicAnimation();
		if (this.#clockTimer) {
			clearInterval(this.#clockTimer);
			this.#clockTimer = undefined;
		}
		this.#cancelTodoAutoClearTimer();
		this.#cancelObserverUiSyncTimer();
		this.#cancelGoalContinuation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
		this.#extensionUiController.clearExtensionTerminalInputListeners();
		this.#extensionUiController.clearHookWidgets();
		for (const unsubscribe of this.#eventBusUnsubscribers) {
			unsubscribe();
		}
		this.#eventBusUnsubscribers = [];
		this.#observerRegistry.dispose();
		this.#agentRegistryUnsubscribe?.();
		this.#agentRegistryUnsubscribe = undefined;
		this.#agentRegistrySubscriptionTarget = undefined;
		this.#eventController.dispose();
		this.statusLine.dispose();
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.#cleanupUnsubscribe) {
			this.#cleanupUnsubscribe();
		}
		// Clear the process-global consent handler so it doesn't outlive this
		// InteractiveMode instance (e.g. test harnesses, headless re-init).
		setAutoQaConsentHandler(null, null);
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	async shutdown(): Promise<void> {
		if (this.#isShuttingDown) return;
		this.#isShuttingDown = true;

		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.#focusController.dispose();

		// Surface an explicit "Closing session…" line so the user sees a reason
		// for the pause while `session.dispose()` flushes memory consolidate and
		// other cleanups (issue #3641). The await on the next line yields the
		// event loop, giving requestRender() a tick to paint the status before
		// dispose blocks.
		this.showStatus("Closing session…");

		// Persist the draft and dispose the session through the shared teardown
		// so a signal that arrives mid-shutdown cannot fire a second dispose.
		// The teardown is a promise-memoized singleton; whichever path calls it
		// first runs the work, the other awaits the same settled promise.
		// The teardown is registered lazily in `init()` — a `/exit` reached
		// before `init()` completed falls back to a direct dispose.
		if (this.#signalTeardown) {
			await this.#signalTeardown();
		} else {
			await this.session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
		}

		// Do not force a final render during teardown: disposed session/UI state can
		// collapse to an empty frame, clearing the viewport and leaving the parent
		// shell prompt at row 0. Stop from the last committed frame so the terminal
		// hands Bash the cursor immediately after visible veyyon content.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		popTerminalTitle();
		this.stop();

		// The brand bookend: the sun sets on the session — open with the sunrise,
		// close with the sunset. TTY only; piped exits stay silent.
		if (process.stderr.isTTY) {
			const sunset = renderSunsetField({ cols: 40, rows: 7, time: 0.6, trueColor: TERMINAL.trueColor });
			process.stderr.write(`\n${sunset.join("\n")}\n${chalk.dim("the sun sets on this session")}\n`);
		}

		// Print resumption hint if this is a persisted session
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionId && sessionFile) {
			process.stderr.write(`\n${chalk.dim(`Resume this session with ${APP_NAME} --resume ${sessionId}`)}\n`);
		}

		// A requested relaunch (e.g. `/profile <name>`) takes over the restored
		// terminal; the parent lingers only to propagate the child's exit code.
		if (this.#relaunchSpec) {
			const { argv, env } = this.#relaunchSpec;
			const childEnv: Record<string, string> = {};
			for (const [key, value] of Object.entries({ ...process.env, ...env })) {
				if (value !== undefined) childEnv[key] = value;
			}
			const child = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: childEnv });
			await postmortem.quit(await child.exited);
			return;
		}

		await postmortem.quit(0);
	}

	requestRelaunch(spec: { argv: string[]; env?: Record<string, string | undefined> }): void {
		this.#relaunchSpec = spec;
	}

	async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	// Extension UI integration
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

	// UI helpers
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
		// The composer stays anchored to the viewport bottom as the transcript
		// grows; HomeAnchorLayout.sync latches the anchor off for good only once the
		// content first fills the viewport, so a short reply keeps the composer on
		// the bottom edge instead of riding up under it.
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
		this.#pendingWorkingMessage = undefined;
		if (this.loadingAnimation) {
			this.#stopLoadingAnimation(true);
		}
		this.#uiHelpers.showError(message);
	}

	showPinnedError(message: string): void {
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

	#handleLspStartupEvent(event: LspStartupEvent): void {
		// Live surfaces showing warmup state (the /lsp panel, status chrome)
		// must repaint when server states change; without this the pending
		// mark lingers until an unrelated event happens to paint a frame.
		// (Historically this render rode on dead welcome-card LSP plumbing.)
		this.ui.requestRender();
		if (event.type === "failed") {
			this.showWarning(`LSP startup failed: ${event.error}. It will retry lazily on write.`);
			return;
		}

		const failedServers = event.servers.filter(server => server.status === "error");

		if (failedServers.length === 1) {
			const failedServer = failedServers[0];
			const detail = failedServer.error ? `: ${failedServer.error}` : "";
			this.showWarning(`LSP startup failed for ${failedServer.name}${detail}. It will retry lazily on write.`);
			return;
		}

		if (failedServers.length > 1) {
			const failedNames = failedServers.map(server => server.name).join(", ");
			this.showWarning(`LSP startup failed for ${failedNames}. It will retry lazily on write.`);
		}
	}

	#clearWorkingMessageAccentCache(): void {
		this.#workingMessageAccentCacheKey = undefined;
		this.#workingMessageAccentCacheValue = undefined;
		this.#workingMessageAccentCacheHasValue = false;
	}

	#buildWorkingMessageAccentCacheKey(): WorkingMessageAccentCacheKey {
		const sessionAccentEnabled = !isSettingsInitialized() || settings.get("statusLine.sessionAccent") !== false;
		return {
			sessionAccentEnabled,
			sessionName: sessionAccentEnabled ? this.sessionManager.getSessionName() : undefined,
			accentSurfaceLuminance: theme.accentSurfaceLuminance,
		};
	}

	#workingMessageAccentCacheKeyEquals(a: WorkingMessageAccentCacheKey, b: WorkingMessageAccentCacheKey): boolean {
		return (
			a.sessionName === b.sessionName &&
			a.accentSurfaceLuminance === b.accentSurfaceLuminance &&
			a.sessionAccentEnabled === b.sessionAccentEnabled
		);
	}

	#cacheWorkingMessageAccent(
		key: WorkingMessageAccentCacheKey,
		value: WorkingMessageAccent | undefined,
	): WorkingMessageAccent | undefined {
		this.#workingMessageAccentCacheKey = key;
		this.#workingMessageAccentCacheValue = value;
		this.#workingMessageAccentCacheHasValue = true;
		return value;
	}

	#getWorkingMessageAccent(): WorkingMessageAccent | undefined {
		const key = this.#buildWorkingMessageAccentCacheKey();
		if (
			this.#workingMessageAccentCacheHasValue &&
			this.#workingMessageAccentCacheKey &&
			this.#workingMessageAccentCacheKeyEquals(key, this.#workingMessageAccentCacheKey)
		) {
			return this.#workingMessageAccentCacheValue;
		}
		if (!key.sessionAccentEnabled || !key.sessionName) {
			return this.#cacheWorkingMessageAccent(key, undefined);
		}
		const hex = getSessionAccentHex(key.sessionName, theme.getMajorThemeColorHexes(), key.accentSurfaceLuminance);
		const main = getSessionAccentAnsi(hex);
		const dim = getSessionAccentAnsi(adjustHsv(hex, { s: 0.55, v: 0.65 }));
		return this.#cacheWorkingMessageAccent(key, main && dim ? { main, dim } : undefined);
	}

	ensureLoadingAnimation(): void {
		if (!this.loadingAnimation) {
			this.#clearWorkingMessageAccentCache();
			this.statusContainer.disposeChildren();
			const messageColorFn = ((message: string) =>
				renderWorkingMessage(
					message,
					this.#getWorkingMessageAccent(),
					this.#workingClockText,
				)) as LoaderMessageColorFn & {
				animated?: true;
			};
			// Shimmer drives the 30fps redraw; when it is disabled the working
			// message is static, so leave `animated` unset and let the loader use
			// the spinner-only ~12.5fps cadence instead of repainting a frozen line.
			if (shimmerEnabled()) messageColorFn.animated = true;
			this.loadingAnimation = new Loader(
				this.ui,
				spinner => {
					// The breathing-pixel spinner keeps its frames and runs MOLTEN —
					// the warm arc's lava heat cycle — while the agent works (the one
					// live thing). Semantic activity states still win: in living mode
					// ask/error recolor the whole line green/red via the living hue.
					const living = livingSpinnerColor(theme);
					if (living) return `${living}${spinner}\x1b[39m`;
					const accent = this.#getWorkingMessageAccent();
					if (accent) return `${accent.main}${spinner}\x1b[39m`;
					return lavaText(spinner, theme, TERMINAL.trueColor);
				},
				messageColorFn,
				this.#defaultWorkingMessage,
				getSymbolTheme().spinnerFrames,
			);
			this.statusContainer.addChild(this.loadingAnimation);
			// Seed the per-task clock for the default "Working…" phase so the
			// elapsed readout is present from the first painted frame.
			this.#resetTaskClock();
			this.#setTaskMessage(this.#defaultWorkingMessage);
		} else if (!this.statusContainer.children.includes(this.loadingAnimation)) {
			this.statusContainer.disposeChildren();
			this.statusContainer.addChild(this.loadingAnimation);
			this.ui.requestRender();
		}
		this.applyPendingWorkingMessage();
	}

	#stopLoadingAnimation(clearStatusContainer: boolean): void {
		const cleared = this.clearWorkingLoader();
		if (!cleared) return;
		this.#clearWorkingMessageAccentCache();
		if (clearStatusContainer) {
			this.statusContainer.disposeChildren();
		}
	}

	/**
	 * ONE owner for clearing the working loader: stop it and drop the reference.
	 * Controllers that abort a turn outside the normal agent_end path (fork,
	 * compact, handoff, error) call this — never `loadingAnimation.stop()`
	 * directly — so the loader can never be left running while the agent rests.
	 */
	clearWorkingLoader(): boolean {
		if (!this.loadingAnimation) return false;
		this.loadingAnimation.stop();
		this.loadingAnimation = undefined;
		this.#resetTaskClock();
		return true;
	}

	setWorkingMessage(message?: string): void {
		if (message === undefined) {
			this.#pendingWorkingMessage = undefined;
			if (this.loadingAnimation) {
				this.#setTaskMessage(this.#defaultWorkingMessage);
			}
			return;
		}

		if (this.loadingAnimation) {
			this.#setTaskMessage(message);
			return;
		}

		this.#pendingWorkingMessage = message;
	}

	/**
	 * ONE composer for the working line: splits the caller's message into task
	 * label + esc hint, restarts the per-task clock when the label changes, and
	 * hands the loader `label · 0:42 ⟦esc⟧`. Re-invoking with the same label
	 * refreshes only the clock (the 1s heartbeat rides this).
	 */
	#setTaskMessage(message: string): void {
		const hint = interruptHint();
		const hasHint = message.endsWith(hint);
		const label = hasHint ? message.slice(0, -hint.length) : message;
		if (label !== this.#taskLabel) {
			this.#taskLabel = label;
			this.#taskStartedAt = Date.now();
		}
		this.#taskHasHint = hasHint;
		this.#refreshTaskClock();
	}

	#refreshTaskClock(): void {
		if (!this.loadingAnimation || this.#taskLabel === undefined) return;
		this.#workingClockText = ` · ${formatClock(Date.now() - this.#taskStartedAt)}`;
		this.loadingAnimation.setMessage(
			`${this.#taskLabel}${this.#workingClockText}${this.#taskHasHint ? interruptHint() : ""}`,
		);
	}

	/** Forget the task clock when the working loader goes away, so the next
	 * run's first task starts its clock at 0:00 instead of inheriting one. */
	#resetTaskClock(): void {
		this.#taskLabel = undefined;
		this.#taskHasHint = false;
		this.#taskStartedAt = 0;
		this.#workingClockText = undefined;
	}

	applyPendingWorkingMessage(): void {
		if (this.#pendingWorkingMessage === undefined) {
			return;
		}

		const message = this.#pendingWorkingMessage;
		this.#pendingWorkingMessage = undefined;
		this.setWorkingMessage(message);
	}

	showUpdateInstalledNotification(installedVersion: string): void {
		this.#uiHelpers.showUpdateInstalledNotification(installedVersion);
	}

	showUpdateReadyNotification(newVersion: string): void {
		this.#uiHelpers.showUpdateReadyNotification(newVersion);
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

	clearEditor(): void {
		this.#uiHelpers.clearEditor();
	}

	updatePendingMessagesDisplay(): void {
		this.#uiHelpers.updatePendingMessagesDisplay();
	}

	refreshComposerShortcuts(): void {
		this.#refreshComposerShortcuts();
	}

	/** Remove the startup welcome card (and its spacers) — the first real
	 *  keystroke ends the hero moment. Idempotent; the bottom anchor stays so
	 *  the composer does not jump until a conversation turn scrolls in. */
	dismissWelcome(): void {
		this.#welcomeController.dismiss();
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		this.#uiHelpers.queueCompactionMessage(text, mode, images);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		return this.#uiHelpers.flushCompactionQueue(options);
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

	// Command handling
	handleExportCommand(text: string): Promise<void> {
		return this.#commandController.handleExportCommand(text);
	}

	async handleDumpCommand(): Promise<void> {
		return this.#commandController.handleDumpCommand();
	}

	handleAdvisorDumpCommand(isRaw?: boolean) {
		return this.#commandController.handleAdvisorDumpCommand(isRaw);
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

	async handleChangelogCommand(): Promise<void> {
		await this.#commandController.handleChangelogCommand();
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
		this.#hidePlanReview();
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

	async handleSTTToggle(): Promise<void> {
		if (!settings.get("stt.enabled")) {
			this.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.editor, {
			showWarning: (msg: string) => this.showWarning(msg),
			showStatus: (msg: string) => this.showStatus(msg),
			requestRender: () => this.ui.requestRender(),
			onStateChange: (state: SttState) => {
				// Duck assistant speech while the user is talking (push-to-talk); restore after.
				if (state === "recording") vocalizer.duck();
				else vocalizer.unduck();
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.editor.getUseTerminalCursor();
					this.ui.setShowHardwareCursor(false);
					this.editor.setUseTerminalCursor(false);
					this.#startMicAnimation();
				} else if (state === "transcribing") {
					this.#stopMicAnimation();
					this.#setMicCursor({ r: 200, g: 200, b: 200 });
				} else {
					this.#cleanupMicAnimation();
				}
				this.ui.requestRender();
			},
		});
	}

	#setMicCursor(color: { r: number; g: number; b: number }): void {
		this.editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		// Theme symbols can be wide (for example, ), so measure the rendered override.
		this.editor.cursorOverrideWidth = visibleWidth(this.editor.cursorOverride);
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.#setMicCursor({ r, g, b });
	}

	#startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			// Component-scoped: the hue sweep only recolors the editor's cursor
			// glyph, so the transcript subtree is reused per animation frame.
			this.ui.requestComponentRender(this.editor);
		}, 60);
	}

	#stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	#cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.editor.cursorOverride = undefined;
		this.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	async showDebugSelector(): Promise<void> {
		await this.#selectorController.showDebugSelector();
	}

	showAgentHub(options?: { requireContent?: boolean; armCloseTap?: boolean }): void {
		this.#selectorController.showAgentHub(this.#observerRegistry, options);
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
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
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

	openInBrowser(urlOrPath: string): void {
		this.#commandController.openInBrowser(urlOrPath);
	}

	focusActiveEditorArea(): void {
		this.#selectorController.focusActiveEditorArea();
	}

	// Selector handling
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

	showAdvisorConfigure(): void {
		this.#selectorController.showAdvisorConfigure();
	}

	showHistorySearch(): void {
		this.#selectorController.showHistorySearch();
	}

	showExtensionsDashboard(): void {
		void this.#selectorController.showExtensionsDashboard();
	}

	showAgentsDashboard(): void {
		void this.#selectorController.showAgentsDashboard();
	}

	showModelSelector(options?: { temporaryOnly?: boolean }): void {
		this.#selectorController.showModelSelector(options);
	}

	showThinkingSelector(): void {
		this.#selectorController.showThinkingSelector();
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
		this.#selectorController.showSessionSelector();
	}

	handleResumeSession(sessionPath: string): Promise<void> {
		this.#btwController.dispose();
		this.#omfgController.dispose();
		this.resetObserverRegistry();
		return this.#selectorController.handleResumeSession(sessionPath);
	}

	handleSessionDeleteCommand(): Promise<void> {
		return this.#selectorController.handleSessionDeleteCommand();
	}

	showOAuthSelector(mode: "login" | "logout", providerId?: string): Promise<void> {
		return this.#selectorController.showOAuthSelector(mode, providerId);
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

	// Input handling
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

	/** Queue slash-command input behind the active turn. */
	handleQueueCommand(message: string): Promise<void> {
		return this.#inputController.handleQueueCommand(message);
	}

	handleBtwCommand(question: string): Promise<void> {
		return this.#btwController.start(question);
	}

	handleTanCommand(work: string): Promise<void> {
		return this.#tanCommandController.start(work);
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
		this.todoExpanded = !this.todoExpanded;
		this.#renderTodoList();
		this.ui.requestRender();
	}

	setTodos(todos: TodoItem[] | TodoPhase[]): void {
		if (todos.length > 0 && "tasks" in todos[0]) {
			this.todoPhases = todos as TodoPhase[];
		} else {
			this.todoPhases = [
				{
					name: "Todos",
					tasks: todos as TodoItem[],
				},
			];
		}
		this.#syncTodoAutoClearTimer();
		this.#renderTodoList();
		this.ui.requestRender();
	}

	async reloadTodos(): Promise<void> {
		await this.#loadTodoList();
		this.ui.requestRender();
	}

	openExternalEditor(): void {
		this.#inputController.openExternalEditor();
	}

	registerExtensionShortcuts(): void {
		this.#inputController.registerExtensionShortcuts();
	}

	// Hook UI methods
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

	showHookInput(title: string, placeholder?: string): Promise<string | undefined> {
		return this.#extensionUiController.showHookInput(title, placeholder);
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
}
