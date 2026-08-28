import type { AppendEntryHandler } from "../hooks/loader";

export type { AppendEntryHandler };

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolApproval,
} from "@veyyon/agent-core";
import type { CompactionResult } from "@veyyon/agent-core/compaction";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	ModelSpec,
	ProviderResponseMetadata,
	SimpleStreamOptions,
	Static,
	TextContent,
	TSchema,
} from "@veyyon/ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@veyyon/ai/oauth/types";
import type { AutocompleteItem, AutocompleteProvider, Component, EditorTheme, KeyId, TUI } from "@veyyon/tui";
import type { logger as PiLogger } from "@veyyon/utils";
import type { Type as arktype } from "arktype";
import type * as zod from "zod/v4";
import type { KeybindingsManager } from "../../config/keybindings";
import type { ModelRegistry } from "../../config/model-registry";
import type { EditToolDetails } from "../../edit";
import type { PythonResult } from "../../eval/py/executor";
import type { BashResult } from "../../exec/bash-executor";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type * as PiCodingAgent from "../../index";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { MemoryRuntimeContext } from "../../memory-backend";
import type { CustomEditor } from "../../modes/components/custom-editor";
import type { Theme } from "../../modes/theme/theme";
import type { CompactMode } from "../../session/compact-modes";
import type { CustomMessage, CustomMessagePayload } from "../../session/messages";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type {
	BashToolDetails,
	BashToolInput,
	GlobToolDetails,
	GlobToolInput,
	GrepToolDetails,
	GrepToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../../tools";
import type { ApprovalMode } from "../../tools/approval";
import type { EventBus } from "../../utils/event-bus";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
	GoalUpdatedEvent,
	SessionBeforeBranchEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionStopEvent,
	SessionStopEventResult,
	SessionSwitchEvent,
	SessionTreeEvent,
	TodoReminderEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";
import type { SlashCommandInfo } from "../slash-commands";
import type * as TypeBox from "../typebox";

export type { AppKeybinding, KeybindingsManager } from "../../config/keybindings";
export type { ExecOptions, ExecResult } from "../../exec/exec";
export type { AgentToolResult, AgentToolUpdateCallback };

export interface ExtensionUISelectOption {
	label: string;
	description?: string;
}

export type ExtensionUISelectItem = string | ExtensionUISelectOption;

export interface ExtensionAskDialogOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface ExtensionAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: ExtensionAskDialogOption[];
	multi?: boolean;
	recommended?: number;
	preselected?: string[];
}

export interface ExtensionAskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

export interface ExtensionAskDialogSubmitResult {
	kind: "submit";
	results: ExtensionAskDialogResultItem[];
}

export interface ExtensionAskDialogChatResult {
	kind: "chat";
}

export type ExtensionAskDialogResult = ExtensionAskDialogSubmitResult | ExtensionAskDialogChatResult;

export function getExtensionUISelectOptionLabel(option: ExtensionUISelectItem): string {
	return typeof option === "string" ? option : option.label;
}

export interface ExtensionUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	onTimeout?: () => void;
	onTimeoutStart?: () => void;
	onTimeoutReset?: () => void;
	initialIndex?: number;
	secret?: boolean;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	selectionMarker?: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount?: number;
}

export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

export type WidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionWidgetOptions {
	placement?: WidgetPlacement;
}

export type ExtensionUiComponent = Component & { dispose?(): void };
export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;
export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

export interface ExtensionUIContext {
	timeoutStartsOnPresentation?: boolean;
	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;

	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean>;

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined>;

	askDialog?(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined>;

	notify(message: string, type?: "info" | "warning" | "error"): void;

	onTerminalInput(handler: TerminalInputHandler): () => void;

	setStatus(key: string, text: string | undefined): void;

	setWorkingMessage(message?: string): void;

	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;

	setFooter(factory: ExtensionUiComponentFactory | undefined): void;

	setHeader(factory: ExtensionUiComponentFactory | undefined): void;

	setTitle(title: string): void;

	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: { overlay?: boolean },
	): Promise<T>;

	setEditorText(text: string): void;

	pasteToEditor(text: string): void;

	getEditorText(): string;

	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	setEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void;

	readonly theme: Theme;

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]>;

	getTheme(name: string): Promise<Theme | undefined>;

	setTheme(theme: string | Theme): Promise<{ success: boolean; error?: string }>;

	getToolsExpanded(): boolean;

	setToolsExpanded(expanded: boolean): void;
}

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface CompactOptions {
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
	mode?: CompactMode;
	internalGuidance?: string;
}

export interface ExtensionModelQuery {
	list(): Model[];
	current(): Model | undefined;
	resolve(spec: string): Model | undefined;
	family(model: Model): string;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	getContextUsage(): ContextUsage | undefined;
	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
	hasUI: boolean;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	modelRegistry: ModelRegistry;
	localProtocolOptions?: LocalProtocolOptions;
	obfuscateProviderText?: (text: string) => string;
	model: Model | undefined;
	models: ExtensionModelQuery;
	isIdle(): boolean;
	abort(): void;
	hasPendingMessages(): boolean;
	shutdown(): void;
	getSystemPrompt(): string[];
	memory?: MemoryRuntimeContext;
}

export interface ExtensionCommandContext extends ExtensionContext {
	getContextUsage(): ContextUsage | undefined;

	waitForIdle(): Promise<void>;

	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	branch(entryId: string): Promise<{ cancelled: boolean }>;

	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;

	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;

	reload(): Promise<void>;

	compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
}

export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
}

export interface ToolSessionEvent {
	reason: "start" | "switch" | "branch" | "tree" | "shutdown";
	previousSessionFile: string | undefined;
}

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: TParams;
	hidden?: boolean;
	defaultInactive?: boolean;
	deferrable?: boolean;
	approval?: ToolApproval;
	mcpServerName?: string;
	mcpToolName?: string;
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	onSession?: (event: ToolSessionEvent, ctx: ExtensionContext) => void | Promise<void>;

	renderCall?: (args: Static<TParams>, options: ToolRenderResultOptions, theme: Theme) => Component;

	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		args?: Static<TParams>,
	) => Component;
}

export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

export type {
	ContextEvent,
	SessionBeforeBranchEvent,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionBranchEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionSwitchEvent,
	SessionTreeEvent,
	TreePreparation,
} from "../shared-events";

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

export interface AfterProviderResponseEvent extends ProviderResponseMetadata {
	type: "after_provider_response";
}

export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string[];
}

export type {
	AgentEndEvent,
	AgentStartEvent,
	SessionStopEvent,
	SessionStopEventResult,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
}

export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export type {
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	TodoReminderEvent,
	TtsrTriggeredEvent,
} from "../shared-events";

export interface CredentialDisabledEvent {
	type: "credential_disabled";
	provider: string;
	disabledCause: string;
}

export interface UserBashEvent {
	type: "user_bash";
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

export interface UserPythonEvent {
	type: "user_python";
	code: string;
	excludeFromContext: boolean;
	cwd: string;
}

export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: "interactive" | "rpc" | "extension";
}

export interface ToolApprovalRequestedEvent {
	type: "tool_approval_requested";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	reason?: string;
	approvalMode: ApprovalMode;
}

export interface ToolApprovalResolvedEvent {
	type: "tool_approval_resolved";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	approved: boolean;
	reason?: string;
}

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: Record<string, unknown>;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface GlobToolCallEvent extends ToolCallEventBase {
	toolName: "glob";
	input: GlobToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| GlobToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface GlobToolResultEvent extends ToolResultEventBase {
	toolName: "glob";
	details: GlobToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| GlobToolResultEvent
	| CustomToolResultEvent;

export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "glob", event: ToolCallEvent): event is GlobToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

export type ExtensionEvent =
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| SessionStopEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| GoalUpdatedEvent
	| CredentialDisabledEvent
	| UserBashEvent
	| UserPythonEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent
	| ToolApprovalRequestedEvent
	| ToolApprovalResolvedEvent;

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export type { ToolCallEventResult } from "../shared-events";

export interface InputEventResult {
	handled?: boolean;
	text?: string;
	images?: ImageContent[];
}

export interface UserBashEventResult {
	result?: BashResult;
}

export interface UserPythonEventResult {
	result?: PythonResult;
}

export type { ToolResultEventResult } from "../shared-events";

export interface BeforeAgentStartEventResult {
	message?: CustomMessagePayload;
	systemPrompt?: string | string[];
}

export type {
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
} from "../shared-events";

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface AssistantThinkingRenderContext {
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => Component | undefined;

export interface RegisteredCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

export interface ExtensionAPI {
	logger: typeof PiLogger;

	typebox: typeof TypeBox;

	arktype: typeof arktype;
	zod: typeof zod;

	pi: typeof PiCodingAgent;

	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_switch", handler: ExtensionHandler<SessionSwitchEvent>): void;
	on(
		event: "session_before_branch",
		handler: ExtensionHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>,
	): void;
	on(event: "session_branch", handler: ExtensionHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compacting", handler: ExtensionHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "session_stop", handler: ExtensionHandler<SessionStopEvent, SessionStopEventResult>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "auto_compaction_start", handler: ExtensionHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: ExtensionHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: ExtensionHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: ExtensionHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: ExtensionHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: ExtensionHandler<TodoReminderEvent>): void;
	on(event: "goal_updated", handler: ExtensionHandler<GoalUpdatedEvent>): void;
	on(event: "credential_disabled", handler: ExtensionHandler<CredentialDisabledEvent>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	on(event: "tool_approval_requested", handler: ExtensionHandler<ToolApprovalRequestedEvent>): void;
	on(event: "tool_approval_resolved", handler: ExtensionHandler<ToolApprovalResolvedEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "user_python", handler: ExtensionHandler<UserPythonEvent, UserPythonEventResult>): void;

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void;

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	setLabel(entryIdOrLabel: string, label?: string | undefined): void;

	getFlag(name: string): boolean | string | undefined;

	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void;

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	appendEntry<T = unknown>(customType: string, data?: T): void;

	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	getActiveTools(): string[];

	getAllTools(): string[];

	setActiveTools(toolNames: string[]): Promise<void>;

	getCommands(): SlashCommandInfo[];

	setModel(model: Model): Promise<boolean>;

	getThinkingLevel(): ThinkingLevel | undefined;

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void;

	getSessionName(): string | undefined;

	setSessionName(name: string): Promise<void>;

	registerProvider(name: string, config: ProviderConfig): void;

	events: EventBus;
}

export interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
	fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly ProviderModelConfig[]>;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	reasoning: boolean;
	thinking?: Model["thinking"];
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	premiumMultiplier?: number;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export interface RegisteredTool<TParams extends TSchema = TSchema, TDetails = unknown> {
	definition: ToolDefinition<TParams, TDetails>;
	extensionPath: string;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: CustomMessagePayload<T>,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type GetActiveToolsHandler = () => string[];

export type GetAllToolsHandler = () => string[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => Promise<void>;

export type SetModelHandler = (model: Model) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel | undefined;

export type SetThinkingLevelHandler = (level: ThinkingLevel, persist?: boolean) => void;

export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }>;
}

export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setLabel: (targetId: string, label: string | undefined) => void;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
	getSessionName: () => string | undefined;
	setSessionName: (name: string) => Promise<void>;
}

export interface ExtensionContextActions {
	getModel: () => Model | undefined;
	isIdle: () => boolean;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	getSystemPrompt: () => string[];
	obfuscateProviderText?: (text: string) => string;
}

export interface ExtensionCommandContextActions {
	getContextUsage: () => ContextUsage | undefined;
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	branch: (entryId: string) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
	compact: (instructionsOrOptions?: string | CompactOptions) => Promise<void>;
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

export interface LoadedExtension {
	path: string;
	resolvedPath: string;
	label?: string;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool<any, any>>;
	assistantThinkingRenderers: AssistantThinkingRenderer[];
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

export interface LoadExtensionsResult {
	extensions: LoadedExtension[];
	errors: Array<{ path: string; error: string }>;
	withheld: Array<{ path: string; reason: string }>;
	runtime: ExtensionRuntime;
}

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
