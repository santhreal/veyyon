import type { AssistantTurnMetrics, AssistantTurnRequest, ToolCallMetrics } from "./instrumentation";
import type { Api, Provider, Usage } from "./model";
import type { kStreamingPartialJson } from "./stream-block";

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

/**
 * What to do when a request's prompt-cache markers demonstrably did not take
 * effect. Declared here beside {@link CacheRetention} rather than in
 * `cache/policy.ts`, which needs `CacheRetention` from this module and would
 * otherwise form an import cycle with it.
 */
export type CacheEnforcement = "off" | "warn" | "error";

export type StopDetails = {
	type: string;
	category?: string | null;
	explanation?: string | null;
};

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
 * Anthropic server-side-fallback boundary marker persisted on assistant
 * turns whose provider request opted into
 * `AnthropicOptions.fallbacks`. Consumers other than the Anthropic
 * provider MUST ignore it — `transformMessages` strips the block on any
 * cross-provider hop and on non-official Anthropic replays, so downstream
 * converters never see it.
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
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
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
	/**
	 * When this message REPLACED earlier history (a compaction or branch
	 * summary), in ms since epoch. Preserved-thinking models bind each thinking
	 * block's signature to the exact bytes of everything before it, so an
	 * assistant turn recorded at or before a rewrite carries reasoning minted
	 * against a prefix that no longer exists: `transformMessages` drops those
	 * blocks rather than let the API reject the request or drop them silently.
	 */
	historyRewriteAt?: number;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	/** See {@link UserMessage.historyRewriteAt}. */
	historyRewriteAt?: number;
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
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	/**
	 * Context window the PROVIDER reported for this conversation on the wire.
	 *
	 * Most APIs never say: the window is static model metadata and the catalog
	 * carries it. A few agent gateways report it per turn alongside the tokens
	 * used, and for those the catalog entry is a guess — a model the gateway
	 * added after the catalog was generated falls back to a default window that
	 * has nothing to do with the real one. Divide the gateway's own used-token
	 * count by that default and the context gauge pins at empty on a
	 * conversation the gateway considers barely started, which is what Cursor's
	 * `ConversationTokenDetails` did (`max_tokens` was on the wire every turn
	 * and thrown away while `used_tokens` was believed).
	 *
	 * Set it only from a value the provider actually sent. Undefined means the
	 * provider said nothing, NOT that the catalog window is wrong.
	 */
	providerContextWindow?: number;
	/**
	 * How the PROVIDER says its own reported context is composed, when it says.
	 *
	 * Only a gateway that assembles the prompt for us can measure this: it knows
	 * what the tool schemas, the rules and the skills actually cost after its own
	 * serialization, where we can only estimate them from what we sent. Cursor
	 * reports it per turn and the buckets sum to its `used_tokens` exactly, which
	 * is what makes it worth carrying: one real sample puts tool definitions at
	 * 8,326 of 14,483 tokens, and no local estimate would have found that.
	 *
	 * Undefined means the provider said nothing. An empty bucket the provider did
	 * measure is present with `tokens: 0`, so an absent key is "not measured"
	 * rather than "nothing there".
	 */
	providerContextComposition?: ProviderContextBucket[];
	usage: Usage;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** Per-tool abort messages used when an aborted assistant turn needs different placeholder results per tool call. */
	toolCallAbortMessages?: Record<string, string>;
	/**
	 * Tool calls the model began emitting whose arguments were still streaming
	 * when the turn was cut off (a provider stream reset or an abort). Their
	 * `toolCall` blocks are removed from {@link content}, because incomplete
	 * arguments are unsafe to run and an unpaired `tool_use` block breaks the
	 * provider's tool_use/tool_result pairing on replay. The identity survives
	 * here so the harness can still tell the model the call was attempted and
	 * never ran: without it the call vanishes with no trace anywhere, and the
	 * model reads the turn as if it had never asked for that tool.
	 *
	 * Populated only on `error`/`aborted` turns that dropped at least one block.
	 */
	incompleteToolCalls?: IncompleteToolCall[];
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	/**
	 * Dense per-turn study record (request-start wall-clock, ttft, throughput),
	 * present when session instrumentation is on. The graded, single-owner form of
	 * the loose `duration`/`ttft` scalars above; its detail scales with the
	 * configured {@link InstrumentationLevel} (absent at `off` and on turns
	 * recorded before it existed). See {@link captureAssistantTurnMetrics}.
	 */
	turnMetrics?: AssistantTurnMetrics;
	/**
	 * Exact sampling/reasoning/tool-choice parameters AS SENT for this turn,
	 * present when session instrumentation is on. The replay-fidelity companion to
	 * {@link turnMetrics}: it records what the turn was asked for, so a backtest can
	 * reproduce the request. Absent at `off`, on all-default turns, and on turns
	 * recorded before it existed. See {@link captureAssistantTurnRequest}.
	 */
	request?: AssistantTurnRequest;
}

/**
 * What an errored tool result says when the tool produced no output of its own.
 *
 * A user reads this line. It was declared twice, in `@veyyon/agent`'s loop (which
 * fills it in at the boundary where an untyped tool result enters) and in
 * `@veyyon/ai`'s Anthropic provider (which fills it in on the way to the wire,
 * because the API rejects an empty content array). The two are the same sentence
 * about the same event, so an edit to one produced a transcript where the same
 * failure was worded two ways depending on which layer noticed it first. It lives
 * here because this module owns {@link ToolResultMessage}, the shape being filled.
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
