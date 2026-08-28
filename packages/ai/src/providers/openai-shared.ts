import type { Effort } from "@veyyon/catalog/effort";
import { toFirepassWireModelId, toFireworksWireModelId } from "@veyyon/catalog/fireworks-model-id";
import { isGlm52ReasoningEffortModelId } from "@veyyon/catalog/identity";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { scaleUsageCost } from "@veyyon/catalog/models";
import type {
	OpenAICompat,
	OpenAIReasoningDisableMode,
	OpenAIStreamMarkupHealingPattern,
	OpenRouterRouting,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	VercelGatewayRouting,
} from "@veyyon/catalog/types";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
} from "@veyyon/catalog/wire/coreweave";
import { parseGitHubCopilotApiKey } from "@veyyon/catalog/wire/github-copilot";
import { $env } from "@veyyon/utils/env";
import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type Message,
	type MessageAttribution,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
	type ServiceTier,
	shouldSendServiceTier,
	type Tool,
	type Usage,
} from "../types";
import { resolveCacheRetention } from "../utils";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { getOpenRouterHeaders } from "../utils/openrouter-headers";
import { isForcedToolChoice } from "../utils/tool-choice";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import type { ChatCompletionCreateParamsStreaming } from "./openai-chat-wire";

export interface OpenAIModelIdentity {
	provider: string;
	id: string;
	baseUrl?: string;
}

export interface OpenAIStrictToolsScope {
	provider: string;
	baseUrl: string | undefined;
	modelId: string;
}

export interface OpenAIStrictToolsState {
	strictTools: {
		disabledModelScopes: Set<string>;
	};
}

export interface OpenAIRequestSetupModel extends OpenAIModelIdentity {
	headers?: Record<string, string>;
	premiumMultiplier?: number;
	compat?: Pick<ResolvedOpenAISharedCompat, "promptCacheSessionHeader">;
}

/** Cache identity controls shared by OpenAI-family transports. */
export interface OpenAICacheOptions {
	cacheRetention?: CacheRetention;
	sessionId?: string;
	promptCacheKey?: string;
}

export interface OpenAIRequestSetupOptions {
	apiKey?: string;
	extraHeaders?: Record<string, string>;
	initiatorOverride?: MessageAttribution;
	messages: Message[];
	defaultBaseUrl?: string;
	prependHeaders?: () => Record<string, string>;
	alibabaCodingPlanAuth?: boolean;
	azureChatCompletions?: {
		apiVersion: string;
		deploymentName: string;
	};
	openAISessionId?: string;
	promptCacheSessionId?: string;
}

export interface OpenAIRequestSetup {
	copilotPremiumRequests: number | undefined;
	baseUrl: string | undefined;
	headers: Record<string, string>;
	query: Record<string, string> | undefined;
	requestHeaders: Record<string, string>;
}

function normalizeSakanaRequestBaseUrl(baseUrl: string | undefined): string | undefined {
	const value = baseUrl?.trim();
	if (!value) return undefined;
	const normalized = trimTrailingSlashes(value);
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function resolveSakanaRequestBaseUrl(): string | undefined {
	return normalizeSakanaRequestBaseUrl($env.SAKANA_BASE_URL) ?? normalizeSakanaRequestBaseUrl($env.FUGU_BASE_URL);
}

function applyCoreWeaveProjectHeader(headers: Record<string, string>): void {
	removeBlankCoreWeaveProjectHeaders(headers);
	if (hasCoreWeaveProjectHeader(headers)) {
		return;
	}
	const projectHeaders = coreWeaveProjectHeaders($env);
	if (projectHeaders) {
		headers[COREWEAVE_PROJECT_HEADER] = projectHeaders[COREWEAVE_PROJECT_HEADER];
	}
}

function setHeaderIfAbsent(headers: Record<string, string>, name: string, value: string): void {
	const normalizedName = name.toLowerCase();
	for (const existingName in headers) {
		if (existingName.toLowerCase() === normalizedName) return;
	}
	headers[name] = value;
}

export function resolveOpenAIRequestSetup(
	model: OpenAIRequestSetupModel,
	options: OpenAIRequestSetupOptions,
): OpenAIRequestSetup {
	let apiKey = options.apiKey;
	if (!apiKey) {
		if (!$env.OPENAI_API_KEY) {
			throw new AIError.MissingApiKeyError(
				undefined,
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_API_KEY;
	}
	const rawApiKey = apiKey;
	let headers = { ...(model.headers ?? {}) };
	if (model.provider === "openrouter") {
		Object.assign(headers, getOpenRouterHeaders());
	}
	Object.assign(headers, options.extraHeaders);
	if (model.provider === "coreweave") {
		applyCoreWeaveProjectHeader(headers);
	}
	if (options.prependHeaders) {
		headers = { ...options.prependHeaders(), ...headers };
	}

	let copilotPremiumRequests: number | undefined;
	let baseUrl = model.baseUrl;
	if (model.provider === "moonshot") {
		// Bundled `moonshot` catalog models hardcode the international endpoint
		// (`api.moonshot.ai`). MOONSHOT_BASE_URL lets users redirect the provider
		// at the China platform (`api.moonshot.cn`), which only accepts China keys
		// and rejects the international host. (#2883)
		const moonshotBaseUrl = $env.MOONSHOT_BASE_URL?.trim();
		if (moonshotBaseUrl) {
			baseUrl = moonshotBaseUrl;
		}
	}
	if (model.provider === "sakana") {
		const sakanaBaseUrl = resolveSakanaRequestBaseUrl();
		if (sakanaBaseUrl) {
			baseUrl = sakanaBaseUrl;
		}
	}
	if (model.provider === "github-copilot") {
		apiKey = parseGitHubCopilotApiKey(rawApiKey).accessToken;
		const copilot = buildCopilotDynamicHeaders({
			messages: options.messages,
			hasImages: hasCopilotVisionInput(options.messages),
			premiumMultiplier: model.premiumMultiplier,
			headers,
			initiatorOverride: options.initiatorOverride,
		});
		Object.assign(headers, copilot.headers);
		copilotPremiumRequests = copilot.premiumRequests;
		baseUrl = resolveGitHubCopilotBaseUrl(model.baseUrl, rawApiKey) ?? model.baseUrl;
	}

	if (options.alibabaCodingPlanAuth && model.provider === "alibaba-coding-plan") {
		try {
			const parsed = JSON.parse(rawApiKey);
			if (typeof parsed?.token === "string") {
				apiKey = parsed.token;
			}
			if (typeof parsed?.enterpriseUrl === "string") {
				baseUrl = parsed.enterpriseUrl;
			}
		} catch {
			// Not JSON — use raw apiKey and catalog baseUrl.
		}
	}

	let query: Record<string, string> | undefined;
	if (options.azureChatCompletions && baseUrl?.includes(".openai.azure.com")) {
		if (!baseUrl.includes("/deployments/")) {
			baseUrl = `${baseUrl}/deployments/${options.azureChatCompletions.deploymentName}`;
		}
		query = { "api-version": options.azureChatCompletions.apiVersion };
	}

	if (options.openAISessionId && model.provider === "openai") {
		setHeaderIfAbsent(headers, "session_id", options.openAISessionId);
		setHeaderIfAbsent(headers, "x-client-request-id", options.openAISessionId);
	}
	if (options.promptCacheSessionId && model.compat?.promptCacheSessionHeader) {
		setHeaderIfAbsent(headers, model.compat.promptCacheSessionHeader, options.promptCacheSessionId);
	}

	if (options.defaultBaseUrl !== undefined) {
		baseUrl = baseUrl ?? ($env.OPENAI_BASE_URL?.trim() || options.defaultBaseUrl);
	}
	const requestHeaders = { ...headers };
	headers.Authorization ??= `Bearer ${apiKey}`;
	return { copilotPremiumRequests, baseUrl, headers, query, requestHeaders };
}

export function applyOpenAIServiceTier(
	params: { service_tier?: ServiceTier | null | undefined },
	serviceTier: ServiceTier | null | undefined,
	model: Pick<Model, "provider" | "api" | "id">,
): void {
	if (!shouldSendServiceTier(serviceTier, model)) return;
	if (serviceTier === "flex" || serviceTier === "scale" || serviceTier === "priority") {
		params.service_tier = serviceTier;
	}
}

/** Service-tier cost multipliers for OpenAI Responses. */
function getOpenAIResponsesServiceTierCostMultiplier(tier: string | null | undefined): number {
	switch (tier) {
		case "flex":
			return 0.5;
		case "priority":
			return 2;
		default:
			return 1;
	}
}

/** Adjust resolved cost by billed service tier. */
export function applyOpenAIResponsesServiceTierCost(
	model: Pick<Model, "provider">,
	usage: AssistantMessage["usage"],
	responseServiceTier: unknown,
	requestServiceTier: ServiceTier | null | undefined,
): void {
	if (model.provider !== "openai") return;
	// The response echo is authoritative; fall back to requested tier when omitted.
	const served = typeof responseServiceTier === "string" ? responseServiceTier : (requestServiceTier ?? undefined);
	const multiplier = getOpenAIResponsesServiceTierCostMultiplier(served);
	scaleUsageCost(usage, multiplier);
}

export interface OpenAIUsageAccountingInput {
	promptTokens: number;
	outputTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	cacheWriteOpenRouter: number | undefined;
	cacheWriteDeepSeek: number | undefined;
	hasDeepSeekCacheHitAndMiss: boolean;
}

export interface OpenAIUsageAccounting {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoningTokens?: number;
	orchestration?: Usage["orchestration"];
}

export function calculateOpenAIUsageAccounting(accounting: OpenAIUsageAccountingInput): OpenAIUsageAccounting {
	const cacheWriteTokens = accounting.cacheWriteOpenRouter ?? accounting.cacheWriteDeepSeek ?? 0;
	const isDeepSeekUsage =
		accounting.hasDeepSeekCacheHitAndMiss &&
		accounting.cacheWriteOpenRouter === undefined &&
		(accounting.cacheWriteDeepSeek ?? 0) > 0;
	const input = isDeepSeekUsage
		? Math.max(0, accounting.promptTokens - accounting.cachedTokens)
		: Math.max(0, accounting.promptTokens - accounting.cachedTokens - cacheWriteTokens);
	const cacheWrite = isDeepSeekUsage ? 0 : cacheWriteTokens;
	return {
		input,
		output: accounting.outputTokens,
		cacheRead: accounting.cachedTokens,
		cacheWrite,
		totalTokens: input + accounting.outputTokens + accounting.cachedTokens + cacheWrite,
		...(accounting.reasoningTokens > 0 ? { reasoningTokens: accounting.reasoningTokens } : {}),
	};
}

/** Normalize a cache identity to the wire limit accepted by OpenAI-family providers. */
export function normalizeOpenAIPromptCacheKey(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 64, "pc_");
}

export function normalizeOpenRouterResponsesSessionId(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 256, "session_");
}

/** Resolve a prompt-cache identity, falling back to the provider session unless caching is disabled. */
export function getOpenAIPromptCacheKey(options: OpenAICacheOptions | undefined): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
}

export function getOpenAIResponsesRoutingSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenAIPromptCacheKey(options?.sessionId);
}

export function getOpenRouterResponsesSessionId(
	options: Pick<OpenAICacheOptions, "cacheRetention" | "sessionId"> | undefined,
): string | undefined {
	if (resolveCacheRetention(options?.cacheRetention) === "none") return undefined;
	return normalizeOpenRouterResponsesSessionId(options?.sessionId);
}

export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function createOpenAIStrictToolsState(): OpenAIStrictToolsState {
	return {
		strictTools: {
			disabledModelScopes: new Set<string>(),
		},
	};
}

export function clearOpenAIStrictToolsState(state: OpenAIStrictToolsState): void {
	state.strictTools.disabledModelScopes.clear();
}

export function getOpenAIStrictToolsScope(
	model: OpenAIModelIdentity,
	resolvedBaseUrl: string | undefined,
): OpenAIStrictToolsScope {
	return {
		provider: model.provider,
		baseUrl: resolvedBaseUrl ?? model.baseUrl,
		modelId: model.id,
	};
}

export function isStrictToolsDisabledForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): boolean {
	if (!scope) return false;
	return (
		state?.strictTools.disabledModelScopes.has(`${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`) ?? false
	);
}

export function disableStrictToolsForScope(
	state: OpenAIStrictToolsState | undefined,
	scope: OpenAIStrictToolsScope | undefined,
): void {
	if (!scope) return;
	state?.strictTools.disabledModelScopes.add(`${scope.provider}:${scope.baseUrl ?? ""}:${scope.modelId}`);
}

export function isOpenRouterAnthropicModel(model: OpenAIModelIdentity): boolean {
	return model.provider === "openrouter" && model.id.toLowerCase().startsWith("anthropic/");
}

/** Append OpenRouter routing-variant suffix (e.g. `:nitro`) to model ID if not already present. */
export function applyOpenRouterRoutingVariant(modelId: string, variant: string | undefined): string {
	if (!variant) return modelId;
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	if (lastColon > lastSlash) return modelId;
	return `${modelId}:${variant}`;
}

export function applyWireModelIdTransform(
	baseId: string,
	mode: ResolvedOpenAISharedCompat["wireModelIdMode"],
	openrouterVariant?: string,
): string {
	switch (mode) {
		case "firepass":
			return toFirepassWireModelId(baseId);
		case "fireworks":
			return toFireworksWireModelId(baseId);
		case "openrouter":
			return applyOpenRouterRoutingVariant(baseId, openrouterVariant);
		default:
			return baseId;
	}
}

export interface OpenAIOutputTokenParam {
	field: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
	value: number;
}

export interface ResolveOpenAIOutputTokenInput {
	/** Wire field the endpoint expects for the output cap. */
	field: OpenAIOutputTokenParam["field"];
	/** Caller-supplied output cap (model-defaulted by `stream.ts`, or null/undefined on direct provider calls). */
	maxTokens: number | null | undefined;
	/** Whether the caller explicitly set `maxTokens` (routing omission only applies when false). */
	maxTokensExplicit: boolean;
	/** Model output cap (`model.maxTokens`). */
	modelMaxTokens: number | null | undefined;
	/** Drop the field entirely — proxies with unknown upstream caps (Ollama via `model.omitMaxOutputTokens`). */
	omitMaxOutputTokens: boolean;
	/** The model sits behind a multi-upstream router (OpenRouter, HF Inference router); catalog default caps are omitted so each upstream self-caps. */
	routedUpstreamSelfCaps: boolean;
	/** Endpoint always needs a cap (Kimi-family TPM math); supplies the model default when the caller did not. */
	alwaysSendMaxTokens: boolean;
	/** Hard provider clamp; defaults to {@link OPENAI_MAX_OUTPUT_TOKENS}. */
	providerOutputClamp?: number;
}

/** Resolve output-token wire parameter shared by Chat Completions and Responses. */
export function resolveOpenAIOutputTokenParam(
	input: ResolveOpenAIOutputTokenInput,
): OpenAIOutputTokenParam | undefined {
	if (input.omitMaxOutputTokens) return undefined;
	const requested =
		input.maxTokens ?? (input.alwaysSendMaxTokens ? (input.modelMaxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined);
	if (requested === undefined) return undefined;
	if (input.routedUpstreamSelfCaps && !input.alwaysSendMaxTokens && !input.maxTokensExplicit) return undefined;
	const value = Math.min(
		requested,
		input.modelMaxTokens ?? Number.POSITIVE_INFINITY,
		input.providerOutputClamp ?? OPENAI_MAX_OUTPUT_TOKENS,
	);
	if (!(value > 0)) return undefined;
	return { field: input.field, value };
}

export interface OpenAIGatewayRoutingParams {
	provider?: OpenRouterRouting;
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
}

export interface OpenAIGatewayRoutingCompat {
	isOpenRouterHost: boolean;
	openRouterRouting?: OpenRouterRouting;
	isVercelGatewayHost?: boolean;
	vercelGatewayRouting?: VercelGatewayRouting;
}

/** Apply gateway routing preferences to the request body. */
export function applyOpenAIGatewayRouting(
	params: OpenAIGatewayRoutingParams,
	compat: OpenAIGatewayRoutingCompat,
): void {
	if (compat.isOpenRouterHost && compat.openRouterRouting) {
		params.provider = compat.openRouterRouting;
	}
	if (compat.isVercelGatewayHost && compat.vercelGatewayRouting) {
		const routing = compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: { only?: string[]; order?: string[] } = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
}

export interface OpenAIExtraBodyOptions {
	/**
	 * Fireworks rejects DeepSeek-style `thinking` toggles alongside OpenAI-style
	 * `reasoning_effort`; drop `thinking` when the effort field carries the level.
	 */
	dropThinkingWhenReasoningEffort?: boolean;
}

/** Merge extraBody blob into request params, dropping conflicting thinking toggle if effort is present. */
export function applyOpenAIExtraBody<P extends object>(
	params: P,
	extraBody: Record<string, unknown> | undefined,
	options?: OpenAIExtraBodyOptions,
): void {
	if (!extraBody) return;
	Object.assign(params, extraBody);
	if (options?.dropThinkingWhenReasoningEffort) {
		const shaped = params as { reasoning_effort?: unknown; thinking?: unknown };
		if (shaped.reasoning_effort !== undefined) {
			delete shaped.thinking;
		}
	}
}

/** Chat Completions streaming request body shaped by OpenAI-family providers. */
export type OpenAICompletionsParams = Omit<ChatCompletionCreateParamsStreaming, "reasoning_effort" | "service_tier"> & {
	top_k?: number;
	min_p?: number;
	repetition_penalty?: number;
	thinking?: { type: "enabled" | "disabled"; keep?: "all" };
	enable_thinking?: boolean;
	preserve_thinking?: boolean;
	chat_template_kwargs?: { enable_thinking?: boolean; preserve_thinking?: boolean };
	reasoning?: { effort?: string } | { enabled: false };
	reasoning_effort?: string | null;
	service_tier?: ServiceTier;
	tool_stream?: boolean;
	provider?: OpenAICompat["openRouterRouting"];
	providerOptions?: { gateway?: { only?: string[]; order?: string[] } };
};

/** Reasoning-relevant slice of caller options the Chat Completions dialect dispatch reads. */
export interface ChatCompletionsReasoningOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	disableReasoning?: boolean;
}

export type OpenAICompatEndpoint = "chat-completions" | "responses";

export type OpenAIReasoningDisableReason = "caller" | "forced-tool-choice" | "tool-choice" | "not-requested";

export type OpenAICompatPolicyCompat = ResolvedOpenAISharedCompat &
	Partial<ResolvedOpenAICompat> &
	Partial<ResolvedOpenAIResponsesCompat>;

export interface ResolveOpenAICompatPolicyOptions {
	endpoint: OpenAICompatEndpoint;
	compat?: OpenAICompatPolicyCompat;
	reasoning?: string;
	disableReasoning?: boolean;
	toolChoice?: unknown;
	strictResponsesPairing?: boolean;
	includeEncryptedReasoning?: boolean;
	filterReasoningHistory?: boolean;
	omitReasoningEffort?: boolean;
}

export interface OpenAICompatPolicy {
	endpoint: OpenAICompatEndpoint;
	compat: OpenAICompatPolicyCompat;
	reasoning: {
		modelSupported: boolean;
		supportsParams: boolean;
		requestedEffort?: string;
		wireEffort?: string;
		enabled: boolean;
		disabled: boolean;
		disableReason?: OpenAIReasoningDisableReason;
		dialect: ResolvedOpenAISharedCompat["thinkingFormat"];
		disableMode: OpenAIReasoningDisableMode;
		omitReasoningEffort: boolean;
		includeEncryptedReasoning: boolean;
		filterReasoningHistory: boolean;
		requiresReasoningContentForToolCalls: boolean;
		requiresReasoningContentForAllAssistantTurns: boolean;
		allowsSyntheticReasoningContentForToolCalls: boolean;
		reasoningContentField?: OpenAICompat["reasoningContentField"];
		requiresThinkingAsText: boolean;
	};
	tools: {
		strictResponsesPairing: boolean;
		toolCallIdKind: "default" | "openai-40" | "mistral-9-alnum";
	};
	messages: {
		systemRole: "system" | "developer";
		supportsDeveloperRole: boolean;
		supportsMultipleSystemMessages: boolean;
	};
	stream: {
		stripSpecialTokens: "deepseek" | false;
		markupHealingPattern?: OpenAIStreamMarkupHealingPattern;
		reasoningDeltasMayBeCumulative: boolean;
		emptyLengthFinishIsContextError: boolean;
	};
}

/** Map user-facing effort to provider wire value. */
export function mapOpenAIReasoningEffort(
	model: Pick<Model, "thinking">,
	compat: { reasoningEffortMap?: Partial<Record<Effort, string>> } | undefined,
	effort: string,
): string {
	const level = effort as Effort;
	return compat?.reasoningEffortMap?.[level] ?? model.thinking?.effortMap?.[level] ?? effort;
}

function isImplicitDisableWhenNotRequested(disableMode: OpenAIReasoningDisableMode): boolean {
	return (
		disableMode === "zai-thinking-disabled" ||
		disableMode === "qwen-enable-thinking-false" ||
		disableMode === "qwen-template-false"
	);
}

export function resolveOpenAICompatPolicy<TApi extends Api>(
	model: Model<TApi>,
	options: ResolveOpenAICompatPolicyOptions,
): OpenAICompatPolicy {
	const baseCompat = (options.compat ?? model.compat) as OpenAICompatPolicyCompat;
	const requestedEffort = options.reasoning;
	const modelSupported = Boolean(model.reasoning);
	const forcedToolChoiceSuppressesReasoning =
		baseCompat.disableReasoningOnForcedToolChoice &&
		baseCompat.supportsForcedToolChoice &&
		isForcedToolChoice(options.toolChoice);
	const anyToolChoiceSuppressesReasoning =
		!forcedToolChoiceSuppressesReasoning &&
		baseCompat.disableReasoningOnToolChoice &&
		options.toolChoice !== undefined;
	const requestedAndAllowed = requestedEffort !== undefined && !options.disableReasoning && modelSupported;
	const conflictDisableReason: OpenAIReasoningDisableReason | undefined = forcedToolChoiceSuppressesReasoning
		? "forced-tool-choice"
		: anyToolChoiceSuppressesReasoning
			? "tool-choice"
			: undefined;
	const disableReason: OpenAIReasoningDisableReason | undefined = options.disableReasoning
		? "caller"
		: conflictDisableReason;
	const enabledBeforeThinkingVariant = requestedAndAllowed && disableReason === undefined;
	const baseWireEffort =
		enabledBeforeThinkingVariant && requestedEffort !== undefined
			? mapOpenAIReasoningEffort(model, baseCompat, requestedEffort)
			: undefined;
	const disabledByNoneEffort =
		enabledBeforeThinkingVariant &&
		baseCompat.reasoningDisableMode === "zai-thinking-disabled" &&
		baseWireEffort === "none";
	const enabled = enabledBeforeThinkingVariant && !disabledByNoneEffort;
	const compat =
		enabled && baseCompat.whenThinking ? (baseCompat.whenThinking as OpenAICompatPolicyCompat) : baseCompat;
	const omitReasoningEffort =
		options.omitReasoningEffort ?? (compat.omitReasoningEffort || !compat.supportsReasoningEffort);
	const disableMode = compat.reasoningDisableMode;
	let wireEffort =
		enabled && requestedEffort !== undefined ? mapOpenAIReasoningEffort(model, compat, requestedEffort) : undefined;
	const disabledWithoutRequest =
		modelSupported &&
		requestedEffort === undefined &&
		!options.disableReasoning &&
		isImplicitDisableWhenNotRequested(disableMode);
	const disabled =
		(modelSupported && disableReason === "caller") ||
		conflictDisableReason !== undefined ||
		(modelSupported && disabledWithoutRequest) ||
		disabledByNoneEffort;
	if (
		disabled &&
		disableReason === "caller" &&
		requestedEffort === undefined &&
		disableMode === "lowest-effort" &&
		compat.supportsReasoningEffort &&
		!omitReasoningEffort
	) {
		// Use lowest effort tier when model cannot disable reasoning directly.
		const minEffort = getSupportedEfforts(model)[0];
		wireEffort = minEffort === undefined ? undefined : mapOpenAIReasoningEffort(model, compat, minEffort);
	}

	return {
		endpoint: options.endpoint,
		compat,
		reasoning: {
			modelSupported,
			supportsParams: compat.supportsReasoningParams,
			requestedEffort,
			wireEffort,
			enabled,
			disabled,
			disableReason: disableReason ?? (disabledWithoutRequest || disabledByNoneEffort ? "not-requested" : undefined),
			dialect: compat.thinkingFormat,
			requiresReasoningContentForToolCalls: compat.requiresReasoningContentForToolCalls,
			requiresReasoningContentForAllAssistantTurns: compat.requiresReasoningContentForAllAssistantTurns,
			allowsSyntheticReasoningContentForToolCalls: compat.allowsSyntheticReasoningContentForToolCalls,
			reasoningContentField: compat.reasoningContentField,
			requiresThinkingAsText: compat.requiresThinkingAsText,
			disableMode,
			omitReasoningEffort,
			includeEncryptedReasoning: options.includeEncryptedReasoning ?? compat.includeEncryptedReasoning,
			filterReasoningHistory: options.filterReasoningHistory ?? compat.filterReasoningHistory,
		},
		tools: {
			strictResponsesPairing: options.strictResponsesPairing ?? compat.strictResponsesPairing ?? false,
			toolCallIdKind: compat.requiresMistralToolIds
				? "mistral-9-alnum"
				: compat.usesOpenAIToolCallIdLimit
					? "openai-40"
					: "default",
		},
		messages: {
			systemRole: modelSupported && compat.supportsDeveloperRole ? "developer" : "system",
			supportsDeveloperRole: compat.supportsDeveloperRole,
			supportsMultipleSystemMessages: compat.supportsMultipleSystemMessages ?? true,
		},
		stream: {
			stripSpecialTokens: compat.stripDeepseekSpecialTokens ? "deepseek" : false,
			markupHealingPattern: compat.streamMarkupHealingPattern,
			reasoningDeltasMayBeCumulative: compat.reasoningDeltasMayBeCumulative,
			emptyLengthFinishIsContextError: compat.emptyLengthFinishIsContextError,
		},
	};
}

function encodeChatCompletionsDisabledReasoning(
	params: OpenAICompletionsParams,
	disableMode: OpenAIReasoningDisableMode,
): void {
	delete params.reasoning_effort;
	switch (disableMode) {
		case "zai-thinking-disabled":
			params.thinking = { type: "disabled" };
			break;
		case "qwen-enable-thinking-false":
			params.enable_thinking = false;
			break;
		case "qwen-template-false":
			params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: false };
			break;
		case "openrouter-enabled-false":
			(params as typeof params & { reasoning?: { effort?: string } | { enabled: false } }).reasoning = {
				enabled: false,
			};
			break;
		default:
			delete params.reasoning;
			break;
	}
}

export function applyChatCompletionsCompatPolicy(params: OpenAICompletionsParams, policy: OpenAICompatPolicy): void {
	// Emit preserve_thinking for Qwen models to preserve thinking in older turns.
	if (policy.compat.qwenPreserveThinking) {
		// Dialect split: top-level field for qwen, chat_template_kwargs for qwen-chat-template.
		if (policy.compat.thinkingFormat === "qwen") {
			params.preserve_thinking = true;
		}
		params.chat_template_kwargs = { ...params.chat_template_kwargs, preserve_thinking: true };
	}

	const reasoning = policy.reasoning;
	if ((!reasoning.modelSupported && !reasoning.disabled) || !reasoning.supportsParams) return;
	if (reasoning.enabled) {
		switch (reasoning.disableMode) {
			case "zai-thinking-disabled":
				if (reasoning.wireEffort === "none") {
					encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
					return;
				}
				params.thinking = { type: "enabled" };
				if (policy.compat.thinkingKeep) params.thinking.keep = policy.compat.thinkingKeep;
				if (policy.compat.supportsReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
			case "qwen-enable-thinking-false":
				params.enable_thinking = true;
				break;
			case "qwen-template-false":
				// Spread so the `preserve_thinking` kwarg hoisted above
				// survives the merge — a bare `{ enable_thinking: true }`
				// would clobber it.
				params.chat_template_kwargs = { ...params.chat_template_kwargs, enable_thinking: true };
				break;
			case "openrouter-enabled-false":
				if (reasoning.wireEffort !== undefined) {
					(params as typeof params & { reasoning?: { effort?: string } }).reasoning = {
						effort: reasoning.wireEffort,
					};
				}
				break;
			default:
				if (!reasoning.omitReasoningEffort && reasoning.wireEffort !== undefined) {
					params.reasoning_effort = reasoning.wireEffort as Effort;
				}
				break;
		}
		return;
	}
	if (!reasoning.disabled) return;
	if (
		reasoning.disableReason === "caller" &&
		reasoning.requestedEffort === undefined &&
		reasoning.disableMode === "lowest-effort" &&
		reasoning.wireEffort !== undefined
	) {
		params.reasoning_effort = reasoning.wireEffort as Effort;
		return;
	}
	encodeChatCompletionsDisabledReasoning(params, reasoning.disableMode);
}

export function applyChatCompletionsReasoningParams(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	options: (ChatCompletionsReasoningOptions & { toolChoice?: unknown }) | undefined,
): void {
	applyChatCompletionsCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "chat-completions",
			compat,
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
		}),
	);
}

export function disableChatCompletionsReasoningForDialect(
	params: OpenAICompletionsParams,
	compat: ResolvedOpenAICompat,
): void {
	encodeChatCompletionsDisabledReasoning(params, compat.reasoningDisableMode);
}

/** GLM-5.2 reasoning-effort dialect predicate. */
function isZaiReasoningEffortDialect(model: Model<"openai-completions">, compat: ResolvedOpenAICompat): boolean {
	return compat.thinkingFormat === "zai" && isGlm52ReasoningEffortModelId(model.id);
}

/** Output-token clamp for Z.AI/GLM-5.2 reasoning dialect. */
export function resolveZaiReasoningOutputClamp(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): number | undefined {
	return isZaiReasoningEffortDialect(model, compat) ? (model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined;
}

/** Enable tool_stream for Z.AI/GLM-5.2 reasoning models when tools are present. */
export function applyChatCompletionsToolStream(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): void {
	if (
		isZaiReasoningEffortDialect(model, compat) &&
		compat.supportsReasoningEffort &&
		Array.isArray(params.tools) &&
		params.tools.length > 0
	) {
		params.tool_stream = true;
	}
}

/** Extract combined error message from Error and HTTP response. */
function rejectionText(error: unknown, capturedErrorResponse: CapturedHttpErrorResponse | undefined): string {
	return [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
}

/** Whether error indicates compiled grammar too large. */
export function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	return AIError.matchesCompiledGrammarTooLargeText(rejectionText(error, capturedErrorResponse));
}

/** Whether endpoint rejected the request for carrying strict tools. */
export function shouldRetryWithoutStrictTools(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
	strictToolsApplied: boolean,
	tools: Tool[] | undefined,
): boolean {
	if (!tools || tools.length === 0 || !strictToolsApplied) return false;
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400 && status !== 422) return false;
	return AIError.matchesStrictToolsRejectionText(rejectionText(error, capturedErrorResponse));
}

function normalizeOpenAIStableId(value: string | undefined, maxLength: number, hashPrefix: string): string | undefined {
	if (!value || value.length === 0) return undefined;
	const wellFormed = value.toWellFormed();
	if (wellFormed.length <= maxLength) return wellFormed;
	return `${hashPrefix}${Bun.hash(wellFormed).toString(36)}`;
}

/** Format standard OpenAI error response. */
export function formatOpenAiError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export * from "./openai-responses-codec";
