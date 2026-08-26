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

/**
 * Ceiling on output-token count veyyon requests from OpenAI-family endpoints,
 * preventing context overflow from catalog values. Clamped alongside `model.maxTokens`.
 */
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
// Compile-time exhaustiveness check - this will fail if ApiOptionsMap doesn't have all KnownApi keys
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

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

/**
 * What to do when a request's prompt-cache markers demonstrably did not take
 * effect. Declared here beside {@link CacheRetention} rather than in
 * `cache/policy.ts`, which needs `CacheRetention` from this module and would
 * otherwise form an import cycle with it.
 */
export type CacheEnforcement = "off" | "warn" | "error";

/**
 * Service-tier vocabulary re-exported from `@veyyon/catalog/provider-models/wire-capabilities`.
 */
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

/** Lifecycle fields shared by every Codex compaction implementation. */
export interface CodexCompactionContext {
	/** Stable only for one logical compaction, including parallel summary calls. */
	operationId: string;
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

/** Canonical nested metadata serialized into the Codex turn envelope. */
export interface CodexCompactionMetadata {
	trigger: "manual" | "auto";
	reason: "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
	phase: "standalone_turn" | "pre_turn" | "mid_turn";
	strategy: "memento" | "prefix_compaction";
}

/** Dispatch context combining canonical metadata with its local operation identity. */
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
	/**
	 * Stop sequences. Anthropic encodes as `stop_sequences` (array, max 4);
	 * OpenAI chat-completions encodes as `stop` (string or array of up to 4);
	 * OpenAI Responses API has no `stop` field today (silently dropped by the
	 * provider when present).
	 */
	stopSequences?: string[];
	/**
	 * Frequency penalty (OpenAI). Penalizes new tokens based on existing frequency
	 * in the text so far. Range -2.0 to 2.0. Parallel to {@link presencePenalty}.
	 */
	frequencyPenalty?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	cacheRetention?: CacheRetention;
	/**
	 * Cache enforcement policy (`error`, `warn`, or `off`) when cache markers do not take effect.
	 */
	cacheEnforcement?: CacheEnforcement;
	/**
	 * Additional headers to include in provider requests.
	 * These are merged on top of model-defined headers.
	 */
	headers?: Record<string, string>;
	/**
	 * Optional explicit request attribution override for providers that support it.
	 */
	initiatorOverride?: MessageAttribution;
	/**
	 * Max delay in ms to wait for server-requested retries (default 60000; 0 to disable cap).
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Config options for the thinking/response loop guard.
	 */
	loopGuard?: {
		enabled?: boolean;
		checkAssistantContent?: boolean;
	};
	/**
	 * Advisory token budget for a full agentic loop. Anthropic encodes this as
	 * `output_config.task_budget` with the `task-budgets-2026-03-13` beta header.
	 */
	taskBudget?: TokenTaskBudget;
	/**
	 * Optional session identifier for providers that support session-based
	 * routing, request affinity, or transport reuse. Providers may also use this
	 * as the prompt-cache key when `promptCacheKey` is not set.
	 */
	sessionId?: string;
	/**
	 * Conversation identity for stateful agent APIs (`cursor-agent`, `devin-agent`),
	 * distinct from main session for isolated side requests.
	 */
	conversationId?: string;
	/**
	 * Optional prompt-cache identity. OpenAI-family providers use this for
	 * `prompt_cache_key` payloads and cache-affinity headers such as
	 * `x-grok-conv-id`; when omitted, they fall back to `sessionId`.
	 */
	promptCacheKey?: string;
	/**
	 * Provider-scoped mutable state store for this agent session.
	 * Providers can use this to persist transport/session state between turns.
	 */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Canonical Codex compaction classification; ignored by other providers. */
	codexCompaction?: CodexCompactionRequestContext;
	/**
	 * Optional per-provider concurrent request cap for LLM stream calls across local processes.
	 */
	maxInFlightRequests?: Record<string, number>;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model?: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback for provider response metadata after headers are received.
	 */
	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>) => void | Promise<void>;
	/**
	 * Diagnostic callback for raw SSE events from HTTP streams or synthesized frames from WebSocket.
	 */
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	/**
	 * Optional timeout in ms for the first stream event (default 100s, 0 to disable).
	 * Honored at both SDK-request and iterator levels by supported providers.
	 */
	streamFirstEventTimeoutMs?: number;
	/**
	 * Optional timeout in ms for maximum idle gap between streamed events (default 120s, 0 to disable).
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Optional retry delay hook for tests and transports that need custom scheduling.
	 */
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Custom `fetch` implementation override for HTTP requests across providers.
	 */
	fetch?: FetchImpl;
	/** Current session working directory for providers that need workspace-scoped discovery. */
	cwd?: string;

	/** Cursor exec/MCP tool handlers (cursor-agent only). */
	execHandlers?: CursorExecHandlers;
}

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
	/**
	 * Static API key string or `ApiKeyResolver` for auth token rotation.
	 */
	apiKey?: ApiKey;
	reasoning?: Effort;
	/**
	 * Force-disable reasoning for fast utility calls even when model supports thinking.
	 */
	disableReasoning?: boolean;
	/**
	 * Request provider to omit human-readable reasoning summaries while preserving internal thinking.
	 */
	hideThinkingSummary?: boolean;
	/** OpenAI Responses/Codex `text.verbosity` response detail level. */
	textVerbosity?: "low" | "medium" | "high";
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
	/** Cursor exec handlers for local tool execution */
	cursorExecHandlers?: CursorExecHandlers;
	/**
	 * Operator-owned global and profile instruction units for Cursor's `requestContext.rules` channel.
	 */
	cursorRules?: CursorRuleInput[];
	/** Hook to handle tool results from Cursor exec */
	cursorOnToolResult?: CursorToolResultHandler;
	/** Optional tool choice override for compatible providers */
	toolChoice?: ToolChoice;
	/** OpenAI service tier for processing priority/cost control. Ignored by non-OpenAI providers. */
	serviceTier?: ServiceTier;
	/** API format for Kimi Code provider: "openai" or "anthropic" (default: "anthropic") */
	kimiApiFormat?: "openai" | "anthropic";
	/** API format for Synthetic provider: "openai" or "anthropic" (default: "openai") */
	syntheticApiFormat?: "openai" | "anthropic";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/**
	 * OpenRouter routing variant suffix (e.g. "nitro", "floor") appended to model IDs.
	 */
	openrouterVariant?: string;
	/** Antigravity endpoint routing mode: "auto" (default with failover), "production", "sandbox". */
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	/**
	 * Anthropic `server-side-fallback-2026-06-01` fallback chain (top-level
	 * `fallbacks` request field). Opt-in ONLY — leaving this undefined is
	 * the default and preserves the pre-fallback behavior on every
	 * provider. Non-Anthropic providers ignore the field.
	 */
	fallbacks?: FallbackParam[];
}

// Generic StreamFunction with typed options
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

/**
 * Anthropic server-side fallback boundary marker persisted on opted-in assistant turns.
 */
export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	/**
	 * OpenAI-only resolution hint. `"original"` preserves native resolution
	 * (useful for dense text-in-image content whose glyphs do not survive
	 * the default `auto` downscale). Providers without a detail knob ignore it.
	 */
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
	/**
	 * Verbatim in-band syntax block that produced this synthetic `ptc_*` call.
	 * Present only for owned prompt/tool-call formats; provider-native calls omit it.
	 */
	rawBlock?: string;
	/**
	 * Wire-level tool name when invoked via custom-tool mechanisms (e.g. `apply_patch`).
	 */
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
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** True when injected mid-turn as a steer; consumed by the agent's pre-LLM transform to wrap it for emphasis. Never rendered. */
	steering?: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
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
	/** Estimated stored conversation messages included in the request. Rich session telemetry only. */
	storedMessagesTokens?: number;
	/** Estimated not-yet-stored request tail included alongside the stored conversation. Rich telemetry only. */
	tailTokens?: number;
	/** Whether the prompt total came from provider usage or a local preflight estimate. */
	promptTokensSource?: "provider" | "estimate";
	nonMessageTokensEstimated?: boolean;
	storedMessagesTokensEstimated?: boolean;
	tailTokensEstimated?: boolean;
	/** Latest compaction entry governing this request, when recorded at ultra detail. */
	compactionEntryId?: string;
	lastMessageTimestamp?: number;
}

/**
 * Identity of a tool call whose arguments never finished streaming.
 *
 * Both fields arrive with the provider's tool-call block header, before any
 * argument delta, so they are complete even when the arguments are not.
 */
export interface IncompleteToolCall {
	id: string;
	name: string;
}

/**
 * One bucket of a provider-reported context composition. See
 * {@link AssistantMessage.providerContextComposition}.
 */
export interface ProviderContextBucket {
	/** Stable provider identifier to branch on (`"tools"`, `"rules"`, `"skills"`, ...). */
	key: string;
	/** The provider's own display string for the bucket. */
	label: string;
	tokens: number;
	/** Characters the provider measured, or 0 when it reports tokens only. */
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
	/**
	 * Upstream provider name reported by aggregator gateways (e.g. OpenRouter's `provider`).
	 */
	upstreamProvider?: string;
	/**
	 * Context window size explicitly reported by the provider on the wire.
	 */
	providerContextWindow?: number;
	/**
	 * Breakdown of context token usage as measured and reported by the provider gateway.
	 */
	providerContextComposition?: ProviderContextBucket[];
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** Per-tool abort messages used when an aborted assistant turn needs different placeholder results per tool call. */
	toolCallAbortMessages?: Record<string, string>;
	/**
	 * Tool calls cut off during streaming on aborted or errored turns, preserved for context.
	 */
	incompleteToolCalls?: IncompleteToolCall[];
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Identifiers for request features silently dropped by provider during fallback retries.
	 */
	disabledFeatures?: string[];
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	/**
	 * Turn metrics (wall-clock, ttft, throughput) captured when instrumentation is enabled.
	 */
	turnMetrics?: AssistantTurnMetrics;
	/**
	 * Sampling and tool parameters as sent on the wire when instrumentation is enabled.
	 */
	request?: AssistantTurnRequest;
}

/**
 * Standard fallback message when an errored tool produces no output text.
 */
export const EMPTY_ERROR_TOOL_RESULT_TEXT = "Tool failed with no output.";

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	/**
	 * Tool-declared: this result carried no information worth retaining once
	 * consumed (zero matches, elapsed wait). Compaction passes may elide it.
	 * Never set together with isError.
	 */
	useless?: boolean;
	/**
	 * Dense study record for this call (timing, output weight, args fingerprint),
	 * present when session instrumentation is on. Its detail scales with the
	 * configured {@link InstrumentationLevel}; absent at `off` and on messages
	 * recorded before instrumentation existed. See {@link captureToolCallMetrics}.
	 */
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

/**
 * Instruction unit for Cursor's `requestContext.rules` channel (operator context files only).
 */
export interface CursorRuleInput {
	/**
	 * Absolute path of the file the content came from. cursor-agent sends AGENTS.md
	 * the same way (one rule per file, real path). Compiled (non-file) content uses a
	 * stable synthetic path owned by the caller.
	 */
	fullPath: string;
	/** The instruction body, in full. cursor-agent applies no client-side size cap. */
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

/**
 * Plain JSON Schema document used by extension-authored tools (legacy TypeBox
 * emits this shape). Distinguished from arktype at runtime.
 */
export type TJsonSchema = Record<string, unknown>;

/**
 * Schema type accepted by the {@link Tool} interface.
 *
 * Canonical authoring uses Zod or ArkType. Extension compat may supply a JSON
 * Schema object (including TypeBox static schema objects).
 */
export type TSchema = ZodType | Type | TJsonSchema;

/** Resolve parameter types for tool execution / handlers. */
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
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/**
	 * Optional grammar constraint format for OpenAI custom-tool emission.
	 */
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	/**
	 * Wire name for custom tool emission when different from harness-internal tool name.
	 */
	customWireName?: string;
	/**
	 * Illustrative tool call examples rendered into description `<examples>` blocks.
	 */
	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
	/**
	 * Retention count of trailing assistant messages that retain Gemini `thoughtSignature`.
	 */
	thoughtSignatureRetention?: number;
	/**
	 * Max character length of Gemini `thoughtSignature` to re-upload before using skip sentinel.
	 */
	thoughtSignatureMaxLength?: number;
	/**
	 * Retention count of trailing assistant messages that retain unsigned Gemini thinking blocks.
	 */
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
