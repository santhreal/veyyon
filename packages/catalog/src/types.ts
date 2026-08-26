import type { Effort } from "./effort";

// Re-exported from @veyyon/utils so the whole workspace shares one
// `fetch`-compatible signature (tls-fetch's wrappers produce/accept it).
export type { FetchImpl } from "@veyyon/utils";
export type { KnownProvider } from "./provider-models/descriptors";

export type KnownApi =
	| "openai-completions"
	| "openai-responses"
	| "openrouter"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "ollama-chat"
	| "cursor-agent"
	| "gitlab-duo-agent"
	| "devin-agent";
export type Api = KnownApi | (string & {});

/**
 * Canonical thinking transports defining how effort is encoded on the wire.
 * Enumerated as a runtime value to validate all transport implementations.
 */
export const THINKING_CONTROL_MODES = [
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
] as const;

/** Canonical thinking transport used by a model. */
export type ThinkingControlMode = (typeof THINKING_CONTROL_MODES)[number];

/** Per-model thinking capabilities used to clamp and map user-facing effort levels. */
export interface ThinkingConfig {
	/** Provider-specific transport used to encode the selected effort. */
	mode: ThinkingControlMode;
	/**
	 * Supported user-facing efforts, ordered least → most intensive. Never
	 * empty: a reasoning model without a controllable effort surface carries
	 * `thinking: undefined` instead of an empty list.
	 */
	efforts: readonly Effort[];
	/** Optional default effort applied when this model is selected. Falls back to global default if absent. */
	defaultLevel?: Effort;
	/**
	 * Effort → provider wire-value remap, baked at build time. Identity for
	 * efforts the map omits. Used by Anthropic adaptive thinking, OpenAI-
	 * compatible `reasoning_effort`, and Responses-style reasoning params.
	 */
	effortMap?: Partial<Record<Effort, string>>;
	/**
	 * Adaptive thinking accepts the `display` field (Opus 4.7+, Fable/Mythos
	 * 5). Also implies native interleaved thinking — no beta header needed.
	 */
	supportsDisplay?: boolean;
	/**
	 * Per-effort upstream wire-id routing for collapsed effort-tier variants
	 * (`variant-collapse.ts`). Keyed by pi effort; `"off"` applies when
	 * thinking is disabled. Missing keys fall back to `requestModelId ?? id`.
	 */
	effortRouting?: Readonly<Partial<Record<Effort | "off", string>>>;
	/**
	 * Per-effort thinking token budget for collapsed variants requiring explicit
	 * budgets. Only meaningful for `mode: "budget"`.
	 */
	effortBudgets?: Readonly<Partial<Record<Effort, number>>>;
	/**
	 * When true, thinking-off requests must explicitly suppress thinking on the wire
	 * instead of omitting thinkingConfig to prevent upstream server defaults.
	 */
	suppressWhenOff?: boolean;
	/**
	 * Reasoning is mandatory upstream: request mapping clamps thinking-off to the
	 * lowest supported effort unless `suppressWhenOff` provides an explicit wire path.
	 */
	requiresEffort?: boolean;
}

/**
 * Discovery-declared reasoning surface mapped from models.dev `reasoning_options`.
 * When present, authoritative over the identity-derived effort ladder.
 */
export interface ModelReasoningOptions {
	/**
	 * Effort levels the endpoint accepts (discovery `effort` values with the
	 * off sentinel `none`/`null` removed). Present and non-empty means the
	 * control offers exactly these levels.
	 */
	efforts?: readonly Effort[];
	/**
	 * Discovery explicitly reports no selectable efforts: an empty options
	 * list (always-thinks SKUs like `kimi-k2-thinking`) or a binary on/off
	 * toggle with no levels. The row keeps `reasoning: true` but exposes no
	 * effort control at all.
	 */
	noEffortControl?: boolean;
}

// `Provider` is any provider-id string; `KnownProvider` (re-exported above) enumerates
// the built-in model providers from the catalog descriptor table.
export type Provider = string;

/** Token budgets for each thinking level (token-based providers only) */
export type ThinkingBudgets = { [key in Effort]?: number };

export interface Usage {
	/** Non-cached conversation input tokens (matches the bucket the provider bills as new input). */
	input: number;
	/** Total conversation output tokens for the turn, including thinking, assistant text, and tool-call argument tokens. */
	output: number;
	/** Conversation tokens read from the prompt cache. */
	cacheRead: number;
	/** Conversation tokens written to the prompt cache (cache creation). */
	cacheWrite: number;
	/** Sum of input + output + cacheRead + cacheWrite plus provider-side orchestration tokens when reported. */
	totalTokens: number;
	/** Provider-side orchestration tokens, billed but not part of the conversation prompt/cache buckets. */
	orchestration?: {
		/** Non-cached orchestration input tokens. */
		input?: number;
		/** Orchestration tokens read from provider-side cache. */
		cacheRead?: number;
		/** Orchestration output tokens. */
		output?: number;
	};
	/** Copilot premium-request counter, when applicable. */
	premiumRequests?: number;
	/**
	 * Reasoning/thinking tokens included in `output`, when reported by the provider.
	 * Always a subset of `output`; undefined means unknown, not zero.
	 */
	reasoningTokens?: number;
	/**
	 * Cache-write TTL breakdown (Anthropic only). When set, the components sum to
	 * `cacheWrite`. Absent providers do not populate this.
	 */
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	/**
	 * Server-side tool invocations made during this turn (Anthropic web_search /
	 * web_fetch, OpenAI built-in tools when reported). Counts requests, not tokens.
	 */
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	/**
	 * Tokens billed for discarded attempts (retries, aborted streams).
	 * Tracks spend on non-delivered attempts; included in `cost.total`.
	 */
	discarded?: {
		/** How many billed attempts were thrown away. */
		attempts: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		/** USD already spent on those attempts, priced by the model that served each one. */
		cost: number;
	};
	/**
	 * What this turn cost. The four buckets price the delivered tokens; `total` is
	 * every dollar the turn spent, so it also carries {@link Usage.discarded}'s
	 * cost and can exceed the sum of the buckets. Anything reporting spend reads
	 * `total`; anything explaining the gap reads `discarded`.
	 */
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type OpenAIReasoningFormat = "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";

/**
 * How each OpenAI-compatible dialect encodes "stop reasoning", as a value so
 * the set can be enumerated at run time. Every mode has to survive a model with
 * no declared effort ladder, and only one of them was ever exercised that way.
 */
export const OPENAI_REASONING_DISABLE_MODES = [
	"omit",
	"lowest-effort",
	"openrouter-enabled-false",
	"zai-thinking-disabled",
	"qwen-enable-thinking-false",
	"qwen-template-false",
] as const;

export type OpenAIReasoningDisableMode = (typeof OPENAI_REASONING_DISABLE_MODES)[number];

export type OpenAIStreamMarkupHealingPattern = "kimi" | "dsml" | "thinking";

/**
 * Compatibility settings for openai-completions API.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/**
	 * Whether the endpoint accepts multiple leading `system`/`developer` messages.
	 * When false, ordered system prompts coalesce into one message for strict templates.
	 */
	supportsMultipleSystemMessages?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Optional mapping from pi-ai reasoning levels to provider/model-specific `reasoning_effort` values. */
	reasoningEffortMap?: Partial<Record<Effort, string>>;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/**
	 * Enable the Gemini thinking-loop guard (pi-ai stream layer) for this model.
	 * Defaults to true when the model id classifies as the gemini family. Set
	 * explicitly to cover an opaque OpenAI-compat proxy alias (e.g. `my-model`)
	 * that routes to Gemini, or to false to opt a gemini-family id out.
	 */
	enableGeminiThinkingLoopGuard?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether tool call IDs must be normalized to Mistral format (exactly 9 alphanumeric chars). Default: auto-detected from URL. */
	requiresMistralToolIds?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "zai" uses thinking: { type: "enabled" | "disabled" } (also used by Moonshot Kimi), "qwen" uses top-level enable_thinking, and "qwen-chat-template" uses chat_template_kwargs.enable_thinking. Default: "openai". */
	thinkingFormat?: OpenAIReasoningFormat;
	/** Request-time disable encoding for the selected reasoning/thinking format. Default: derived from `thinkingFormat`. */
	reasoningDisableMode?: OpenAIReasoningDisableMode;
	/** Whether the provider rejects `reasoning.effort`/`reasoning_effort` even when the model reasons natively. Default: false unless reasoning effort is unsupported. */
	omitReasoningEffort?: boolean;
	/** Whether Responses requests should ask for encrypted reasoning replay items. Default: true. */
	includeEncryptedReasoning?: boolean;
	/** Whether replayed Responses history should strip native `type: "reasoning"` items before request encoding. Default: false. */
	filterReasoningHistory?: boolean;
	/** Optional `thinking.keep` value for Z.ai/Moonshot-style thinking params. Set false to suppress auto-detected keep. Default: auto-detected. */
	thinkingKeep?: "all" | false;
	/** Which reasoning content field to emit on assistant messages. Default: auto-detected. */
	reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
	/** Whether assistant tool-call messages must include reasoning content. Default: false. */
	requiresReasoningContentForToolCalls?: boolean;
	/** Whether all assistant messages must include reasoning content. Default: false. */
	requiresReasoningContentForAllAssistantTurns?: boolean;
	/** Whether the provider accepts a synthetic placeholder (e.g. ".") for missing reasoning_content on tool-call turns. Default: true. Set to false for providers like DeepSeek that validate the exact reasoning_content value. */
	allowsSyntheticReasoningContentForToolCalls?: boolean;
	/**
	 * Replay thinking blocks as `reasoning_content` on every reasoning turn.
	 * Prevents KV cache divergence in local templates (llama.cpp/vLLM/Ollama #3528).
	 */
	replayReasoningContent?: boolean;
	/**
	 * Send `preserve_thinking: true` so Qwen3.6+ chat templates render thinking markup
	 * across all turns, avoiding KV cache invalidation (#3541).
	 */
	qwenPreserveThinking?: boolean;
	/** Whether assistant tool-call messages must include non-empty content. Default: false. */
	requiresAssistantContentForToolCalls?: boolean;
	/** Whether the provider supports the `tool_choice` parameter. Default: true. */
	supportsToolChoice?: boolean;
	/**
	 * Whether forced `tool_choice` values (`"required"` or named tools) are accepted.
	 * When false, request builders keep tools available but downgrade forced choices
	 * to provider-default auto selection. Default: true.
	 */
	supportsForcedToolChoice?: boolean;
	/**
	 * Whether the endpoint accepts object-form named `tool_choice`.
	 * When false, named forces downgrade to `"required"`. Default: true.
	 */
	supportsNamedToolChoice?: boolean;
	/**
	 * Drop reasoning fields when `tool_choice` forces a tool call.
	 * Required for backends (like Kimi) where forced tools conflict with thinking.
	 */
	disableReasoningOnForcedToolChoice?: boolean;
	/**
	 * Drop reasoning fields (`reasoning_effort`, OpenRouter `reasoning`) for
	 * any request that sends `tool_choice`. Use for providers/models that accept
	 * tools and `tool_choice`, but reject `tool_choice` while thinking is enabled.
	 * Default: auto-detected (DeepSeek reasoning models).
	 */
	disableReasoningOnToolChoice?: boolean;
	/** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Extra fields to include in request body (e.g. gateway routing hints for OpenClaw-style proxies). */
	extraBody?: Record<string, unknown>;
	/** Request-session header that should mirror the normalized prompt-cache key. Default: unset. */
	promptCacheSessionHeader?: "x-grok-conv-id";
	/** Whether chat-completions payloads should include provider-specific prompt-cache markers. */
	cacheControlFormat?: "anthropic" | undefined;
	/** Whether the provider supports the `strict` field in tool definitions. Default: auto-detected per provider/baseUrl (conservative for unknown providers). */
	supportsStrictMode?: boolean;
	/**
	 * Tool-schema dialect for parameter validation. `"moonshot-mfjs"` normalizes
	 * JSON Schema constructs (const->enum, etc.) rejected by Moonshot/Kimi hosts.
	 */
	toolSchemaFlavor?: "moonshot-mfjs" | "none";
	/**
	 * Stream-watchdog idle-timeout floor in ms for slow reasoning hosts.
	 * Default: auto-detected (GLM coding-plan hosts, direct DeepSeek reasoning).
	 */
	streamIdleTimeoutMs?: number;
	/** Whether the host honors `prompt_cache_retention: "24h"` on the Responses API. Default: auto-detected (api.openai.com). */
	supportsLongPromptCacheRetention?: boolean;
	/** Whether tool schemas must be sent either all strict or all non-strict. Undefined keeps the existing per-tool mixed behavior. */
	toolStrictMode?: "all_strict" | "none";
	/** Whether request shaping may send reasoning params at all. Default: auto-detected (disabled for GitHub Copilot chat-completions). */
	supportsReasoningParams?: boolean;
	/** Always send a max-token field when the caller did not provide one. Default: auto-detected (Kimi-family models derive TPM limits from max_tokens). */
	alwaysSendMaxTokens?: boolean;
	/** Whether Responses-API tool-call/result history must be strictly paired. Default: auto-detected (Azure OpenAI, GitHub Copilot). */
	strictResponsesPairing?: boolean;
	/** Whether the Responses API accepts the `detail: "original"` image hint. Default: auto-detected (false for GitHub Copilot, which rejects it with a 400). */
	supportsImageDetailOriginal?: boolean;
	/** Whether streamed reasoning deltas for the same field may repeat the full cumulative text snapshot. Default: false. */
	reasoningDeltasMayBeCumulative?: boolean;
	/**
	 * Whether the host serves the Responses server-side compaction endpoint
	 * (`POST /responses/compact`, OpenAI Compaction guide). Default:
	 * auto-detected (official api.openai.com and Azure OpenAI v1 hosts). Set
	 * true to opt a compatible gateway in, false to opt out.
	 */
	supportsServerCompaction?: boolean;
	/** Strip leaked DeepSeek chat-template special tokens from visible content deltas. Default: auto-detected. */
	stripDeepseekSpecialTokens?: boolean;
	/** Heal leaked chat-template/tool-call/thinking markup from visible content deltas. Default: auto-detected. */
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;
	/** Treat an empty length-finished stream as a context-window error. Default: auto-detected. */
	emptyLengthFinishIsContextError?: boolean;
	/** Normalize tool call ids to OpenAI's 40-character limit. Default: auto-detected. */
	usesOpenAIToolCallIdLimit?: boolean;
	/**
	 * Compat deltas applied when a request engages thinking mode.
	 * Materialized on `compat.whenThinking` for pointer-swapping (#1071/#1484).
	 */
	whenThinking?: Partial<Omit<OpenAICompat, "whenThinking">>;
}

/**
 * Compatibility settings for anthropic-messages API.
 * Use this to disable features that strict-by-default Anthropic accepts but
 * that proxy gateways (Vertex AI, AWS Bedrock-style fronts, etc.) reject.
 */
export interface AnthropicCompat {
	/**
	 * Drop the top-level `strict: true` field on tool definitions. Vertex AI's
	 * Anthropic-compatible endpoint rejects unknown tool fields with
	 * `tools.<n>.custom.strict: Extra inputs are not permitted`.
	 */
	disableStrictTools?: boolean;
	/**
	 * Map adaptive thinking (`thinking: { type: "adaptive" }`) to
	 * `{ type: "enabled", budget_tokens }`. Vertex AI rejects the `adaptive`
	 * tag with `Input tag 'adaptive' ... does not match any of the expected
	 * tags: 'disabled', 'enabled'`.
	 */
	disableAdaptiveThinking?: boolean;
	/** Whether tools may include Anthropic's per-tool eager_input_streaming flag. Default: true. */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether long prompt-cache retention (`ttl: "1h"`) is supported. Default: true for canonical Anthropic API. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Whether mid-conversation `role: "system"` messages are accepted in `messages`.
	 * Supported on first-party Claude API for newer models. Auto-detected when unset.
	 */
	supportsMidConversationSystem?: boolean;
	/**
	 * Whether the model accepts forced `tool_choice`. When false, forced choices
	 * downgrade to `auto` (needed for models rejecting forced tool use). Default: true.
	 */
	supportsForcedToolChoice?: boolean;
	/**
	 * Whether the model accepts sampling parameters (`temperature`, `top_p`,
	 * `top_k`). Opus 4.7+ and Fable/Mythos reject them with a 400. When unset,
	 * auto-detected from the model id. Default: true.
	 */
	supportsSamplingParams?: boolean;
	/**
	 * Include a non-standard `id` field (aliasing `tool_use_id`) on
	 * `tool_result` blocks. Z.AI's Anthropic-compatible proxy deserializes
	 * tool results into a class that reads `.id` (issue #814). Default:
	 * auto-detected (Z.AI hosts).
	 */
	requiresToolResultId?: boolean;
	/**
	 * Replay unsigned thinking blocks as native thinking instead of text.
	 * Used by compatible reasoning endpoints (Z.AI, DeepSeek) that omit signatures (#2005).
	 */
	replayUnsignedThinking?: boolean;
	/**
	 * Whether the endpoint requires `thinking.type: "enabled"` whenever the
	 * model reasons. Use for models that reject omitted or disabled thinking.
	 */
	requiresThinkingEnabled?: boolean;
	/**
	 * Prefix Anthropic built-in tool names (`web_search`, `code_execution`, ...)
	 * when they are ordinary client tools. Some Anthropic-compatible gateways
	 * intercept those exact names as server tools and return raw search/result
	 * blocks instead of normal `tool_use` calls.
	 */
	escapeBuiltinToolNames?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * @see https://openrouter.ai/docs/provider-routing
 */
export interface OpenRouterRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["amazon-bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

/**
 * Fields whose meaning is identical across chat-completions and Responses surfaces.
 * Each builder still computes its own per-surface value when defaults diverge.
 */
export interface ResolvedOpenAISharedCompat {
	supportsDeveloperRole: boolean;
	supportsStrictMode: boolean;
	supportsReasoningEffort: boolean;
	reasoningEffortMap: Partial<Record<Effort, string>>;
	supportsReasoningParams: boolean;
	thinkingFormat: OpenAIReasoningFormat;
	reasoningDisableMode: OpenAIReasoningDisableMode;
	omitReasoningEffort: boolean;
	includeEncryptedReasoning: boolean;
	filterReasoningHistory: boolean;
	disableReasoningOnForcedToolChoice: boolean;
	disableReasoningOnToolChoice: boolean;
	supportsToolChoice: boolean;
	supportsForcedToolChoice: boolean;
	supportsNamedToolChoice: boolean;
	reasoningContentField?: OpenAICompat["reasoningContentField"];
	requiresReasoningContentForToolCalls: boolean;
	requiresReasoningContentForAllAssistantTurns: boolean;
	allowsSyntheticReasoningContentForToolCalls: boolean;
	replayReasoningContent: boolean;
	qwenPreserveThinking: boolean;
	requiresThinkingAsText: boolean;
	requiresMistralToolIds: boolean;
	requiresToolResultName: boolean;
	requiresAssistantAfterToolResult: boolean;
	requiresAssistantContentForToolCalls: boolean;
	stripDeepseekSpecialTokens: boolean;
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;
	reasoningDeltasMayBeCumulative: boolean;
	emptyLengthFinishIsContextError: boolean;
	usesOpenAIToolCallIdLimit: boolean;
	promptCacheSessionHeader?: OpenAICompat["promptCacheSessionHeader"];
	/** The model sits behind OpenRouter (routing prefs apply). */
	isOpenRouterHost: boolean;
	/**
	 * The model sits behind a multi-upstream router (OpenRouter, the Hugging
	 * Face Inference Providers router) whose routed upstreams enforce output
	 * caps that differ from the catalog value. Catalog-default max-token caps
	 * are omitted so each upstream self-caps; explicit caller caps still win.
	 */
	routedUpstreamSelfCaps: boolean;
	/** Whether this endpoint needs a max-token field even when caller did not set one. */
	alwaysSendMaxTokens: boolean;
	/** See {@link OpenAICompat.enableGeminiThinkingLoopGuard}. Set by the builder from the family classifier. */
	enableGeminiThinkingLoopGuard?: boolean;
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	/** Provider-specific wire model-id transform applied to the base id. */
	wireModelIdMode: "raw" | "firepass" | "fireworks" | "openrouter";
}

/**
 * Fully-resolved chat-completions compat view: every detected default
 * materialized and user overrides applied. Built once per model by
 * `buildModel`; request handlers read fields and never detect, resolve, or
 * allocate.
 */
export type ResolvedOpenAICompat = ResolvedOpenAISharedCompat &
	Required<
		Omit<
			OpenAICompat,
			| "supportsDeveloperRole"
			| "supportsReasoningEffort"
			| "reasoningEffortMap"
			| "supportsReasoningParams"
			| "thinkingFormat"
			| "reasoningDisableMode"
			| "omitReasoningEffort"
			| "includeEncryptedReasoning"
			| "filterReasoningHistory"
			| "disableReasoningOnForcedToolChoice"
			| "disableReasoningOnToolChoice"
			| "supportsToolChoice"
			| "supportsForcedToolChoice"
			| "supportsNamedToolChoice"
			| "reasoningContentField"
			| "requiresReasoningContentForToolCalls"
			| "requiresReasoningContentForAllAssistantTurns"
			| "allowsSyntheticReasoningContentForToolCalls"
			| "replayReasoningContent"
			| "qwenPreserveThinking"
			| "requiresThinkingAsText"
			| "requiresMistralToolIds"
			| "requiresToolResultName"
			| "requiresAssistantAfterToolResult"
			| "requiresAssistantContentForToolCalls"
			| "stripDeepseekSpecialTokens"
			| "streamMarkupHealingPattern"
			| "reasoningDeltasMayBeCumulative"
			| "supportsServerCompaction"
			| "emptyLengthFinishIsContextError"
			| "usesOpenAIToolCallIdLimit"
			| "promptCacheSessionHeader"
			| "openRouterRouting"
			| "isOpenRouterHost"
			| "supportsStrictMode"
			| "supportsLongPromptCacheRetention"
			| "alwaysSendMaxTokens"
			| "wireModelIdMode"
			| "vercelGatewayRouting"
			| "extraBody"
			| "toolStrictMode"
			| "toolSchemaFlavor"
			| "streamIdleTimeoutMs"
			| "cacheControlFormat"
			| "thinkingKeep"
			| "strictResponsesPairing"
			| "supportsImageDetailOriginal"
			| "enableGeminiThinkingLoopGuard"
			| "whenThinking"
		>
	> & {
		vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
		extraBody?: OpenAICompat["extraBody"];
		cacheControlFormat?: OpenAICompat["cacheControlFormat"];
		thinkingKeep?: OpenAICompat["thinkingKeep"];
		streamIdleTimeoutMs?: number;
		toolStrictMode: ResolvedToolStrictMode;
		toolSchemaFlavor?: OpenAICompat["toolSchemaFlavor"];
		/** The model sits behind Vercel AI Gateway. */
		isVercelGatewayHost: boolean;
		dropThinkingWhenReasoningEffort: boolean;
		/** Complete alternate view for thinking-engaged requests; swap pointers, never spread. */
		whenThinking?: ResolvedOpenAICompat;
	};

/** Fully-resolved Responses-API compat view (same contract as `ResolvedOpenAICompat`). */
export interface ResolvedOpenAIResponsesCompat extends ResolvedOpenAISharedCompat {
	supportsLongPromptCacheRetention: boolean;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	supportsObfuscationOptOut: boolean;
	/**
	 * The host serves `POST /responses/compact` (OpenAI Compaction guide:
	 * official api.openai.com, and Azure OpenAI's v1 API per Microsoft Learn).
	 * Server-side compaction is resolved from this flag plus the api family,
	 * so a second compatible host opts in with this data entry alone.
	 */
	supportsServerCompaction: boolean;
	streamIdleTimeoutMs?: number;
}

/**
 * OpenRouter is a pseudo API: runtime dispatch can use either Responses
 * (default) or Chat Completions (`VEYYON_OPENROUTER_RESPONSES=0`) with the same
 * model object, so its resolved compat must satisfy both handlers.
 */
export type ResolvedOpenRouterCompat = ResolvedOpenAICompat & ResolvedOpenAIResponsesCompat;

/** Fully-resolved anthropic-messages compat view (same contract as `ResolvedOpenAICompat`). */
export type ResolvedAnthropicCompat = Required<AnthropicCompat> & {
	/**
	 * The configured endpoint is the official first-party Anthropic API
	 * (https + exact `api.anthropic.com` host; a missing baseUrl counts as
	 * official because dispatch defaults there). Gates OAuth framing, custom
	 * env headers, and cache-TTL shaping without per-request URL parsing.
	 */
	officialEndpoint: boolean;
	/**
	 * Whether endpoint enforces Anthropic's signature protocol on replayed thinking blocks.
	 * Downstream transforms strip stale signatures to avoid 400 errors (#4297).
	 */
	signingEndpoint: boolean;
};

/**
 * Compatibility settings for devin-agent (Codeium Cascade) API, where reasoning
 * effort routes via sibling model IDs rather than wire fields.
 */
export interface DevinCompat {
	/**
	 * Trust only explicit `thinking` metadata; never derive a thinking surface
	 * from model identity. A reasoning model with no explicit routed thinking
	 * resolves to `thinking: undefined` (`reasoning: true`, no controllable
	 * effort) instead of a fabricated minimal/low/medium/high ladder.
	 */
	trustExplicitThinkingOnly?: boolean;
}

/** Fully-resolved devin-agent compat view. */
export type ResolvedDevinCompat = Required<DevinCompat>;

/**
 * Compatibility settings for cursor-agent API, where reasoning effort routes
 * via tier-suffixed sibling model IDs rather than wire fields.
 */
export interface CursorCompat {
	/**
	 * Trust only explicit `thinking` metadata; never derive a thinking surface
	 * from model identity. A reasoning model with no explicit routed thinking
	 * resolves to `thinking: undefined` (`reasoning: true`, no controllable
	 * effort) instead of a fabricated minimal/low/medium/high ladder.
	 */
	trustExplicitThinkingOnly?: boolean;
}

/** Fully-resolved cursor-agent compat view. */
export type ResolvedCursorCompat = Required<CursorCompat>;

/** Sparse, user-authored compat overrides for a given API (models.json / config vocabulary). */
export type CompatConfigOf<TApi extends Api> = TApi extends
	| "openai-completions"
	| "openrouter"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	? OpenAICompat
	: TApi extends "anthropic-messages"
		? AnthropicCompat
		: TApi extends "devin-agent"
			? DevinCompat
			: TApi extends "cursor-agent"
				? CursorCompat
				: undefined;

/** Resolved compat for a given API: complete record, materialized once by `buildModel`. */
export type CompatOf<TApi extends Api> = TApi extends "openrouter"
	? ResolvedOpenRouterCompat
	: TApi extends "openai-completions"
		? ResolvedOpenAICompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? ResolvedOpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? ResolvedAnthropicCompat
				: TApi extends "devin-agent"
					? ResolvedDevinCompat
					: TApi extends "cursor-agent"
						? ResolvedCursorCompat
						: undefined;

// Model interface for the unified model system
export interface Model<TApi extends Api = Api> {
	id: string;
	/**
	 * Upstream wire model ID when different from local `id`.
	 * Providers serialize `requestModelId ?? id` while local tracking uses `id`.
	 */
	requestModelId?: string;
	/**
	 * `reasoning.mode` to send on OpenAI Responses-family requests. Set on
	 * generated pro aliases (`gpt-5.6-*-pro` on `openai`/`openai-codex`) that
	 * pair a base wire id (`requestModelId`) with OpenAI's pro reasoning
	 * serving path. Absent everywhere else; providers omit the wire field.
	 */
	reasoningMode?: "pro";
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/**
	 * Decoder family used for image inputs when it has narrower format support
	 * than Veyyon's general image pipeline. `stb` local backends reject WebP.
	 */
	imageInputDecoder?: "stb";
	/**
	 * Native provider tool-call support. `false` is the only unsupported signal:
	 * `true` and `undefined` both mean callers may use native tools. Catalog and
	 * discovery sources should set this sparsely when an upstream explicitly
	 * reports that native tool calling is unsupported.
	 */
	supportsTools?: boolean;
	/** GitLab Duo Workflow root namespace selected during catalog discovery. */
	gitlabDuoWorkflowRootNamespaceId?: string;
	/** Cursor `max_mode` request flag returned by `GetUsableModels` for premium models that require max mode. */
	cursorMaxMode?: boolean;
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	/**
	 * Whether {@link cost} numbers were published by upstream or unpriced (`"unknown"`).
	 * Distinguishes unpriced models from genuinely free zero-cost models.
	 */
	pricing?: "published" | "unknown";
	/** Premium Copilot requests charged per user-initiated request (defaults to 1). */
	premiumMultiplier?: number;
	contextWindow: number | null;
	maxTokens: number | null;
	/**
	 * When true, omit max output tokens on outbound requests to let upstream cap them.
	 * Used for proxies (e.g. Ollama) forwarding to backends with unknown output limits.
	 */
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	/**
	 * Streaming transport override. When `"pi-native"`, routes streaming requests
	 * through `POST /v1/pi/stream` on an auth-gateway sidecar.
	 */
	transport?: "pi-native";
	/** Hint that websocket transport should be preferred when supported by the provider implementation. */
	preferWebsockets?: boolean;
	/** Codex Responses Lite transport: send the lite marker and carry instructions/tools as input items (mirrors codex-rs `use_responses_lite`). */
	useResponsesLite?: boolean;
	/** Preferred model to switch to when context promotion is triggered (model id or provider/id). */
	contextPromotionTarget?: string;
	/** Preferred model to use only for compaction (model id or provider/id); the active session model is unchanged. */
	compactionModel?: string;
	/** Provider-assigned priority value (lower = higher priority). */
	priority?: number;
	/** Canonical thinking capability metadata for this model. */
	thinking?: ThinkingConfig;
	/**
	 * Discovery-declared reasoning surface (models.dev `reasoning_options`),
	 * carried as data so generation-time re-baking and runtime `buildModel`
	 * resolve the same ladder. See {@link ModelReasoningOptions}.
	 */
	reasoningOptions?: ModelReasoningOptions;
	/**
	 * Fully-resolved compatibility record, materialized once by `buildModel`.
	 * Protocol handlers read fields; they never detect, resolve, or allocate.
	 */
	compat: CompatOf<TApi>;
	/** Verbatim sparse compat from the spec (user/config intent), for introspection only. */
	compatConfig?: CompatConfigOf<TApi>;
	/**
	 * Shape to use when exposing Codex `apply_patch` (`"freeform"` raw patch or
	 * `"function"` JSON envelope).
	 */
	applyPatchToolType?: "freeform" | "function";
	/**
	 * Force OAuth-style request shaping for providers whose API key prefix doesn't
	 * match an OAuth token (e.g. routing Anthropic traffic through a proxy that
	 * expects Claude Code framing). When true, the streaming layer sets
	 * `options.isOAuth = true` for the underlying provider call.
	 */
	isOAuth?: boolean;
}

/**
 * A model as authored by configs, bundled catalogs, and discovery — the input
 * vocabulary of `buildModel`. Identical to `Model` except `compat` carries the
 * sparse override shape and nothing is resolved yet.
 */
export interface ModelSpec<TApi extends Api = Api> extends Omit<Model<TApi>, "compat" | "compatConfig"> {
	/** Sparse compatibility overrides; resolved into `Model.compat` by `buildModel`. */
	compat?: CompatConfigOf<TApi>;
}
