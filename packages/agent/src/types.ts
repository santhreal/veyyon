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
export type ConfiguredDialect = Dialect | ((model: Model) => Dialect | undefined);

import type { HarmonyAuditEvent } from "@veyyon/ai/utils/harmony-leak";
import type { AppendOnlyContextManager } from "./append-only-context";
import type { AgentRunCoverage, AgentRunSummary } from "./run-collector";
import type { AgentTelemetryConfig } from "./telemetry";

export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type AsideMessage = AgentMessage | (() => AgentMessage | null);

export interface AgentTurnEndContext {
	message: AgentMessage;
	toolResults: ToolResultMessage[];
	willContinue: boolean;
}

export interface SoftToolRequirement {
	soft: true;
	id: string;
	toolName: string;
	reminder: AgentMessage[];
}

export type ToolChoiceDirective = ToolChoice | SoftToolRequirement;

export function isSoftToolRequirement(directive: ToolChoiceDirective | undefined): directive is SoftToolRequirement {
	return typeof directive === "object" && directive !== null && (directive as SoftToolRequirement).soft === true;
}

export type SteeringInterruptSource = "user" | "system" | "unknown";

export interface SteeringQueueState {
	queued: boolean;
	source?: SteeringInterruptSource;
}

export interface ToolCallArgumentTransform {
	execution: Record<string, unknown>;
	display: Record<string, unknown>;
}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model;

	pauseGate?: AgentPauseGate;

	interruptMode?: "immediate" | "wait";

	sessionId?: string;

	deadline?: number;

	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;

	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;

	getApiKey?: (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

	getSteeringMessages?: () => Promise<AgentMessage[]>;

	hasSteeringMessages?: () => boolean | SteeringQueueState | Promise<boolean | SteeringQueueState>;

	hasIrcInterrupts?: () => boolean | Promise<boolean>;

	getFollowUpMessages?: () => Promise<AgentMessage[]>;
	getAsideMessages?: () => Promise<AsideMessage[]>;
	onBeforeYield?: () => Promise<void> | void;

	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;

	syncContextBeforeModelCall?: (context: AgentContext) => void | Promise<void>;

	transformToolCallArguments?: (args: Record<string, unknown>, toolName: string) => ToolCallArgumentTransform;

	intentTracing?: boolean;
	instrumentation?: InstrumentationLevel;
	pruneToolDescriptions?: boolean;
	dialect?: ConfiguredDialect;
	abortOnFabricatedToolResult?: boolean;
	appendOnlyContext?: AppendOnlyContextManager;

	onAssistantMessageEvent?: (message: AssistantMessage, event: AssistantMessageEvent) => void;

	onHarmonyLeak?: (event: HarmonyAuditEvent) => void | Promise<void>;

	getToolChoice?: () => ToolChoiceDirective | undefined;

	getReasoning?: () => Effort | undefined;
	getModel?: () => Model;

	getDisableReasoning?: () => boolean | undefined;

	getServiceTier?: (model: Model) => ServiceTier | undefined;

	getCwd?: () => string | undefined;

	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
	onTurnEnd?: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;

	transformAssistantMessage?: (message: AssistantMessage, signal?: AbortSignal) => Promise<void> | void;

	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
	repairToolCallArguments?: (tool: AgentTool, toolCall: AgentToolCall) => ToolCallRepairResult;
	telemetry?: AgentTelemetryConfig;
}

export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
}

export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	useless?: boolean;
}

export type ToolCallRepairStatus = "clean" | "repaired" | "unrepairable";

export interface ToolCallRepairResult {
	status: ToolCallRepairStatus;
	arguments: Record<string, unknown>;
	hints: readonly string[];
	reason?: string;
}

export interface BeforeToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: Record<string, unknown>;
	context: AgentContext;
}

export interface AfterToolCallContext {
	assistantMessage: AssistantMessage;
	toolCall: AgentToolCall;
	args: Record<string, unknown>;
	result: AgentToolResult<any>;
	isError: boolean;
	context: AgentContext;
}

export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

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
	content: (TextContent | ImageContent)[];
	details?: T;
	isError?: boolean;
	useless?: boolean;
}

export type AgentToolUpdateCallback<T = unknown, TInput = unknown> = (
	partialResult: AgentToolResult<T, TInput>,
) => void;

export interface RenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
}

export type ToolTier = "read" | "write" | "exec";

export type ToolApprovalDecision =
	| ToolTier
	| { tier: ToolTier; reason?: string; override?: boolean; critical?: boolean };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

export interface AgentToolContext {}

export type AgentToolExecFn<TParameters extends TSchema = TSchema, TDetails = unknown, TTheme = unknown> = (
	this: AgentTool<TParameters, TDetails, TTheme>,
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
	context?: AgentToolContext,
) => Promise<AgentToolResult<TDetails, TParameters>>;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown, TTheme = unknown>
	extends Tool<TParameters> {
	label: string;
	hidden?: boolean;
	deferrable?: boolean;
	loadMode?: "essential" | "discoverable";
	summary?: string;
	concurrency?: "shared" | "exclusive" | ((args: Partial<Static<TParameters>>) => "shared" | "exclusive");
	lenientArgValidation?: boolean;
	interruptible?: boolean | ((args: Partial<Static<TParameters>>) => boolean);
	intent?: "omit" | "optional" | "require" | ((args: Partial<Static<TParameters>>) => string | undefined);

	matcherDigest?: (args: unknown) => string | undefined;

	matcherPaths?: (args: unknown) => readonly string[] | undefined;

	matcherEntries?: (args: unknown) => readonly { path: string; digest: string }[] | undefined;

	approval?: ToolApproval;

	formatApprovalDetails?: (args: unknown) => string | string[] | undefined;

	execute: AgentToolExecFn<TParameters, TDetails, TTheme>;

	renderCall?: (args: Static<TParameters>, options: RenderResultOptions, theme: TTheme) => unknown;

	renderResult?: (
		result: AgentToolResult<TDetails, TParameters>,
		options: RenderResultOptions,
		theme: TTheme,
	) => unknown;
}

export type AnyAgentTool = AgentTool<any, any, any>;

export interface AgentContext {
	systemPrompt: string[];
	messages: AgentMessage[];
	tools?: AnyAgentTool[];
}

export type AgentEvent =
	| { type: "agent_start" }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			telemetry?: AgentRunSummary;
			coverage?: AgentRunCoverage;
	  }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
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
