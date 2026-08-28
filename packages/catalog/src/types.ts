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
	mode: ThinkingControlMode;
	efforts: readonly Effort[];
	defaultLevel?: Effort;
	effortMap?: Partial<Record<Effort, string>>;
	supportsDisplay?: boolean;
	effortRouting?: Readonly<Partial<Record<Effort | "off", string>>>;
	effortBudgets?: Readonly<Partial<Record<Effort, number>>>;
	suppressWhenOff?: boolean;
	requiresEffort?: boolean;
}

export interface ModelReasoningOptions {
	efforts?: readonly Effort[];
	noEffortControl?: boolean;
}

export type Provider = string;

export type ThinkingBudgets = { [key in Effort]?: number };

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestration?: {
		input?: number;
		cacheRead?: number;
		output?: number;
	};
	premiumRequests?: number;
	reasoningTokens?: number;
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	discarded?: {
		attempts: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
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
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsMultipleSystemMessages?: boolean;
	supportsReasoningEffort?: boolean;
	reasoningEffortMap?: Partial<Record<Effort, string>>;
	supportsUsageInStreaming?: boolean;
	enableGeminiThinkingLoopGuard?: boolean;
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	requiresMistralToolIds?: boolean;
	thinkingFormat?: OpenAIReasoningFormat;
	reasoningDisableMode?: OpenAIReasoningDisableMode;
	omitReasoningEffort?: boolean;
	includeEncryptedReasoning?: boolean;
	filterReasoningHistory?: boolean;
	thinkingKeep?: "all" | false;
	reasoningContentField?: "reasoning_content" | "reasoning" | "reasoning_text";
	requiresReasoningContentForToolCalls?: boolean;
	requiresReasoningContentForAllAssistantTurns?: boolean;
	allowsSyntheticReasoningContentForToolCalls?: boolean;
	replayReasoningContent?: boolean;
	qwenPreserveThinking?: boolean;
	requiresAssistantContentForToolCalls?: boolean;
	supportsToolChoice?: boolean;
	supportsForcedToolChoice?: boolean;
	supportsNamedToolChoice?: boolean;
	disableReasoningOnForcedToolChoice?: boolean;
	disableReasoningOnToolChoice?: boolean;
	openRouterRouting?: OpenRouterRouting;
	vercelGatewayRouting?: VercelGatewayRouting;
	extraBody?: Record<string, unknown>;
	promptCacheSessionHeader?: "x-grok-conv-id";
	cacheControlFormat?: "anthropic" | undefined;
	supportsStrictMode?: boolean;
	toolSchemaFlavor?: "moonshot-mfjs" | "none";
	streamIdleTimeoutMs?: number;
	supportsLongPromptCacheRetention?: boolean;
	toolStrictMode?: "all_strict" | "none";
	supportsReasoningParams?: boolean;
	alwaysSendMaxTokens?: boolean;
	strictResponsesPairing?: boolean;
	supportsImageDetailOriginal?: boolean;
	reasoningDeltasMayBeCumulative?: boolean;
	supportsServerCompaction?: boolean;
	stripDeepseekSpecialTokens?: boolean;
	streamMarkupHealingPattern?: OpenAIStreamMarkupHealingPattern;
	emptyLengthFinishIsContextError?: boolean;
	usesOpenAIToolCallIdLimit?: boolean;
	whenThinking?: Partial<Omit<OpenAICompat, "whenThinking">>;
}

export interface AnthropicCompat {
	disableStrictTools?: boolean;
	disableAdaptiveThinking?: boolean;
	supportsEagerToolInputStreaming?: boolean;
	supportsLongCacheRetention?: boolean;
	supportsMidConversationSystem?: boolean;
	supportsForcedToolChoice?: boolean;
	supportsSamplingParams?: boolean;
	requiresToolResultId?: boolean;
	replayUnsignedThinking?: boolean;
	requiresThinkingEnabled?: boolean;
	escapeBuiltinToolNames?: boolean;
}

export interface OpenRouterRouting {
	only?: string[];
	order?: string[];
}

export interface VercelGatewayRouting {
	only?: string[];
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
	isOpenRouterHost: boolean;
	routedUpstreamSelfCaps: boolean;
	alwaysSendMaxTokens: boolean;
	enableGeminiThinkingLoopGuard?: boolean;
	openRouterRouting?: OpenAICompat["openRouterRouting"];
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
		isVercelGatewayHost: boolean;
		dropThinkingWhenReasoningEffort: boolean;
		whenThinking?: ResolvedOpenAICompat;
	};

export interface ResolvedOpenAIResponsesCompat extends ResolvedOpenAISharedCompat {
	supportsLongPromptCacheRetention: boolean;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	supportsObfuscationOptOut: boolean;
	supportsServerCompaction: boolean;
	streamIdleTimeoutMs?: number;
}

export type ResolvedOpenRouterCompat = ResolvedOpenAICompat & ResolvedOpenAIResponsesCompat;

export type ResolvedAnthropicCompat = Required<AnthropicCompat> & {
	officialEndpoint: boolean;
	signingEndpoint: boolean;
};

export interface DevinCompat {
	trustExplicitThinkingOnly?: boolean;
}

export type ResolvedDevinCompat = Required<DevinCompat>;

export interface CursorCompat {
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
	requestModelId?: string;
	reasoningMode?: "pro";
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	imageInputDecoder?: "stb";
	supportsTools?: boolean;
	gitlabDuoWorkflowRootNamespaceId?: string;
	cursorMaxMode?: boolean;
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	pricing?: "published" | "unknown";
	premiumMultiplier?: number;
	contextWindow: number | null;
	maxTokens: number | null;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	transport?: "pi-native";
	preferWebsockets?: boolean;
	useResponsesLite?: boolean;
	contextPromotionTarget?: string;
	compactionModel?: string;
	priority?: number;
	thinking?: ThinkingConfig;
	reasoningOptions?: ModelReasoningOptions;
	compat: CompatOf<TApi>;
	compatConfig?: CompatConfigOf<TApi>;
	applyPatchToolType?: "freeform" | "function";
	isOAuth?: boolean;
}

export interface ModelSpec<TApi extends Api = Api> extends Omit<Model<TApi>, "compat" | "compatConfig"> {
	compat?: CompatConfigOf<TApi>;
}
