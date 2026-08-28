import type { ImageContent, Message, Model, TextContent } from "@veyyon/ai";
import type { Component, TUI } from "@veyyon/tui";
import type { logger as PiLogger } from "@veyyon/utils";
import type { Type } from "arktype";
import type * as zod from "zod/v4";
import type { ModelRegistry } from "../../config/model-registry";
import type { EditToolDetails } from "../../edit";
import type { ExecOptions, ExecResult } from "../../exec/exec";
import type * as PiCodingAgent from "../../index";
import type { Theme } from "../../modes/theme/theme";
import type { CustomMessagePayload, HookMessage } from "../../session/messages";
import type { ReadonlySessionManager, SessionManager } from "../../session/session-manager";
import type { BashToolDetails, GlobToolDetails, GrepToolDetails, ReadToolDetails } from "../../tools";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	ContextEvent,
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
	SessionSwitchEvent,
	SessionTreeEvent,
	TodoReminderEvent,
	ToolCallEventResult,
	ToolResultEventResult,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";
import type * as TypeBox from "../typebox";

export type { ExecOptions, ExecResult } from "../../exec/exec";

export interface HookUIContext {
	select(title: string, options: string[]): Promise<string | undefined>;

	confirm(title: string, message: string): Promise<boolean>;

	input(title: string, placeholder?: string): Promise<string | undefined>;

	notify(message: string, type?: "info" | "warning" | "error"): void;

	setStatus(key: string, text: string | undefined): void;

	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	): Promise<T>;

	setEditorText(text: string): void;

	getEditorText(): string;

	editor(
		title: string,
		prefill?: string,
		options?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;

	readonly theme: Theme;
}

export interface HookContext {
	ui: HookUIContext;
	hasUI: boolean;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	modelRegistry: ModelRegistry;
	model: Model | undefined;
	obfuscateProviderText(text: string): string;
	isIdle(): boolean;
	abort(): void;
	hasQueuedMessages(): boolean;
}

export interface HookCommandContext extends HookContext {
	waitForIdle(): Promise<void>;

	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	branch(entryId: string): Promise<{ cancelled: boolean }>;

	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
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

export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
}

export type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	TodoReminderEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../shared-events";

export interface ToolCallEvent {
	type: "tool_call";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError?: boolean;
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

export type HookEvent =
	| SessionEvent
	| ContextEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| ToolCallEvent
	| ToolResultEvent;

export interface ContextEventResult {
	messages?: Message[];
}

export type { ToolCallEventResult, ToolResultEventResult } from "../shared-events";

export interface BeforeAgentStartEventResult {
	message?: CustomMessagePayload;
}

export type {
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
} from "../shared-events";

// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements in handlers
export type HookHandler<E, R = undefined> = (event: E, ctx: HookContext) => Promise<R | void> | R | void;

export interface HookMessageRenderOptions {
	expanded: boolean;
}

export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface RegisteredCommand {
	name: string;
	description?: string;

	handler: (args: string, ctx: HookCommandContext) => Promise<void>;
}

export interface HookAPI {
	on(event: "session_start", handler: HookHandler<SessionStartEvent>): void;
	on(event: "session_before_switch", handler: HookHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void;
	on(event: "session_switch", handler: HookHandler<SessionSwitchEvent>): void;
	on(event: "session_before_branch", handler: HookHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>): void;
	on(event: "session_branch", handler: HookHandler<SessionBranchEvent>): void;
	on(
		event: "session_before_compact",
		handler: HookHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compacting", handler: HookHandler<SessionCompactingEvent, SessionCompactingResult>): void;
	on(event: "session_compact", handler: HookHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: HookHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: HookHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: HookHandler<SessionTreeEvent>): void;

	on(event: "context", handler: HookHandler<ContextEvent, ContextEventResult>): void;
	on(event: "before_agent_start", handler: HookHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: HookHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: HookHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: HookHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: HookHandler<TurnEndEvent>): void;
	on(event: "auto_compaction_start", handler: HookHandler<AutoCompactionStartEvent>): void;
	on(event: "auto_compaction_end", handler: HookHandler<AutoCompactionEndEvent>): void;
	on(event: "auto_retry_start", handler: HookHandler<AutoRetryStartEvent>): void;
	on(event: "auto_retry_end", handler: HookHandler<AutoRetryEndEvent>): void;
	on(event: "ttsr_triggered", handler: HookHandler<TtsrTriggeredEvent>): void;
	on(event: "todo_reminder", handler: HookHandler<TodoReminderEvent>): void;
	on(event: "tool_call", handler: HookHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: HookHandler<ToolResultEvent, ToolResultEventResult>): void;

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
	): void;

	appendEntry<T = unknown>(customType: string, data?: T): void;

	registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void;

	registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void;

	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	logger: typeof PiLogger;
	typebox: typeof TypeBox;
	arktype: typeof Type;
	zod: typeof zod;
	pi: typeof PiCodingAgent;
}

export type HookFactory = (pi: HookAPI) => void;

export interface HookError {
	hookPath: string;
	event: string;
	error: string;
}
