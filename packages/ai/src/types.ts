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
import type { Api, FetchImpl, KnownApi, Model, ThinkingBudgets } from "@veyyon/catalog/types";
import type {
	CacheEnforcement,
	CacheRetention,
	Message,
	MessageAttribution,
	ToolChoice,
	ToolResultMessage,
} from "@veyyon/model/message";
import type { ToolSpec } from "@veyyon/tool";
import type { Type } from "arktype";
import type { ZodType, z } from "zod/v4";
import type { ApiKey } from "./auth-retry";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { FallbackParam } from "./providers/anthropic-wire";
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
import type { AssistantMessageEventStream } from "./utils/event-stream";

export * from "@veyyon/model/message";

export type { AssistantMessageEventStream } from "./utils/event-stream";

/**
 * Ceiling on the output-token count veyyon requests from any OpenAI-family endpoint
 * (openai-responses, azure/xai responses, and openai-completions). Mirrors
 * Anthropic's {@link CLAUDE_CODE_MAX_OUTPUT_TOKENS}.
 *
 * Catalog `maxTokens` frequently reflects a model's context window rather than a
 * given upstream's real per-request output cap. OpenRouter, for instance,
 * advertises 131072 output tokens for `z-ai/glm-4.7`, but the Cerebras upstream
 * only allows ~131072 tokens total — so requesting the full ceiling overflows
 * with a 400. Requested output is clamped to this value (and to `model.maxTokens`).
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

// Base options all providers share

/**
 * The service-tier vocabulary, and the per-provider capability that decides what
 * a tier does on the wire, live in
 * `@veyyon/catalog/provider-models/wire-capabilities` beside the provider table
 * they describe. They are re-exported here because the tier is part of the
 * request shape this module declares and every consumer reaches it through here.
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
	 * What to do when a request's cache markers demonstrably did not take effect.
	 *
	 * Defaults to `error` via `VEYYON_CACHE_ENFORCEMENT`, because the verdict that
	 * triggers it cannot occur when caching works. `warn` reports and continues;
	 * `off` disables the check. See `cache/policy.ts` for why the failure lands on
	 * the NEXT request rather than the one that was rejected.
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
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
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
	 * Conversation identity for a stateful agent API. `cursor-agent` and
	 * `devin-agent` thread turns server-side by this id and key their cached
	 * conversation state on it, falling back to {@link sessionId}.
	 *
	 * A SIDE request is not part of the conversation it reads: a compaction
	 * summary, a branch summary, a title, a critique. Reusing the live id sends
	 * the server a one-message conversation under the live conversation's
	 * identity, and overwrites the cached state the next live turn resumes from,
	 * so every side request passes an id of its own.
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
	 * Optional per-provider concurrent request cap for LLM stream calls. Keys are
	 * provider ids (`model.provider`); positive numeric values cap in-flight
	 * requests across local Veyyon processes that share the same config root. Omitted
	 * providers are unlimited. Non-chat provider APIs that bypass stream helpers
	 * are not covered.
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
	 * Optional callback for raw Server-Sent Events as they arrive from HTTP streaming providers,
	 * plus synthesized SSE-shaped frames for the Codex WebSocket transport (one synthetic frame
	 * per JSON request/response message). WebSocket frames are tagged with a leading
	 * `: ws → <type>` (outbound) or `: ws ← <type>` (inbound) comment line in `RawSseEvent.raw`.
	 *
	 * Diagnostic only: provider implementations must ignore callback failures and must not
	 * let observers alter stream contents.
	 */
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	/**
	 * Optional override for the first-event watchdog in milliseconds. Built-in
	 * providers apply this budget twice when they can: once to the underlying
	 * SDK/request while waiting for the HTTP stream object to exist, then again
	 * in the iterator while waiting for the first semantic stream event. Set to
	 * `0` to disable both layers for this request. After the first semantic
	 * event arrives, `streamIdleTimeoutMs` governs inter-event stalls. Falls
	 * back to `VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS` and then to a 100s default.
	 * OpenAI-family transports additionally honor
	 * `VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` as the most-specific override and
	 * floor the first-event budget at the resolved idle (per-call
	 * `streamIdleTimeoutMs` or `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS`) so slow local
	 * OpenAI-compatible servers are not undercut during prompt processing.
	 *
	 * Iterator-level honored by: every built-in provider (via the lazy-stream
	 * forwarder in `register-builtins`). SDK-request honored by:
	 * `openai-completions`, `openai-responses`, `azure-openai-responses`,
	 * `anthropic-messages`.
	 */
	streamFirstEventTimeoutMs?: number;
	/**
	 * Optional override for the maximum idle gap between streamed events in
	 * milliseconds. Once the first event arrives, this guards against silent
	 * mid-stream stalls (broker dies, half-open socket, model produces no real
	 * progress for too long). Set to `0` to disable. Falls back to
	 * `VEYYON_STREAM_IDLE_TIMEOUT_MS` (alias: `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS`)
	 * and then to a 120s default.
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Optional retry delay hook for tests and transports that need custom scheduling.
	 */
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	/**
	 * Optional `fetch` implementation override. Providers route every HTTP
	 * request — direct calls, SDK clients, and retry helpers — through this
	 * implementation when set. Defaults to `globalThis.fetch`. Providers that
	 * do not use `fetch` (Bedrock's AWS SDK transport, Cursor's HTTP/2
	 * channel) silently ignore the override.
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
	 * API key for the request: either a static bearer string, or an
	 * {@link ApiKeyResolver} that mints/rotates the key across the central
	 * a/b/c auth-retry policy. `streamSimple`/`completeSimple` resolve a
	 * resolver to a string before per-provider dispatch, so providers only
	 * ever see the resolved {@link StreamOptions.apiKey} string.
	 */
	apiKey?: ApiKey;
	reasoning?: Effort;
	/**
	 * Force-disable reasoning for the request even when the model supports it.
	 * Takes precedence over `reasoning`. Useful for fast utility calls
	 * (e.g. title generation) where the model would otherwise burn the entire
	 * output budget on internal thinking. Provider support is format-specific:
	 * some transports can disable reasoning directly, while generic
	 * effort-based OpenAI-compatible endpoints use the lowest supported effort.
	 */
	disableReasoning?: boolean;
	/**
	 * If true, request that the provider omit thinking/reasoning summaries
	 * from the response (e.g. Anthropic `thinking.display = "omitted"`,
	 * OpenAI Responses `reasoning.summary` left unset). The model still
	 * reasons internally; only the human-readable summary stream is dropped.
	 * Useful when the UI hides thinking blocks anyway and the summary is wasted bandwidth.
	 */
	hideThinkingSummary?: boolean;
	/** OpenAI Responses/Codex `text.verbosity` response detail level. */
	textVerbosity?: "low" | "medium" | "high";
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
	/** Cursor exec handlers for local tool execution */
	cursorExecHandlers?: CursorExecHandlers;
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
	 * OpenRouter routing-variant suffix automatically appended to model IDs when
	 * the request targets OpenRouter (`model.provider === "openrouter"`). Common
	 * values: `"nitro"` (throughput), `"floor"` (cheapest), `"online"` (web
	 * search plugin), `"exacto"` (cherry-picked high-quality providers, only
	 * defined for some models). Ignored when the resolved model id already
	 * contains a `:<variant>` suffix (e.g. the user typed `:nitro` explicitly
	 * or the catalog entry already names the variant).
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

export type { ToolCallExample, ToolCompareExample, ToolExample, ToolNoteExample, ToolSpec } from "@veyyon/tool";

export interface Tool<TParameters extends TSchema = TSchema> extends ToolSpec {
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
	/**
	 * How many trailing assistant messages keep their Gemini `thoughtSignature`
	 * verbatim. Older tool calls send Google's skip sentinel instead.
	 *
	 * Signatures are opaque and large, and every historical one is re-uploaded
	 * on every request, so on a long session they become the biggest single
	 * thing in the context. Leave this undefined to send them all, which is the
	 * behaviour every non-Google provider and every caller that has not opted in
	 * already has.
	 */
	thoughtSignatureRetention?: number;
	/**
	 * Longest Gemini `thoughtSignature` still worth re-uploading, in characters.
	 * Anything longer sends Google's skip sentinel instead, at any age.
	 *
	 * This is a size rule, not a second recency rule, and it exists because
	 * signature bytes are extremely concentrated: across twenty measured sessions
	 * the largest tenth of signatures held 62.1% of all signature bytes, with a
	 * median of 660 characters against a maximum of 91,960. A cap therefore removes
	 * most of the mass while leaving the great majority of the reasoning chain
	 * intact, which is the gentler trade if replaying old reasoning turns out to
	 * matter. Composes with {@link thoughtSignatureRetention}: a signature is sent
	 * only when it is both recent enough and small enough. Leave undefined, or set
	 * a non-positive value, for no limit.
	 */
	thoughtSignatureMaxLength?: number;
	/**
	 * How many trailing assistant messages keep an UNSIGNED thinking block.
	 * Older unsigned blocks are dropped from the request entirely.
	 *
	 * Gemini attaches its thought signature to the function call, not to the
	 * thought summary, so an unsigned summary carries nothing the provider can
	 * replay: it is transcript text, re-uploaded on every turn. A SIGNED block is
	 * never dropped, whatever this says. Leave undefined to send them all, which
	 * is the behaviour before this existed.
	 */
	thinkingRetention?: number;
}
