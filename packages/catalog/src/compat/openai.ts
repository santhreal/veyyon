/**
 * OpenAI-API compat builders — chat-completions and Responses flavors.
 *
 * `buildOpenAICompat`/`buildOpenAIResponsesCompat` run exactly once per model
 * (from `buildModel`): detection writes a fresh record, sparse spec overrides
 * are assigned onto it in place, and conditional policies are materialized as
 * complete alternate views. Request handlers read `model.compat` fields and
 * never detect, resolve, or allocate.
 */
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

/** GLM coding-plan SKUs idle for minutes mid-reasoning; see `streamIdleTimeoutMs`. */
const GLM_CODING_PLAN_MODEL_PATTERN = /(^|\/)glm-5(?:[.-]|$)/i;
const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
/** Direct DeepSeek reasoning models stall between thinking and answer phases. */
const DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Kimi K2.6 can spend several minutes reasoning before the first visible token. */
const KIMI_K26_REASONING_STREAM_IDLE_TIMEOUT_MS = 300_000;
/**
 * Native Kimi K2.7 Code requires `thinking.type: "enabled"` and rejects
 * disabled thinking. Match the public id, its Fast variant, and the
 * `kimi-code/kimi-for-coding` alias (which keeps the family name).
 * Caller-disabled requests on non-native dialects (Fireworks `openai`,
 * OpenRouter `openrouter`, …) MUST keep their per-dialect disable shape —
 * gating on `isMoonshotKimi` is the caller's responsibility.
 */
/** Xiaomi MiMo Pro on api.xiaomimimo.com can stall ~2min before the first event (issue #1770). */
const XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Alibaba Coding Plan (coding-intl.dashscope) qwen models idle before the first event (issue #1770). */
const ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
/** Local OpenAI-compatible backends can spend minutes cold-loading a model before the first SSE event. */
const LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const MINIMAX_PROVIDER_OR_ID_PATTERN = /minimax/i;
// Ollama's OpenAI-compatible `reasoning.effort` accepts `high|medium|low|max|none`;
// `ollama`-provider reasoning models carry that host-declared `low..max` effort
// ladder (see OLLAMA_WIRE_EFFORTS), so no compat-level remapping is needed.
// Custom OpenAI-compatible providers pointed at a local Ollama port under a
// different provider id must set `compat.reasoningEffortMap` themselves.

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

/**
 * Pick the leaked-markup healer for an OpenAI-compatible visible-text stream.
 * Kimi chat-template tokens and DeepSeek DSML envelopes need their dedicated
 * tool-call grammars. Every other OpenAI-compatible model defaults to
 * `"thinking"` so leaked reasoning idioms (e.g. a Gemini ` ```thinking ` fence
 * on OpenRouter) are recovered from `delta.content` — **except** the official
 * OpenAI endpoint (`provider: "openai"` + `api.openai.com`), which returns
 * structured reasoning and never leaks, so it heals nothing (returns
 * `undefined`) to avoid misfiring on legitimate fenced content.
 */
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

/** Strict official-OpenAI check: provider id `openai` and an `api.openai.com` host (missing baseUrl defaults there). */
export function isOfficialOpenAIEndpoint(provider: string, baseUrl: string): boolean {
	if (provider !== "openai") return false;
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

/**
 * OpenCode's gateways (https://opencode.ai/zen|go) gate `reasoning_content`
 * on the request's thinking state for every model they front (Kimi K2.x,
 * DeepSeek V4, GLM-5.x, Qwen3.x, MiMo, MiniMax, …): they 400 with `Extra
 * inputs are not permitted` when thinking is off but the field is supplied
 * (#1071), and 400 with `thinking is enabled but reasoning_content is missing
 * in assistant tool call message at index N` (#1484) when thinking is on and
 * the field is absent. The base compat therefore leaves the replay off, and
 * this `whenThinking` policy reactivates it for thinking-engaged requests.
 * `allowsSyntheticReasoningContentForToolCalls` is forced to `false` on the
 * same path: the gateway specifically requires `reasoning_content`, and the
 * synthetic-friendly default would echo whichever field the upstream streamed
 * (e.g. `reasoning` for many opencode turns), landing the replay in the wrong
 * key and re-triggering the 400.
 */
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

/**
 * A provider whose entry declares `strictTools`, or a host known to honor them
 * — a model pointed at one of those hosts under a custom provider id gets the
 * same answer as the provider it is really talking to.
 */
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

/**
 * True for a provider running a local chat-template renderer, or for any
 * provider pointed at a loopback / RFC1918 baseUrl, and false for a provider
 * that declares it forwards to an unrelated upstream. Which providers are which
 * is declared in `provider-models/wire-capabilities.ts`, next to what every
 * other per-provider decision reads.
 */
function isLocalOpenAICompatEndpoint(provider: string, baseUrl: string): boolean {
	const capabilities = providerWireCapabilities(provider);
	if (capabilities?.forwardsUpstream) return false;
	return capabilities?.localInference === true || hasLocalLoopbackBaseUrl(baseUrl);
}

/**
 * Host and model-family classification a chat-completions compat record is
 * detected from. Computed once per model; every field below is a pure
 * function of the spec's provider id, base URL, id, name and `reasoning` flag.
 */
interface ChatCompatTraits {
	readonly reasoning: boolean;
	readonly isCerebras: boolean;
	/** z.ai or Zhipu: every consumer treats the two hosts as one family. */
	readonly isZaiFamily: boolean;
	readonly supportsZaiReasoningEffort: boolean;
	readonly isKilo: boolean;
	readonly isKimiModel: boolean;
	readonly isMoonshotNative: boolean;
	readonly isMoonshotKimi: boolean;
	readonly requiresEnabledThinking: boolean;
	readonly usesMoonshotKimiPreservedThinking: boolean;
	readonly isAnthropicModel: boolean;
	readonly isAlibaba: boolean;
	readonly isNvidiaNim: boolean;
	readonly isQwen: boolean;
	readonly isXiaomiHost: boolean;
	readonly isXiaomiMimo: boolean;
	readonly isMimoReasoningEffortModel: boolean;
	readonly isDeepseekFamily: boolean;
	readonly hasDeepseekUrl: boolean;
	readonly isDirectDeepseekApi: boolean;
	readonly isDirectDeepseekReasoning: boolean;
	readonly isGrok: boolean;
	readonly isMistral: boolean;
	readonly isOpenCodeHost: boolean;
	readonly isOpenCodeProvider: boolean;
	readonly isLocalBackend: boolean;
	readonly isOpenAIHost: boolean;
	readonly isAzureHost: boolean;
	readonly isOpenRouter: boolean;
	readonly isHuggingfaceRouter: boolean;
	readonly isVercelGateway: boolean;
	readonly isTogether: boolean;
	readonly isFireworks: boolean;
	readonly isChutes: boolean;
	readonly isGroqHost: boolean;
	readonly isCopilotHost: boolean;
	readonly isZenmuxHost: boolean;
	readonly isMiniMaxHost: boolean;
	readonly isQwenPortal: boolean;
}

/**
 * Classify the spec's host and model family. Provider takes precedence over
 * URL-based detection since it's explicitly configured.
 */
function detectChatCompatTraits(spec: ModelSpec<"openai-completions">): ChatCompatTraits {
	const { provider, baseUrl } = spec;
	const hostModel = { provider, baseUrl };
	const name = spec.name ?? "";
	const reasoning = Boolean(spec.reasoning);
	const isZaiFamily = modelMatchesHost(hostModel, "zai") || modelMatchesHost(hostModel, "zhipu");
	const isKimiModel = isKimiModelId(spec.id);
	const isMoonshotNative = modelMatchesHost(hostModel, "moonshotNative");
	const isMoonshotKimi = isKimiModel && isMoonshotNative;
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isMimoModel = isMimoModelIdOrName(spec.id) || isMimoModelIdOrName(name);
	// DeepSeek V4 (and other reasoning-capable DeepSeek models) reject follow-up requests in
	// thinking mode unless prior assistant tool-call turns include `reasoning_content`. The
	// upstream model is reachable through many OpenAI-compat hosts (api.deepseek.com, Deepinfra,
	// Kilo, NVIDIA NIM, Zenmux, OpenRouter, …), so we match by model id/name as well as by
	// provider/baseUrl. The flag is gated by `spec.reasoning` because the invariant only
	// applies when thinking mode is actually engaged.
	const isDeepseekFamily =
		modelMatchesHost(hostModel, "deepseekFamily") ||
		isDeepseekModelIdOrName(spec.id) ||
		isDeepseekModelIdOrName(name) ||
		isOpenCodeDeepseekAlias(provider, spec.id, name);
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	return {
		reasoning,
		isCerebras: modelMatchesHost(hostModel, "cerebras"),
		isZaiFamily,
		supportsZaiReasoningEffort: isZaiFamily && isGlm52ReasoningEffortModelId(spec.id),
		isKilo: modelMatchesHost(hostModel, "kilo"),
		isKimiModel,
		isMoonshotNative,
		isMoonshotKimi,
		requiresEnabledThinking: isMoonshotKimi && matchesKimiK27CodeFamily(spec),
		usesMoonshotKimiPreservedThinking: isMoonshotKimi && isKimiK26ModelId(spec.id),
		isAnthropicModel:
			modelMatchesHost(hostModel, "anthropic") || isClaudeModelId(spec.id) || isAnthropicNamespacedModelId(spec.id),
		isAlibaba: modelMatchesHost(hostModel, "alibabaDashscope"),
		isNvidiaNim: modelMatchesHost(hostModel, "nvidia"),
		isQwen: isQwenModelId(spec.id),
		isXiaomiHost,
		isXiaomiMimo: isXiaomiHost && isMimoModel,
		isMimoReasoningEffortModel: !isXiaomiHost && isMimoModel,
		isDeepseekFamily,
		hasDeepseekUrl: hostMatchesUrl(baseUrl, "deepseekFamily"),
		isDirectDeepseekApi,
		isDirectDeepseekReasoning: isDirectDeepseekApi && isDeepseekFamily && reasoning,
		isGrok: modelMatchesHost(hostModel, "xai"),
		isMistral: modelMatchesHost(hostModel, "mistral"),
		isOpenCodeHost: modelMatchesHost(hostModel, "opencode"),
		isOpenCodeProvider: provider === "opencode-go" || provider === "opencode-zen",
		isLocalBackend: isLocalOpenAICompatEndpoint(provider, baseUrl),
		isOpenAIHost: modelMatchesHost(hostModel, "openai"),
		isAzureHost: modelMatchesHost(hostModel, "azureOpenAI"),
		isOpenRouter: modelMatchesHost(hostModel, "openrouter"),
		isHuggingfaceRouter: modelMatchesHost(hostModel, "huggingfaceRouter"),
		isVercelGateway: modelMatchesHost(hostModel, "vercelAIGateway"),
		isTogether: modelMatchesHost(hostModel, "together"),
		isFireworks: hostMatchesUrl(baseUrl, "fireworks"),
		isChutes: hostMatchesUrl(baseUrl, "chutes"),
		isGroqHost: modelMatchesHost(hostModel, "groq"),
		isCopilotHost: provider === "github-copilot",
		isZenmuxHost: provider === "zenmux",
		isMiniMaxHost: modelMatchesHost(hostModel, "minimax"),
		isQwenPortal: modelMatchesHost(hostModel, "qwenPortal"),
	};
}

/**
 * OpenCode Zen's `big-pickle` is a DeepSeek reasoning alias; the upstream
 * 400s come from DeepSeek and require exact reasoning_content replay.
 */
function isOpenCodeDeepseekAlias(provider: string, id: string, name: string): boolean {
	return provider === "opencode-zen" && (id.toLowerCase() === "big-pickle" || name.toLowerCase() === "big pickle");
}

/** Hosts that reject OpenAI's `store` flag. */
function isNonStandardChatHost(t: ChatCompatTraits): boolean {
	return (
		t.isCerebras ||
		t.isGrok ||
		t.isMistral ||
		t.isChutes ||
		t.hasDeepseekUrl ||
		t.isFireworks ||
		t.isAlibaba ||
		t.isZaiFamily ||
		t.isKilo ||
		t.isQwen ||
		t.isXiaomiHost ||
		t.isMoonshotNative ||
		t.isOpenCodeHost
	);
}

/** Hosts that take the legacy `max_tokens` field instead of `max_completion_tokens`. */
function usesMaxTokensField(t: ChatCompatTraits): boolean {
	return t.isMistral || t.isMoonshotNative || t.isZaiFamily || t.isChutes || t.isFireworks || t.isDirectDeepseekApi;
}

/**
 * Hosts whose chat-completions endpoints are known to accept multiple
 * leading `system`/`developer` messages (preferred for KV-cache reuse).
 * Anything outside this allowlist defaults to coalescing because
 * strict chat templates (Qwen 3.5+ via vLLM, MiniMax, etc.) reject
 * follow-up system messages with a 400.
 *
 * Endpoints/models that MUST receive a single system block: MiniMax's OpenAI
 * endpoint returns error 2013 on multiple system messages; the Qwen 3.5+ chat
 * template raises "System message must be at the beginning" / 500s with an
 * internal_server_error when any system block appears past index 0. That
 * template ships with the weights, so every Qwen-serving vLLM/SGLang host
 * hits it — confirmed on Alibaba Dashscope, Qwen Portal, and Fireworks
 * (`fireworks/qwen3.7-plus` 500'd on two leading system blocks). Gate on the
 * Qwen family itself, not per-host: coalescing only trades away KV-cache reuse.
 */
function supportsMultipleSystemMessagesByDefault(t: ChatCompatTraits): boolean {
	if (t.isMiniMaxHost || t.isAlibaba || t.isQwenPortal || t.isQwen) return false;
	return (
		t.isOpenAIHost ||
		t.isAzureHost ||
		t.isOpenRouter ||
		t.isCerebras ||
		t.isTogether ||
		t.isFireworks ||
		t.isGroqHost ||
		t.isDeepseekFamily ||
		t.isMistral ||
		t.isGrok ||
		t.isZaiFamily ||
		t.isCopilotHost ||
		t.isZenmuxHost
	);
}

/**
 * Stream-watchdog floor: GLM coding-plan SKUs, Kimi K2.6, direct
 * DeepSeek reasoning models, and local OpenAI-compatible backends can idle
 * for minutes while reasoning or cold-loading weights; widen the idle
 * timeout so warm-ups stop aborting and retrying.
 */
function chatStreamIdleTimeoutMs(spec: ModelSpec<"openai-completions">, t: ChatCompatTraits): number | undefined {
	if (t.isZaiFamily && GLM_CODING_PLAN_MODEL_PATTERN.test(spec.id)) return GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS;
	if (spec.provider === "alibaba-coding-plan") return ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS;
	if (t.isXiaomiMimo) return XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS;
	if (t.reasoning && isKimiK26ModelId(spec.id)) return KIMI_K26_REASONING_STREAM_IDLE_TIMEOUT_MS;
	if (t.reasoning && t.isDirectDeepseekApi) return DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS;
	if (t.isLocalBackend) return LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS;
	return undefined;
}

/**
 * Fireworks "Fast" variants (`<id>-fast`) are served from the router
 * namespace (`accounts/fireworks/routers/<id>-fast`), like Fire Pass, rather
 * than the `models/` namespace the rest of the `fireworks` provider uses.
 */
function chatWireModelIdMode(
	spec: ModelSpec<"openai-completions">,
	t: ChatCompatTraits,
): ResolvedOpenAISharedCompat["wireModelIdMode"] {
	if (spec.provider === "firepass") return "firepass";
	if (spec.provider === "fireworks") return isFireworksFastModelId(spec.id) ? "firepass" : "fireworks";
	return t.isOpenRouter ? "openrouter" : "raw";
}

/**
 * Only Kimi's native hosts (Moonshot / Kimi-code, matched by `isMoonshotKimi`)
 * speak the z.ai binary `thinking: { type }` field. Kimi reached through
 * OpenAI-compatible proxies — Fireworks' Fire Pass router, OpenCode's gateway,
 * etc. — drives reasoning via OpenAI-style `reasoning_effort`
 * (low|medium|high|xhigh|max|none), so those stay on the "openai" path.
 * NVIDIA NIM hosts Qwen with the vLLM convention
 * (`chat_template_kwargs.enable_thinking`); top-level `enable_thinking`
 * is rejected by NIM's `additionalProperties: false` request schema
 * (issue #2299).
 */
function chatThinkingFormat(t: ChatCompatTraits): ResolvedOpenAISharedCompat["thinkingFormat"] {
	if (t.isZaiFamily || t.isMoonshotKimi || t.isXiaomiMimo) return "zai";
	if (t.isOpenRouter) return "openrouter";
	if (t.isQwen && t.isNvidiaNim) return "qwen-chat-template";
	if (t.isQwen && t.isFireworks) return "openai";
	if (t.isAlibaba || t.isQwen) return "qwen";
	return "openai";
}

/**
 * DeepSeek-family upstreams reached through the HF Inference Providers router
 * reject a bare OpenAI `reasoning_effort` (400 "thinking mode openai_effort is
 * not supported") — only the direct DeepSeek API (which pairs it with
 * `thinking: {type: "enabled"}`, see `extraBody`) and translating gateways like
 * OpenRouter accept an effort knob for these models.
 */
function chatSupportsReasoningEffort(t: ChatCompatTraits): boolean {
	if (t.isGrok || t.isXiaomiMimo) return false;
	if (t.isDeepseekFamily && t.isHuggingfaceRouter) return false;
	return !t.isZaiFamily || t.supportsZaiReasoningEffort;
}

/**
 * Backends that 400 follow-up requests when prior assistant tool-call turns lack `reasoning_content`:
 *   - Kimi: documented invariant on its native API.
 *   - DeepSeek-family reasoning models, including aliased OpenCode Zen models
 *     like `big-pickle`, validate exact thinking-mode replay.
 *   - Xiaomi MiMo models require exact `reasoning_content` replay on
 *     thinking-mode tool-call continuations across standard and Token Plan hosts.
 *   - Any reasoning-capable model reached through OpenRouter can enforce this
 *     server-side whenever the request is in thinking mode. We can't translate
 *     Anthropic's redacted/encrypted reasoning into provider-native plaintext,
 *     so cross-provider continuations rely on a placeholder.
 * OpenCode Kimi aliases handle reasoning content internally and reject
 * client-sent `reasoning_content`, so exclude only that Kimi-on-OpenCode path
 * (the `whenThinking` policy re-enables the replay for thinking turns).
 */
function chatRequiresReasoningContentForToolCalls(t: ChatCompatTraits): boolean {
	if (t.isKimiModel && !t.isOpenCodeProvider) return true;
	if (t.isXiaomiMimo) return true;
	return t.reasoning && (t.isDeepseekFamily || t.isOpenRouter);
}

/** Build the detected chat-completions record before spec overrides are applied. */
function detectChatCompat(spec: ModelSpec<"openai-completions">, t: ChatCompatTraits): ResolvedOpenAICompat {
	const { provider, baseUrl } = spec;
	const thinkingFormat = chatThinkingFormat(t);
	const deepseekReasoning = t.isDeepseekFamily && t.reasoning;
	return {
		supportsStore: !isNonStandardChatHost(t),
		// `developer` is an OpenAI-Responses-era extension to the chat-completions schema. Almost
		// every OpenAI-compatible host other than OpenAI itself (and Azure OpenAI, which mirrors
		// the schema exactly) treats it as an unknown role: Moonshot returns a 400 "tokenization
		// failed", Groq/Cerebras/etc. error or silently misroute. Default to `system` and require
		// callers to opt in via `compat.supportsDeveloperRole: true` for hosts known to mirror
		// OpenAI's reasoning-API surface.
		supportsDeveloperRole: t.isOpenAIHost || t.isAzureHost,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesByDefault(t),
		supportsReasoningEffort: chatSupportsReasoningEffort(t),
		// GitHub Copilot's chat-completions endpoint rejects reasoning params wholesale.
		supportsReasoningParams: provider !== "github-copilot",
		reasoningEffortMap: t.isMimoReasoningEffortModel ? MIMO_REASONING_EFFORT_MAP : {},
		supportsUsageInStreaming: !t.isCerebras,
		// pi-ai's thinking-loop guard is gemini-only; default the flag from the
		// family classifier so OpenAI-compat proxies serving Gemini are covered.
		// An opaque alias can opt in via `compat.enableGeminiThinkingLoopGuard`.
		enableGeminiThinkingLoopGuard: modelFamilyToken(spec.id) === "gemini",
		// Kimi (including via OpenRouter and Fireworks router-form IDs such as
		// `accounts/fireworks/routers/kimi-*`) calculates TPM rate limits based on
		// max_tokens, not actual output. The official Kimi K2 model guidance
		// (https://docs.fireworks.ai/models/kimi-k2) also requires `max_tokens` for
		// every call since the family can otherwise emit very long reasoning traces
		// before the final answer.
		alwaysSendMaxTokens: t.isKimiModel,
		disableReasoningOnForcedToolChoice: t.isKimiModel || t.isAnthropicModel,
		disableReasoningOnToolChoice: deepseekReasoning && !t.isOpenRouter,
		// OpenCode's gateways reject every `tool_choice` value but `"auto"`:
		// `[invalid_request_error] only '"auto"' is supported for 'tool_choice'.
		// '"none"', '"required"', and named function choices are not currently
		// supported`. Omitting the field is what `"auto"` means on an
		// OpenAI-compatible endpoint, so dropping it costs nothing and is the only
		// setting that covers all three rejected forms at once. Reported against
		// the guided goal, which pins its `respond` tool by name and so 400ed on
		// every interview turn; `"none"` reaches the same upstream from a
		// side-channel turn. `isOpenCodeHost` covers the provider ids and the
		// `opencode.ai` URL marker, so a custom provider pointed at the gateway
		// answers the same way.
		supportsToolChoice: !t.isDirectDeepseekReasoning && !t.isOpenCodeHost,
		supportsForcedToolChoice: !t.requiresEnabledThinking,
		supportsNamedToolChoice: provider !== "llama.cpp",
		maxTokensField: usesMaxTokensField(t) ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: t.isMistral,
		requiresAssistantAfterToolResult: t.isMistral,
		requiresThinkingAsText: t.isMistral,
		requiresMistralToolIds: t.isMistral,
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: t.isOpenRouter && t.isAnthropicModel,
		thinkingKeep: t.usesMoonshotKimiPreservedThinking ? "all" : undefined,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls: chatRequiresReasoningContentForToolCalls(t),
		requiresReasoningContentForAllAssistantTurns: (deepseekReasoning || t.isXiaomiMimo) && !t.isOpenRouter,
		// DeepSeek V4 and Xiaomi MiMo reject synthetic reasoning_content placeholders (".") on tool-call turns.
		// Kimi and OpenRouter accept them when actual reasoning is unavailable.
		allowsSyntheticReasoningContentForToolCalls: !deepseekReasoning && !t.isXiaomiMimo,
		// Local llama.cpp-style servers re-tokenize the entire chat-template
		// prompt each request; Qwen3 / DeepSeek-R1 / GLM templates reconstruct
		// the prior assistant turn's `<think>` block from `reasoning_content`,
		// so dropping the field re-renders the assistant turn without thinking
		// content and forces full prompt re-processing (#3528). The
		// `requires*ReasoningContent*` flags above stay off for these hosts —
		// they accept but don't validate the field — so the encoder needs a
		// distinct opt-in to replay on every reasoning turn. NOT gated on
		// `spec.reasoning`: the runtime discovery paths for `llama.cpp` /
		// `lm-studio` / `openai-models-list` hardcode `reasoning: false`
		// because the upstream `/models` endpoints don't advertise the
		// capability, but the OpenAI stream parser still records incoming
		// `reasoning_content` deltas as thinking blocks. Gating on the spec
		// flag would leave every discovered local Qwen / DeepSeek model
		// re-triggering #3528. The encoder only writes `reasoning_content`
		// when a thinking block actually exists on the turn
		// (`nonEmptyThinkingBlocks.length > 0`), so the flag is a no-op on
		// pure-text histories.
		replayReasoningContent: t.isLocalBackend,
		// `preserve_thinking: true` makes the Qwen3.6+ chat template render
		// `<think>...</think>` for older assistant turns too, instead of
		// stripping it the moment a new user message moves them past
		// `last_query_index`. Without it, the slot's KV cache (which holds the
		// raw `<think>X</think>` tokens emitted during generation) diverges
		// from the next-turn render and llama.cpp falls back to full prompt
		// re-processing — the exact symptom reported in #3541. Auto-enabled
		// for Qwen thinking dialects on local llama.cpp-style backends (paired
		// with `replayReasoningContent` above). Non-Qwen templates ignore the
		// parameter, so the flag stays a no-op outside the Qwen path.
		qwenPreserveThinking: (thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") && t.isLocalBackend,
		requiresAssistantContentForToolCalls: t.isKimiModel || t.isDirectDeepseekReasoning,
		// `isAnthropicModel`, not a raw `anthropic/` prefix test. The prefix test
		// dropped caching entirely for the `~anthropic/claude-*-latest` alias rows:
		// the tilde sorts them to the top of the picker, so they are the likeliest
		// Claude-on-OpenRouter selection, and `startsWith("anthropic/")` is false
		// for every one of them. With `cacheControlFormat` undefined,
		// `maybeAddAnthropicCacheControl` returns before writing a breakpoint and
		// every turn is a full uncached prefill of the whole conversation.
		cacheControlFormat: t.isOpenRouter && t.isAnthropicModel ? "anthropic" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: t.isOpenRouter,
		routedUpstreamSelfCaps: t.isOpenRouter || t.isHuggingfaceRouter,
		wireModelIdMode: chatWireModelIdMode(spec, t),
		isVercelGatewayHost: t.isVercelGateway,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl),
		extraBody: t.isDirectDeepseekReasoning ? { thinking: { type: "enabled" } } : undefined,
		toolStrictMode: t.isCerebras ? "all_strict" : "mixed",
		toolSchemaFlavor: t.isMoonshotNative ? "moonshot-mfjs" : undefined,
		streamIdleTimeoutMs: chatStreamIdleTimeoutMs(spec, t),
		stripDeepseekSpecialTokens:
			isDeepseekModelIdOrName(spec.id) && (provider === "nvidia" || provider === "deepseek"),
		streamMarkupHealingPattern: detectStreamMarkupHealingPattern(provider, spec.id, baseUrl),
		reasoningDeltasMayBeCumulative:
			MINIMAX_PROVIDER_OR_ID_PATTERN.test(provider) || MINIMAX_PROVIDER_OR_ID_PATTERN.test(spec.id),
		emptyLengthFinishIsContextError: provider === "ollama",
		usesOpenAIToolCallIdLimit: provider === "openai",
		promptCacheSessionHeader: t.isGrok ? "x-grok-conv-id" : undefined,
		dropThinkingWhenReasoningEffort: provider === "fireworks",
	};
}

/**
 * Assign sparse overrides onto a detected record in place, then re-derive the
 * two fields that follow from overridable ones unless the overrides set them:
 * `reasoningDisableMode` from the final `thinkingFormat` (`"omit"` when the
 * model requires enabled thinking), and `omitReasoningEffort` from the final
 * `supportsReasoningEffort`.
 */
function applyOverridesAndRederive(
	compat: ResolvedOpenAISharedCompat,
	overrides: Partial<Omit<OpenAICompat, "whenThinking">> | undefined,
	requiresEnabledThinking: boolean,
): void {
	applyCompatOverrides(compat, overrides);
	if (overrides?.reasoningDisableMode === undefined) {
		compat.reasoningDisableMode = requiresEnabledThinking
			? "omit"
			: resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (overrides?.omitReasoningEffort === undefined && !compat.supportsReasoningEffort) {
		compat.omitReasoningEffort = true;
	}
}

/**
 * Build the resolved chat-completions compat record for a model spec:
 * classify, detect, apply the spec's overrides, and materialize the
 * `whenThinking` alternate view when a policy applies.
 */
export function buildOpenAICompat(spec: ModelSpec<"openai-completions">): ResolvedOpenAICompat {
	const traits = detectChatCompatTraits(spec);
	const compat = detectChatCompat(spec, traits);
	applyOverridesAndRederive(compat, spec.compat, traits.requiresEnabledThinking);
	mergeMimoReasoningEffortMap(compat, traits.isMimoReasoningEffortModel);

	const whenThinkingPolicy =
		spec.compat?.whenThinking ?? (traits.isOpenCodeProvider && spec.reasoning ? OPENCODE_WHEN_THINKING : undefined);
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat };
		applyOverridesAndRederive(variant, whenThinkingPolicy, false);
		mergeMimoReasoningEffortMap(variant, traits.isMimoReasoningEffortModel);
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

/**
 * Build the resolved Responses-API compat record. Most shared OpenAI-compatible
 * capability defaults intentionally mirror chat-completions, while Responses-
 * only behavior (developer role, prompt cache, pairing strictness, image detail)
 * keeps endpoint-specific detection. Azure is detected by provider id as well
 * as URL — bundled `azure` models carry no baseUrl (the deployment host is per-
 * resource, resolved at runtime) — while OpenAI/Copilot developer-role and
 * prompt-cache detection stay URL-keyed, as the historical call sites were.
 */
export function buildOpenAIResponsesCompat(spec: OpenAIResponsesSpecLike): ResolvedOpenAIResponsesCompat {
	const baseUrl = spec.baseUrl ?? "";
	const isAzure = modelMatchesHost({ provider: spec.provider, baseUrl }, "azureOpenAI");
	const isCodexBackend = modelMatchesHost({ provider: spec.provider, baseUrl }, "codexBackend");
	const isOpenRouter = modelMatchesHost({ provider: spec.provider, baseUrl }, "openrouter");
	const isHuggingfaceRouter = modelMatchesHost({ provider: spec.provider, baseUrl }, "huggingfaceRouter");
	const isOpenCodeHost = modelMatchesHost({ provider: spec.provider, baseUrl }, "opencode");
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
		// Azure OpenAI and GitHub Copilot Responses paths require tool results
		// to strictly match prior tool calls when building Responses inputs.
		strictResponsesPairing: isAzure || spec.provider === "github-copilot",
		// GitHub Copilot and xAI OAuth reject `detail: "original"` (400 / 422).
		// Every other host preserves native-resolution images (the `original`
		// detail hint). Detect Copilot by provider id or base-URL host so a
		// model pointed at the Copilot host under a different provider id still
		// clamps; xai-oauth is provider-id only (same host family as paid `xai`).
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
		// The OpenCode gateways accept only `"auto"`, on this endpoint as much as on
		// chat-completions, and the reported failure came through here: the bundle
		// routes `muse-spark-1.3-contributor` to `/responses`. See the matching
		// comment in `buildOpenAICompat` for the upstream's own wording.
		supportsToolChoice: !isOpenCodeHost,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls:
			(isKimiModel || (isDeepseekFamily && reasoningCapable) || (isOpenRouter && reasoningCapable)) &&
			reasoningCapable,
		requiresReasoningContentForAllAssistantTurns: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseekFamily || !reasoningCapable,
		// The Responses API replays reasoning through encrypted `summary` items,
		// not via a top-level `reasoning_content` field — this flag is
		// chat-completions-only.
		replayReasoningContent: false,
		// Responses-only; the Qwen `preserve_thinking` template knob lives on
		// the chat-completions wire shape, never on Responses.
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
		// `isOpenAIUrl || provider === "openai"` sent this to any host a caller
		// re-pointed an `openai` model at, because the provider clause defeats the
		// endpoint test it is ORed with. It cannot simply be dropped either:
		// `isOpenAIUrl` is false for an UNSET baseUrl, which is the default for every
		// first-party OpenAI row. `isOfficialOpenAIEndpoint` is the pair of claims
		// actually meant here, unset-means-official and a re-pointed host means not.
		supportsObfuscationOptOut: isOfficialOpenAIEndpoint(spec.provider, baseUrl),
		// Server-side compaction is documented as `POST /responses/compact` for
		// the official OpenAI API (Compaction guide) and for Azure OpenAI's v1
		// API (Microsoft Learn,
		// `{resource}.openai.azure.com/openai/v1/responses/compact`). The
		// ChatGPT Codex backend serves no compact route — that path answers 404
		// — and compacts through a streaming `{base}/codex/responses` request
		// whose last input item is `compaction_trigger`, declared
		// `responses_compaction_v2`; the route and the declaration are one
		// decision, pinned by
		// `packages/agent/test/the-codex-compaction-wire-does-not-regress.test.ts`.
		// The host is admitted here because the window is still the client's to
		// store and replay. A compatible gateway opts in with a
		// `supportsServerCompaction` override.
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
	applyOverridesAndRederive(compat, spec.compat, false);
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
