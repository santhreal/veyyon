import type {
	ApiKey,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Effort,
	ImageContent,
	InstrumentationLevel,
	Message,
	Model,
	ServiceTier,
	SimpleStreamOptions,
	Static,
	streamSimple,
	TextContent,
	Tool,
	ToolChoice,
	ToolResultMessage,
	TSchema,
} from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";

import type { AgentPauseGate } from "./pause";
/** Owned-dialect configuration: a fixed dialect, or a per-model resolver that is */
export type ConfiguredDialect = Dialect | ((model: Model) => Dialect | undefined);

import type { HarmonyAuditEvent } from "@veyyon/ai/utils/harmony-leak";
import type { AppendOnlyContextManager } from "./append-only-context";
import type { AgentRunCoverage, AgentRunSummary } from "./run-collector";
import type { AgentTelemetryConfig } from "./telemetry";

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** An aside entry: a ready {@link AgentMessage}, or a sync thunk evaluated at */
export type AsideMessage = AgentMessage | (() => AgentMessage | null);

export interface AgentTurnEndContext {
	/** Assistant/user message that just completed this turn boundary. */
	message: AgentMessage;
	/** Tool results produced by this turn, already paired with `message` in the live context. */
	toolResults: ToolResultMessage[];
	/** True when the current tool-loop batch is continuing without yielding to post-turn steering. */
	willContinue: boolean;
}

/** A soft tool requirement: the host wants `toolName` called before the loop */
export interface SoftToolRequirement {
	/** Discriminates a soft requirement from a hard {@link ToolChoice}. */
	soft: true;
	/** Stable id of the *current* requirement. The loop injects `reminder` when */
	id: string;
	/** Tool that must be called before the loop runs other tools or yields. */
	toolName: string;
	/** Host-owned reminder messages, injected once per `id` activation. */
	reminder: AgentMessage[];
}

/** A per-turn tool-choice directive: either a hard provider {@link ToolChoice} */
export type ToolChoiceDirective = ToolChoice | SoftToolRequirement;

/** True when a {@link ToolChoiceDirective} is a soft requirement, not a hard choice. */
export function isSoftToolRequirement(directive: ToolChoiceDirective | undefined): directive is SoftToolRequirement {
	return typeof directive === "object" && directive !== null && (directive as SoftToolRequirement).soft === true;
}

/** Source category for a queued steering interrupt observed without consuming the queue. */
export type SteeringInterruptSource = "user" | "system" | "unknown";

/** Non-consuming summary of whether queued steering should interrupt a tool batch. */
export interface SteeringQueueState {
	/** True when at least one steering message is queued. */
	queued: boolean;
	/** Best-effort origin used only to word synthetic skipped-tool results. */
	source?: SteeringInterruptSource;
}

/** The two forms of a tool call's arguments produced by */
export interface ToolCallArgumentTransform {
	/** Fully expanded arguments. Only `tool.execute` and `beforeToolCall` see these. */
	execution: Record<string, unknown>;
	/** Arguments safe to reveal: shown, streamed, traced and recorded. */
	display: Record<string, unknown>;
}

/** Configuration for the agent loop. */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	/** Pause boundary for this loop. Defaults to the process-wide gate used by */
	pauseGate?: AgentPauseGate;

	/** When to interrupt tool execution for steering messages. */
	interruptMode?: "immediate" | "wait";

	/** Optional session identifier forwarded to LLM providers. */
	sessionId?: string;

	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Optional resolver called per LLM request to produce request metadata. */
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;

	/** Converts AgentMessage[] to LLM-compatible Message[] before each LLM call. */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/** Optional transform applied to the context before `convertToLlm`. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/** Optional transform applied to the final provider context after conversion, */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	/** Resolves the API key or resolver for the current model before each LLM call. */
	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

	/** Returns steering messages to inject into the conversation mid-run. */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/** Peeks whether steering messages are queued, without consuming them. */
	hasSteeringMessages?: () => boolean | SteeringQueueState | Promise<boolean | SteeringQueueState>;

	/** Peeks whether IRC messages should interrupt an interruptible waiting tool. */
	hasIrcInterrupts?: () => boolean | Promise<boolean>;

	/** Returns follow-up messages to process after the agent would otherwise stop. */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	/** Returns non-interrupting "aside" messages to inject at a step boundary. */
	getAsideMessages?: () => Promise<AsideMessage[]>;
	/** Hook fired right before the loop would exit. */
	onBeforeYield?: () => Promise<void> | void;

	/** Provides tool execution context, resolved per tool call. */
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	/** Refreshes prompt/tool context from live session state before each model call. */
	syncContextBeforeModelCall?: (context: AgentContext) => void | Promise<void>;

	/** Optional transform applied to tool call arguments, once, straight after */
	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => ToolCallArgumentTransform;

	/** Enable intent tracing for tool calls. */
	intentTracing?: boolean;
	/** How densely each tool call records a study record on its result message. */
	instrumentation?: InstrumentationLevel;
	/** Strip tool descriptions (top-level + nested schema annotations) from the */
	pruneToolDescriptions?: boolean;
	/** Owned tool calling dialect. */
	dialect?: ConfiguredDialect;
	/** When owned (in-band) tool calling is active and the model starts */
	abortOnFabricatedToolResult?: boolean;
	/** Append-only context mode — stabilizes system prompt + tool spec bytes */
	appendOnlyContext?: AppendOnlyContextManager;

	/** Inspect assistant streaming events before they are published to the outer agent event stream. */
	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	/** Called when GPT-5 Harmony protocol leakage is detected and mitigated. */
	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;

	/** Dynamic tool-choice directive, resolved once per turn. Returns a hard */
	getToolChoice?: () => ToolChoiceDirective | undefined;

	/** Dynamic reasoning effort override, resolved per LLM call. */
	getReasoning?: () => Effort | undefined;
	/** Dynamic model override, resolved once per LLM call. When set, each */
	getModel?: () => Model;

	/** Dynamic reasoning-disable override, resolved per LLM call. When set, */
	getDisableReasoning?: () => boolean | undefined;

	/** Per-call effective service-tier resolver. Unlike {@link getReasoning}, */
	getServiceTier?: (model: Model) => ServiceTier | undefined;

	/** Per-call working-directory resolver, read once per LLM call. When set, its */
	getCwd?: () => string | undefined;

	/** Called after a tool call has been validated and is about to execute. */
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	/** Called after a turn ends and before the loop polls steering/asides for the */
	onTurnEnd?: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;

	/** Called once an assistant message is finalized from the model stream, before */
	transformAssistantMessage?: (message: AssistantMessage, signal?: AbortSignal) => Promise<void> | void;

	/** Called after a tool finishes executing, before `tool_execution_end` and the */
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
	/** Schema-based tool-call repair (fix-if-clear, refuse-if-ambiguous), run before */
	repairToolCallArguments?: (tool: AgentTool, toolCall: AgentToolCall) => ToolCallRepairResult;
	/** Opt-in OpenTelemetry instrumentation. Passing `{}` enables the loop's */
	telemetry?: AgentTelemetryConfig;
}

/** Batch/sequencing metadata for the tool call currently being processed. */
export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
}

/** A single tool-call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** Result returned from `beforeToolCall`. */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/** Partial override returned from `afterToolCall`. */
export interface AfterToolCallResult {
	/** If provided, replaces the tool result content array in full. */
	content?: (TextContent | ImageContent)[];
	/** If provided, replaces the tool result details payload in full. */
	details?: unknown;
	/** If provided, replaces the error flag carried with the tool result. */
	isError?: boolean;
	/** If provided, replaces the contextually-useless flag carried with the tool result. */
	useless?: boolean;
}

export type ToolCallRepairStatus = "clean" | "repaired" | "unrepairable";

/** Result from {@link AgentLoopConfig.repairToolCallArguments}. */
export interface ToolCallRepairResult {
	status: ToolCallRepairStatus;
	arguments: Record<string, unknown>;
	hints: readonly string[];
	reason?: string;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Validated tool arguments in their `execution` form — fully expanded, the same */
	args: Record<string, unknown>;
	/** Current agent context at the time the tool call is prepared. */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	toolCall: AgentToolCall;
	/** Tool arguments in their `display` form: the recorded arguments, safe to */
	args: Record<string, unknown>;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	context: AgentContext;
}

/** Extensible interface for custom app messages. */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
}

/** AgentMessage: Union of LLM messages + custom messages. */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** Agent state containing all configuration and conversation data. */
export interface AgentState {
	systemPrompt: string[];
	model: Model;
	thinkingLevel?: Effort;
	disableReasoning?: boolean;
	tools: AnyAgentTool[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T = unknown, _TInput = unknown> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details?: T;
	// Marks a non-throwing failure (e.g. an aggregator catching per-entry errors).
	// agent-loop honors this and surfaces it as a tool error on the wire.
	isError?: boolean;
	/** Marks the result as contextually useless: safe for compaction to elide once consumed (e.g. zero matches, wait timeout). Ignored when isError is set. */
	useless?: boolean;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = unknown, TInput = unknown> = (
	partialResult: AgentToolResult<T, TInput>,
) => void;

/** Options passed to renderResult */
export interface RenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
	/** Current spinner frame index for animated elements (optional) */
	spinnerFrame?: number;
}

/** Capability tier a tool exercises. Determines which approval modes auto-approve it. */
export type ToolTier = "read" | "write" | "exec";

/** Per-tool approval declaration. */
export type ToolApprovalDecision =
	| ToolTier
	| { tier: ToolTier; reason?: string; override?: boolean; critical?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

/** Context passed to tool execution. */
export interface AgentToolContext {
	// Empty by default - apps extend via declaration merging
}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = unknown, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown, TTheme = unknown>
	extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	/** If true, tool is excluded unless explicitly listed in --tools or agent's tools field */
	hidden?: boolean;
	/** If true, tool can stage a pending action that requires explicit resolution via the resolve tool. */
	deferrable?: boolean;
	/** Built-in tool loading behavior. "essential" loads initially; "discoverable" can be activated by tool search. */
	loadMode?: "essential" | "discoverable";
	/** Short one-line summary used for tool discovery indexes. */
	summary?: string;
	/** Concurrency mode for tool scheduling when multiple calls are in one turn. */
	concurrency?: "shared" | "exclusive" | ((args: Partial<Static<TParameters>>) => "shared" | "exclusive");
	/** If true, argument validation errors are non-fatal: raw args are passed to execute() instead of returning an error to the LLM. */
	lenientArgValidation?: boolean;
	/** Whether the agent loop may abort this call mid-execution to deliver a */
	interruptible?: boolean | ((args: Partial<Static<TParameters>>) => boolean);
	/** Controls how the INTENT_FIELD (`i`) is handled for this tool. */
	intent?: "omit" | "optional" | "require" | ((args: Partial<Static<TParameters>>) => string | undefined);

	/** Normalize (potentially partial) streamed arguments into the plain text that */
	matcherDigest?: (args: unknown) => string | undefined;

	/** Surface the target file paths a (potentially partial) streamed call would */
	matcherPaths?: (args: unknown) => readonly string[] | undefined;

	/** Per-file projection of a (potentially partial) streamed call, pairing each */
	matcherEntries?: (args: unknown) => readonly { path: string; digest: string }[] | undefined;

	/** Capability tier declaration used by approval gates. Omitted means "exec". */
	approval?: ToolApproval;

	/** Lines appended after the standard approval prompt header. */
	formatApprovalDetails?: (args: unknown) => string | string[] | undefined;

	/** The main execution callback for this tool. */
	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	/** Optional custom rendering for tool call display (returns UI component) */
	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	/** Optional custom rendering for tool result display (returns UI component) */
	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
	) => unknown;
}

/** Existential tool type for heterogeneous collections. `TDetails` is */
export type AnyAgentTool = AgentTool<any, any, any>;

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string[];
	messages: AgentMessage[];
	tools?: AnyAgentTool[];
}

/** Events emitted by the Agent for UI updates. */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			/** Present iff `AgentTelemetryConfig` was supplied on this run. */
			telemetry?: AgentRunSummary;
			coverage?: AgentRunCoverage;
	  }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError?: boolean;
	  };
