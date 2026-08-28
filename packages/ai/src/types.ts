export * from "@veyyon/catalog/effort";
export * from "@veyyon/catalog/types";

import type {
	DeleteArgs,
	DeleteResult,
	DiagnosticsArgs,
	DiagnosticsResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import type { Effort } from "@veyyon/catalog/effort";
import type { ServiceTier } from "@veyyon/catalog/provider-models/wire-capabilities";
import type { Api, FetchImpl, KnownApi, Model, Provider, ThinkingBudgets, Usage } from "@veyyon/catalog/types";
import type { Type } from "arktype";
import type { ZodType, z } from "zod/v4";
import type { ApiKey } from "./auth-retry";
import type { AssistantTurnMetrics, AssistantTurnRequest, ToolCallMetrics } from "./instrumentation";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { FallbackParam, StopDetails } from "./providers/anthropic-wire";
import type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import type { GitLabDuoWorkflowOptions } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import type { kStreamingPartialJson } from "./utils/block-symbols";
import type { AssistantMessageEventStream } from "./utils/event-stream";

export type { StopDetails } from "./providers/anthropic-wire";
export type { AssistantMessageEventStream } from "./utils/event-stream";

export const OPENAI_MAX_OUTPUT_TOKENS = 64000;

export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"bedrock-converse-stream": BedrockOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	openrouter: OpenAIResponsesOptions | OpenAICompletionsOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-gemini-cli": GoogleGeminiCliOptions;
	"google-vertex": GoogleVertexOptions;
	"ollama-chat": OllamaChatOptions;
	"cursor-agent": CursorOptions;
	"gitlab-duo-agent": GitLabDuoWorkflowOptions;
	"devin-agent": DevinOptions;
}
type _CheckExhaustive =
	ApiOptionsMap extends Record<KnownApi, StreamOptions>
		? Record<KnownApi, StreamOptions> extends ApiOptionsMap
			? true
			: ["ApiOptionsMap is missing some KnownApi values", Exclude<KnownApi, keyof ApiOptionsMap>]
		: ["ApiOptionsMap doesn't extend Record<KnownApi, StreamOptions>"];
true satisfies _CheckExhaustive;
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);

export interface TokenTaskBudget {
	type: "tokens";
	total: number;
	remaining?: number;
}

export type MessageAttribution = "user" | "agent";

export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string };

export type CacheRetention = "none" | "short" | "long";

export type CacheEnforcement = "off" | "warn" | "error";

export {
	getPriorityPremiumRequests,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "@veyyon/catalog/provider-models/service-tier";
export type {
	ProviderServiceTierCapability,
	ProviderWireCapabilities,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
} from "@veyyon/catalog/provider-models/wire-capabilities";
export {
	coerceServiceTierByFamily,
	isServiceTier,
	SERVICE_TIERS,
} from "@veyyon/catalog/provider-models/wire-capabilities";

export interface ProviderSessionState {
	close(): void;
}

export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
	metadata?: Record<string, unknown>;
}

export interface RawSseEvent {
	event: string | null;
	data: string;
	raw: string[];
}

export interface CodexCompactionContext {
	operationId: string;
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

export interface CodexCompactionMetadata {
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

export interface CodexCompactionRequestContext extends CodexCompactionMetadata {
	operationId: string;
}

export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	stopSequences?: string[];
	frequencyPenalty?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	cacheRetention?: CacheRetention;
	cacheEnforcement?: CacheEnforcement;
	headers?: Record<string, string>;
	initiatorOverride?: MessageAttribution;
	maxRetryDelayMs?: number;
	metadata?: Record<string, unknown>;
	loopGuard?: {
		enabled?: boolean;
		checkAssistantContent?: boolean;
	};
	taskBudget?: TokenTaskBudget;
	sessionId?: string;
	conversationId?: string;
	promptCacheKey?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	codexCompaction?: CodexCompactionRequestContext;
	maxInFlightRequests?: Record<string, number>;
	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>) => void | Promise<void>;
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	streamFirstEventTimeoutMs?: number;
	streamIdleTimeoutMs?: number;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	fetch?: FetchImpl;
	cwd?: string;

	execHandlers?: CursorExecHandlers;
}

export interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
	apiKey?: ApiKey;
	reasoning?: Effort;
	disableReasoning?: boolean;
	hideThinkingSummary?: boolean;
	textVerbosity?: "low" | "medium" | "high";
	thinkingBudgets?: ThinkingBudgets;
	cursorExecHandlers?: CursorExecHandlers;
	cursorRules?: CursorRuleInput[];
	cursorOnToolResult?: CursorToolResultHandler;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
	kimiApiFormat?: "openai" | "anthropic";
	syntheticApiFormat?: "openai" | "anthropic";
	preferWebsockets?: boolean;
	openrouterVariant?: string;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	fallbacks?: FallbackParam[];
}

export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	detail?: "auto" | "low" | "high" | "original";
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Readonly<Record<string, unknown>>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	rawBlock?: string;
	customWireName?: string;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

export type ProviderPayload = OpenAIResponsesHistoryPayload;

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	synthetic?: boolean;
	steering?: boolean;
	attribution?: MessageAttribution;
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	attribution?: MessageAttribution;
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

export interface AssistantRetryRecovery {
	kind: "auto-retry";
	status: "recovered";
	attempt: number;
	recoveredAt: string;
	recovery: AssistantRetryRecoveryKind;
	note: string;
	supersededBy?: {
		timestamp: number;
		responseId?: string;
		provider: string;
		model: string;
	};
}

export interface ContextSnapshot {
	promptTokens: number; // authoritative provider prompt/input tokens
	nonMessageTokens: number; // estimated non-message total at send time
	storedMessagesTokens?: number;
	tailTokens?: number;
	promptTokensSource?: "provider" | "estimate";
	nonMessageTokensEstimated?: boolean;
	storedMessagesTokensEstimated?: boolean;
	tailTokensEstimated?: boolean;
	compactionEntryId?: string;
	lastMessageTimestamp?: number;
}

export interface IncompleteToolCall {
	id: string;
	name: string;
}

export interface ProviderContextBucket {
	key: string;
	label: string;
	tokens: number;
	chars: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | RedactedThinkingContent | AnthropicFallbackContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	contextSnapshot?: ContextSnapshot;
	retryRecovery?: AssistantRetryRecovery;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	upstreamProvider?: string;
	providerContextWindow?: number;
	providerContextComposition?: ProviderContextBucket[];
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	toolCallAbortMessages?: Record<string, string>;
	incompleteToolCalls?: IncompleteToolCall[];
	errorStatus?: number;
	errorId?: number;
	disabledFeatures?: string[];
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	turnMetrics?: AssistantTurnMetrics;
	request?: AssistantTurnRequest;
}

export const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	attribution?: MessageAttribution;
	prunedAt?: number;
	useless?: boolean;
	metrics?: ToolCallMetrics;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;
}

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

export interface CursorRuleInput {
	fullPath: string;
	content: string;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	diagnostics?: (args: DiagnosticsArgs) => Promise<CursorExecHandlerResult<DiagnosticsResult>>;
	mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
	onToolResult?: CursorToolResultHandler;
}

export type TJsonSchema = Record<string, unknown>;

export type TSchema = ZodType | Type | TJsonSchema;

export type Static<S> = S extends ZodType
	? z.infer<S>
	: S extends Type
		? S["infer"]
		: S extends { static: infer T }
			? T
			: unknown;

export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	bad: TArgs;
	good: TArgs;
}
export interface ToolNoteExample {
	caption: string;
	note?: string;
}
export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	strict?: boolean;
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	customWireName?: string;
	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
	thoughtSignatureRetention?: number;
	thoughtSignatureMaxLength?: number;
	thinkingRetention?: number;
}

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
