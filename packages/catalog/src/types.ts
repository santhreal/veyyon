import type { Effort } from "./effort";

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

export const THINKING_CONTROL_MODES = [
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
] as const;

export type ThinkingControlMode = (typeof THINKING_CONTROL_MODES)[number];

export interface ThinkingConfig {
	/** Provider-specific transport used to encode the selected effort. */
	mode: ThinkingControlMode;
	/** Supported user-facing efforts, ordered least to most intensive. */
	efforts: readonly Effort[];
	/** Optional default effort applied when this model is selected. Falls back to global default if absent. */
	defaultLevel?: Effort;
	/** Effort to provider wire-value remap baked at build time. */
	effortMap?: Partial<Record<Effort, string>>;
	/** Whether adaptive thinking accepts the display field. */
	supportsDisplay?: boolean;
	/** Per-effort upstream wire-id routing for collapsed effort-tier variants. */
	effortRouting?: Readonly<Partial<Record<Effort | "off", string>>>;
	/** Per-effort thinking budget in tokens for budget-mode variants. */
	effortBudgets?: Readonly<Partial<Record<Effort, number>>>;
	/** When true, thinking-off requests must explicitly suppress thinking on the wire. */
	suppressWhenOff?: boolean;
	/** When true, reasoning is mandatory upstream and cannot be disabled. */
	requiresEffort?: boolean;
}

export interface ModelReasoningOptions {
	/** Effort levels accepted by the endpoint. */
	efforts?: readonly Effort[];
	/** When true, discovery explicitly reports no selectable efforts. */
	noEffortControl?: boolean;
}

export type Provider = string;

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
	/** Reasoning tokens included in output, when reported by provider. */
	reasoningTokens?: number;
	/** Cache-write TTL breakdown (Anthropic only). */
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	/** Server-side tool invocations made during this turn. */
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	/** Billed tokens from aborted or discarded attempts retried in place. */
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
	/** Total turn cost breakdown in USD. */
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type OpenAIReasoningFormat = "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";

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

export interface OpenAICompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the chat-completions endpoint accepts multiple leading system messages. */
	supportsMultipleSystemMessages?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Optional mapping from pi-ai reasoning levels to provider/model-specific `reasoning_effort` values. */
	reasoningEffortMap?: Partial<Record<Effort, string>>;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Enable Gemini thinking-loop guard for this model. */
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
	/** Replay thinking blocks as reasoning_content on every assistant turn with reasoning. */
	replayReasoningContent?: boolean;
	/** Send preserve_thinking: true for Qwen chat templates. */
	qwenPreserveThinking?: boolean;
	/** Whether assistant tool-call messages must include non-empty content. Default: false. */
	requiresAssistantContentForToolCalls?: boolean;
	/** Whether the provider supports the `tool_choice` parameter. Default: true. */
	supportsToolChoice?: boolean;
	/** Whether forced tool_choice values ('required' or named tools) are accepted. */
	supportsForcedToolChoice?: boolean;
	/** Whether chat-completions endpoint accepts object-form named function tool_choice. */
	supportsNamedToolChoice?: boolean;
	/** Drop reasoning fields when tool_choice forces a tool call. */
	disableReasoningOnForcedToolChoice?: boolean;
	/** Drop reasoning fields for any request sending tool_choice. */
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
	/** Tool-schema dialect the endpoint validates tools against. */
	toolSchemaFlavor?: "moonshot-mfjs" | "none";
	/** Stream-watchdog idle-timeout floor in ms for slow reasoning hosts. */
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
	/** Whether host serves Responses server-side compaction endpoint. */
	supportsServerCompaction?: boolean;
	/** Strip leaked DeepSeek chat-template special tokens from visible content deltas. Default: auto-detected. */
	stripDeepseekSpecialTokens?: boolean;
	/** Heal leaked chat-template/tool-call/thinking markup from visible content deltas. Default: auto-detected. */
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;
	/** Treat an empty length-finished stream as a context-window error. Default: auto-detected. */
	emptyLengthFinishIsContextError?: boolean;
	/** Normalize tool call ids to OpenAI's 40-character limit. Default: auto-detected. */
	usesOpenAIToolCallIdLimit?: boolean;
	/** Compat deltas applied when a request engages thinking mode. */
	whenThinking?: Partial<Omit<OpenAICompat, "whenThinking">>;
}

export interface AnthropicCompat {
	/** Drop top-level strict: true on tool definitions. */
	disableStrictTools?: boolean;
	/** Map adaptive thinking to budget_tokens. */
	disableAdaptiveThinking?: boolean;
	/** Whether tools may include Anthropic's per-tool eager_input_streaming flag. Default: true. */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether long prompt-cache retention (`ttl: "1h"`) is supported. Default: true for canonical Anthropic API. */
	supportsLongCacheRetention?: boolean;
	/** Whether mid-conversation system messages are accepted in messages array. */
	supportsMidConversationSystem?: boolean;
	supportsForcedToolChoice?: boolean;
	supportsSamplingParams?: boolean;
	requiresToolResultId?: boolean;
	replayUnsignedThinking?: boolean;
	requiresThinkingEnabled?: boolean;
	/** Prefix Anthropic built-in tool names when used as client tools. */
	escapeBuiltinToolNames?: boolean;
}

export interface OpenRouterRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["amazon-bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

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
	/** Whether model sits behind a multi-upstream router. */
	routedUpstreamSelfCaps: boolean;
	/** Whether this endpoint needs a max-token field even when caller did not set one. */
	alwaysSendMaxTokens: boolean;
	/** See {@link OpenAICompat.enableGeminiThinkingLoopGuard}. Set by the builder from the family classifier. */
	enableGeminiThinkingLoopGuard?: boolean;
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	/** Provider-specific wire model-id transform applied to the base id. */
	wireModelIdMode: "raw" | "firepass" | "fireworks" | "openrouter";
}

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

export interface ResolvedOpenAIResponsesCompat extends ResolvedOpenAISharedCompat {
	supportsLongPromptCacheRetention: boolean;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	supportsObfuscationOptOut: boolean;
	/** Whether host serves POST /responses/compact. */
	supportsServerCompaction: boolean;
	streamIdleTimeoutMs?: number;
}

export type ResolvedOpenRouterCompat = ResolvedOpenAICompat & ResolvedOpenAIResponsesCompat;

export type ResolvedAnthropicCompat = Required<AnthropicCompat> & {
	/** Whether endpoint is official first-party Anthropic API. */
	officialEndpoint: boolean;
	/** Whether endpoint enforces Anthropic signature protocol on thinking blocks. */
	signingEndpoint: boolean;
};

export interface DevinCompat {
	/** Trust only explicit thinking metadata; never derive from model identity. */
	trustExplicitThinkingOnly?: boolean;
}

export type ResolvedDevinCompat = Required<DevinCompat>;

export interface CursorCompat {
	/** Trust only explicit thinking metadata; never derive from model identity. */
	trustExplicitThinkingOnly?: boolean;
}

export type ResolvedCursorCompat = Required<CursorCompat>;

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

export interface Model<TApi extends Api = Api> {
	id: string;
	/** Model id to send on the wire when it differs from id. */
	requestModelId?: string;
	/** reasoning.mode to send on OpenAI Responses-family requests. */
	reasoningMode?: "pro";
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** Decoder family used for image inputs. */
	imageInputDecoder?: "stb";
	/** Native provider tool-call support. */
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
	/** Whether cost numbers were published by upstream or unknown. */
	pricing?: "published" | "unknown";
	/** Premium Copilot requests charged per user-initiated request (defaults to 1). */
	premiumMultiplier?: number;
	contextWindow: number | null;
	maxTokens: number | null;
	/** Omit max output tokens field from outbound request. */
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	/** Streaming transport override. */
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
	/** Discovery-declared reasoning surface. */
	reasoningOptions?: ModelReasoningOptions;
	/** Fully-resolved compatibility record materialized by buildModel. */
	compat: CompatOf<TApi>;
	/** Verbatim sparse compat from the spec (user/config intent), for introspection only. */
	compatConfig?: CompatConfigOf<TApi>;
	/** Shape to use when exposing Codex apply_patch tool. */
	applyPatchToolType?: "freeform" | "function";
	/** Force OAuth-style request shaping. */
	isOAuth?: boolean;
}

export interface ModelSpec<TApi extends Api = Api> extends Omit<Model<TApi>, "compat" | "compatConfig"> {
	compat?: CompatConfigOf<TApi>;
}
