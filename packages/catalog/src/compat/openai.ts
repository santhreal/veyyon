import { isFireworksFastModelId } from "../fireworks-model-id";
import { hasLocalLoopbackBaseUrl, hostMatchesUrl, modelMatchesHost } from "../hosts";
import {
	isAnthropicNamespacedModelId,
	isClaudeModelId,
	isDeepseekModelIdOrName,
	isGlm52ReasoningEffortModelId,
	isGrokReasoningEffortCapable,
	isKimiK26ModelId,
	isKimiModelId,
	isMimoModelIdOrName,
	isQwenModelId,
	modelFamilyToken,
} from "../identity/family";
import { providerWireCapabilities } from "../provider-models/wire-capabilities";
import type {
	ModelSpec,
	OpenAICompat,
	OpenAIStreamMarkupHealingPattern,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	ResolvedOpenRouterCompat,
} from "../types";
import { applyCompatOverrides } from "./apply";
import { matchesKimiK27CodeFamily } from "./kimi";
import { leakedToolCallGrammar } from "./markup-leaks";

const GLM_CODING_PLAN_MODEL_PATTERN = /(^|\/)glm-5(?:[.-]|$)/i;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;
const KIMI_K26_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;
const XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000;
const ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const MINIMAX_PROVIDER_OR_ID_PATTERN = /minimax/i;

function resolveReasoningDisableMode(
	thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"],
): ResolvedOpenAISharedCompat["reasoningDisableMode"] {
	switch (thinkingFormat) {
		case "openrouter":
			return "openrouter-enabled-false";
		case "zai":
			return "zai-thinking-disabled";
		case "qwen":
			return "qwen-enable-thinking-false";
		case "qwen-chat-template":
			return "qwen-template-false";
		default:
			return "lowest-effort";
	}
}

function detectStreamMarkupHealingPattern(
	provider: string,
	modelId: string,
	baseUrl: string,
): OpenAIStreamMarkupHealingPattern | undefined {
	const grammar = leakedToolCallGrammar(provider, modelId);
	if (grammar) return grammar;
	if (isOfficialOpenAIEndpoint(provider, baseUrl)) return undefined;
	return "thinking";
}

export function isOfficialOpenAIEndpoint(provider: string, baseUrl: string): boolean {
	if (provider !== "openai") return false;
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

const OPENCODE_WHEN_THINKING: NonNullable<OpenAICompat["whenThinking"]> = {
	requiresReasoningContentForToolCalls: true,
	allowsSyntheticReasoningContentForToolCalls: false,
	reasoningContentField: "reasoning_content",
};

const MIMO_REASONING_EFFORT_MAP: NonNullable<OpenAICompat["reasoningEffortMap"]> = {
	minimal: "low",
	xhigh: "high",
};

function mergeMimoReasoningEffortMap(compat: ResolvedOpenAISharedCompat, enabled: boolean): void {
	if (!enabled) return;
	compat.reasoningEffortMap = { ...MIMO_REASONING_EFFORT_MAP, ...compat.reasoningEffortMap };
}

function detectStrictModeSupport(provider: string, baseUrl: string): boolean {
	if (providerWireCapabilities(provider)?.strictTools) return true;
	return (
		hostMatchesUrl(baseUrl, "openai") ||
		hostMatchesUrl(baseUrl, "azureOpenAI") ||
		hostMatchesUrl(baseUrl, "cerebras") ||
		hostMatchesUrl(baseUrl, "together") ||
		hostMatchesUrl(baseUrl, "openrouter") ||
		hostMatchesUrl(baseUrl, "deepseekFamily")
	);
}

function isLocalOpenAICompatEndpoint(provider: string, baseUrl: string): boolean {
	const capabilities = providerWireCapabilities(provider);
	if (capabilities?.forwardsUpstream) return false;
	return capabilities?.localInference === true || hasLocalLoopbackBaseUrl(baseUrl);
}

export function buildOpenAICompat(spec: ModelSpec<"openai-completions">): ResolvedOpenAICompat {
	const provider = spec.provider;
	const baseUrl = spec.baseUrl;
	const hostModel = { provider, baseUrl };

	const isCerebras = modelMatchesHost(hostModel, "cerebras");
	const isZai = modelMatchesHost(hostModel, "zai");
	const isZhipu = modelMatchesHost(hostModel, "zhipu");
	const supportsZaiReasoningEffort = (isZai || isZhipu) && isGlm52ReasoningEffortModelId(spec.id);
	const isKilo = modelMatchesHost(hostModel, "kilo");
	const isKimiModel = isKimiModelId(spec.id);
	const isMoonshotNative = modelMatchesHost(hostModel, "moonshotNative");
	const isMoonshotKimi = isKimiModel && isMoonshotNative;
	const requiresEnabledThinking = isMoonshotKimi && matchesKimiK27CodeFamily(spec);
	const usesMoonshotKimiPreservedThinking = isMoonshotKimi && isKimiK26ModelId(spec.id);
	const isAnthropicModel =
		modelMatchesHost(hostModel, "anthropic") || isClaudeModelId(spec.id) || isAnthropicNamespacedModelId(spec.id);
	const isAlibaba = modelMatchesHost(hostModel, "alibabaDashscope");
	const isNvidiaNim = modelMatchesHost(hostModel, "nvidia");
	const isQwen = isQwenModelId(spec.id);
	const lowerId = spec.id.toLowerCase();
	const lowerName = (spec.name ?? "").toLowerCase();
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isXiaomiMimo = isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));
	const isMimoReasoningEffortModel =
		!isXiaomiHost && (isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(spec.name ?? ""));
	const isOpenCodeDeepseekAlias =
		provider === "opencode-zen" && (lowerId === "big-pickle" || lowerName === "big pickle");
	const isDeepseekFamily =
		modelMatchesHost(hostModel, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(spec.name ?? "") ||
		isOpenCodeDeepseekAlias;
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	const isDirectDeepseekReasoning = isDirectDeepseekApi && isDeepseekFamily && Boolean(spec.reasoning);
	const isGrok = modelMatchesHost(hostModel, "xai");
	const isMistral = modelMatchesHost(hostModel, "mistral");
	const isOpenCodeHost = modelMatchesHost(hostModel, "opencode");
	const isNonStandard =
		isCerebras ||
		isGrok ||
		isMistral ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "deepseekFamily") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isAlibaba ||
		isZai ||
		isZhipu ||
		isKilo ||
		isQwen ||
		isXiaomiHost ||
		isMoonshotNative ||
		isOpenCodeHost;
	const isOpenCodeProvider = provider === "opencode-go" || provider === "opencode-zen";
	const isLocalOpenAICompatBackend = isLocalOpenAICompatEndpoint(provider, baseUrl);

	const useMaxTokens =
		isMistral ||
		isMoonshotNative ||
		isZai ||
		isZhipu ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "fireworks") ||
		isDirectDeepseekApi;

	const isOpenAIHost = modelMatchesHost(hostModel, "openai");
	const isAzureHost = modelMatchesHost(hostModel, "azureOpenAI");
	const isOpenRouter = modelMatchesHost(hostModel, "openrouter");
	const isHuggingfaceRouter = modelMatchesHost(hostModel, "huggingfaceRouter");
	const isVercelGateway = modelMatchesHost(hostModel, "vercelAIGateway");
	const isTogether = modelMatchesHost(hostModel, "together");
	const isFireworks = hostMatchesUrl(baseUrl, "fireworks");
	const isGroqHost = modelMatchesHost(hostModel, "groq");
	const isCopilotHost = provider === "github-copilot";
	const isZenmuxHost = provider === "zenmux";
	const isMiniMaxHost = modelMatchesHost(hostModel, "minimax");
	const isQwenPortal = modelMatchesHost(hostModel, "qwenPortal");
	const supportsMultipleSystemMessagesDefault =
		!isMiniMaxHost &&
		!isAlibaba &&
		!isQwenPortal &&
		!isQwen &&
		(isOpenAIHost ||
			isAzureHost ||
			isOpenRouter ||
			isCerebras ||
			isTogether ||
			isFireworks ||
			isGroqHost ||
			isDeepseekFamily ||
			isMistral ||
			isGrok ||
			isZai ||
			isZhipu ||
			isCopilotHost ||
			isZenmuxHost);

	const streamIdleTimeoutMs =
		GLM_CODING_PLAN_MODEL_PATTERN.test(spec.id) && (isZai || isZhipu)
			? GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
			: provider === "alibaba-coding-plan"
				? ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
				: isXiaomiMimo
					? XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS
					: spec.reasoning && isKimiK26ModelId(spec.id)
						? KIMI_K26_REASONING_STREAM_IDLE_TIMEOUT_MS
						: spec.reasoning && isDirectDeepseekApi
							? DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS
							: isLocalOpenAICompatBackend
								? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
								: undefined;

	const isFireworksFastRouter = provider === "fireworks" && isFireworksFastModelId(spec.id);
	const wireModelIdMode: ResolvedOpenAISharedCompat["wireModelIdMode"] =
		provider === "firepass" || isFireworksFastRouter
			? "firepass"
			: provider === "fireworks"
				? "fireworks"
				: isOpenRouter
					? "openrouter"
					: "raw";
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] =
		isZai || isZhipu || isMoonshotKimi || isXiaomiMimo
			? "zai"
			: isOpenRouter
				? "openrouter"
				: isQwen && isNvidiaNim
					? "qwen-chat-template"
					: isQwen && isFireworks
						? "openai"
						: isAlibaba || isQwen
							? "qwen"
							: "openai";

	const compat: ResolvedOpenAICompat = {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenAIHost || isAzureHost,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesDefault,
		supportsReasoningEffort:
			!isGrok &&
			!isXiaomiMimo &&
			!(isDeepseekFamily && isHuggingfaceRouter) &&
			(!(isZai || isZhipu) || supportsZaiReasoningEffort),
		supportsReasoningParams: provider !== "github-copilot",
		reasoningEffortMap: isMimoReasoningEffortModel ? MIMO_REASONING_EFFORT_MAP : {},
		supportsUsageInStreaming: !isCerebras,
		enableGeminiThinkingLoopGuard: modelFamilyToken(spec.id) === "gemini",
		alwaysSendMaxTokens: isKimiModel,
		disableReasoningOnForcedToolChoice: isKimiModel || isAnthropicModel,
		disableReasoningOnToolChoice: isDeepseekFamily && Boolean(spec.reasoning) && !isOpenRouter,
		supportsToolChoice: !isDirectDeepseekReasoning,
		supportsForcedToolChoice: !requiresEnabledThinking,
		supportsNamedToolChoice: provider !== "llama.cpp",
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: isMistral,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: isOpenRouter && isAnthropicModel,
		thinkingKeep: usesMoonshotKimiPreservedThinking ? "all" : undefined,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls:
			(isKimiModel && !isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(spec.reasoning)) ||
			isXiaomiMimo ||
			(isOpenRouter && Boolean(spec.reasoning)),
		requiresReasoningContentForAllAssistantTurns:
			((isDeepseekFamily && Boolean(spec.reasoning)) || isXiaomiMimo) && !isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: (!isDeepseekFamily || !spec.reasoning) && !isXiaomiMimo,
		replayReasoningContent: false,
		qwenPreserveThinking:
			(thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") && isLocalOpenAICompatBackend,
		requiresAssistantContentForToolCalls: isKimiModel || isDirectDeepseekReasoning,
		cacheControlFormat: isOpenRouter && isAnthropicModel ? "anthropic" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		routedUpstreamSelfCaps: isOpenRouter || isHuggingfaceRouter,
		wireModelIdMode,
		isVercelGatewayHost: isVercelGateway,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: isDirectDeepseekReasoning ? { thinking: { type: "enabled" } } : undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",
		toolSchemaFlavor: isMoonshotNative ? "moonshot-mfjs" : undefined,
		streamIdleTimeoutMs,
		stripDeepseekSpecialTokens:
			isDeepseekModelIdOrName(spec.id) && (provider === "nvidia" || provider === "deepseek"),
		streamMarkupHealingPattern: detectStreamMarkupHealingPattern(provider, spec.id, baseUrl),
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(provider) || MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.id),
		emptyLengthFinishIsContextError: provider === "ollama",
		usesOpenAIToolCallIdLimit: provider === "openai",
		promptCacheSessionHeader: isGrok ? "x-grok-conv-id" : undefined,
		dropThinkingWhenReasoningEffort: provider === "fireworks",
	};

	applyCompatOverrides(compat, spec.compat);
	if (spec.compat?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = requiresEnabledThinking
			? "omit"
			: resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (spec.compat?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}
	mergeMimoReasoningEffortMap(compat, isMimoReasoningEffortModel);

	const whenThinkingPolicy =
		spec.compat?.whenThinking ?? (isOpenCodeProvider && spec.reasoning ? OPENCODE_WHEN_THINKING : undefined);
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat };
		applyCompatOverrides(variant, whenThinkingPolicy);
		if (whenThinkingPolicy.reasoningDisableMode === undefined) {
			variant.reasoningDisableMode = resolveReasoningDisableMode(variant.thinkingFormat);
		}
		if (whenThinkingPolicy.omitReasoningEffort === undefined && !variant.supportsReasoningEffort) {
			variant.omitReasoningEffort = true;
		}
		mergeMimoReasoningEffortMap(variant, isMimoReasoningEffortModel);
		compat.whenThinking = variant;
	}

	return compat;
}

interface OpenAIResponsesSpecLike {
	id?: string;
	provider: string;
	name: string;
	baseUrl: string;
	reasoning?: boolean;
	compat?: OpenAICompat;
}

export function buildOpenAIResponsesCompat(spec: OpenAIResponsesSpecLike): ResolvedOpenAIResponsesCompat {
	const baseUrl = spec.baseUrl ?? "";
	const isAzure = modelMatchesHost({ provider: spec.provider, baseUrl }, "azureOpenAI");
	const isCodexBackend = modelMatchesHost({ provider: spec.provider, baseUrl }, "codexBackend");
	const isOpenRouter = modelMatchesHost({ provider: spec.provider, baseUrl }, "openrouter");
	const isHuggingfaceRouter = modelMatchesHost({ provider: spec.provider, baseUrl }, "huggingfaceRouter");
	const isOpenAIUrl = hostMatchesUrl(baseUrl, "openai");
	const id = spec.id ?? "";
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] = isOpenRouter ? "openrouter" : "openai";
	const isKimiModel = id ? isKimiModelId(id) : false;
	const isAnthropicModel = id ? isClaudeModelId(id) || isAnthropicNamespacedModelId(id) : false;
	const isDeepseekFamily = id ? isDeepseekModelIdOrName(id) || isDeepseekModelIdOrName(spec.name) : false;
	const reasoningCapable = Boolean(spec.reasoning);
	const isLocalOpenAICompatBackend = isLocalOpenAICompatEndpoint(spec.provider, baseUrl);

	const compat: ResolvedOpenAIResponsesCompat = {
		supportsDeveloperRole: isAzure || isOpenAIUrl || hostMatchesUrl(baseUrl, "githubCopilot"),
		supportsStrictMode: isAzure || detectStrictModeSupport(spec.provider, baseUrl),
		supportsReasoningEffort: spec.provider !== "xai-oauth" || isGrokReasoningEffortCapable(id),
		supportsLongPromptCacheRetention: isOpenAIUrl,
		strictResponsesPairing: isAzure || spec.provider === "github-copilot",
		supportsImageDetailOriginal:
			spec.provider !== "xai-oauth" && !modelMatchesHost({ provider: spec.provider, baseUrl }, "githubCopilot"),
		reasoningEffortMap: {},
		supportsReasoningParams: true,
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: spec.provider !== "xai-oauth",
		filterReasoningHistory: spec.provider === "xai-oauth" || (isOpenRouter && isAnthropicModel),
		disableReasoningOnForcedToolChoice: isKimiModel,
		disableReasoningOnToolChoice: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		supportsToolChoice: true,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls:
			(isKimiModel || (isDeepseekFamily && reasoningCapable) || (isOpenRouter && reasoningCapable)) &&
			reasoningCapable,
		requiresReasoningContentForAllAssistantTurns: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseekFamily || !reasoningCapable,
		replayReasoningContent: false,
		qwenPreserveThinking: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresAssistantContentForToolCalls: isKimiModel,
		openRouterRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		routedUpstreamSelfCaps: isOpenRouter || isHuggingfaceRouter,
		wireModelIdMode: isOpenRouter ? "openrouter" : "raw",
		alwaysSendMaxTokens: spec.id ? isKimiModelId(spec.id) : false,
		enableGeminiThinkingLoopGuard: modelFamilyToken(spec.id ?? "") === "gemini",
		supportsObfuscationOptOut: isOfficialOpenAIEndpoint(spec.provider, baseUrl),
		supportsServerCompaction: isOfficialOpenAIEndpoint(spec.provider, baseUrl) || isAzure || isCodexBackend,
		stripDeepseekSpecialTokens:
			Boolean(id) && isDeepseekModelIdOrName(id) && (spec.provider === "nvidia" || spec.provider === "deepseek"),
		streamMarkupHealingPattern: id ? detectStreamMarkupHealingPattern(spec.provider, id, baseUrl) : undefined,
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.provider) || (id ? MINIMAX_PROVIDER_OR_ID_PATTERN.test(id) : false),
		emptyLengthFinishIsContextError: spec.provider === "ollama",
		usesOpenAIToolCallIdLimit: spec.provider === "openai",
		promptCacheSessionHeader: spec.provider === "xai-oauth" ? "x-grok-conv-id" : undefined,
		streamIdleTimeoutMs: isLocalOpenAICompatBackend
			? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
			: spec.compat?.streamIdleTimeoutMs,
	};
	applyCompatOverrides(compat, spec.compat);
	if (spec.compat?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (spec.compat?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}
	return compat;
}

type ResponsesOnlyCompat = Omit<ResolvedOpenAIResponsesCompat, keyof ResolvedOpenAISharedCompat>;

function pickResponsesOnly(compat: ResolvedOpenAIResponsesCompat): ResponsesOnlyCompat {
	return {
		supportsLongPromptCacheRetention: compat.supportsLongPromptCacheRetention,
		strictResponsesPairing: compat.strictResponsesPairing,
		supportsImageDetailOriginal: compat.supportsImageDetailOriginal,
		supportsObfuscationOptOut: compat.supportsObfuscationOptOut,
		supportsServerCompaction: compat.supportsServerCompaction,
	} satisfies ResponsesOnlyCompat;
}

export function buildOpenRouterCompat(spec: ModelSpec<"openrouter">): ResolvedOpenRouterCompat {
	const chat = buildOpenAICompat({
		...spec,
		api: "openai-completions",
	} as ModelSpec<"openai-completions">);
	const responses = buildOpenAIResponsesCompat(spec);
	return { ...chat, ...pickResponsesOnly(responses) } as ResolvedOpenRouterCompat;
}
