import type { Effort } from "@veyyon/catalog/effort";
import { isGlm52ReasoningEffortModelId } from "@veyyon/catalog/identity";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
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
import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import * as AIError from "../error";
import { type Api, type Model, OPENAI_MAX_OUTPUT_TOKENS, type ServiceTier, type Tool } from "../types";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import { isForcedToolChoice } from "../utils/tool-choice";
import type { ChatCompletionCreateParamsStreaming } from "./openai-chat-wire";

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
	dropThinkingWhenReasoningEffort?: boolean;
}

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
	if (policy.compat.qwenPreserveThinking) {
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

function isZaiReasoningEffortDialect(model: Model<"openai-completions">, compat: ResolvedOpenAICompat): boolean {
	return compat.thinkingFormat === "zai" && isGlm52ReasoningEffortModelId(model.id);
}

export function resolveZaiReasoningOutputClamp(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): number | undefined {
	return isZaiReasoningEffortDialect(model, compat) ? (model.maxTokens ?? OPENAI_MAX_OUTPUT_TOKENS) : undefined;
}

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

function rejectionText(error: unknown, capturedErrorResponse: CapturedHttpErrorResponse | undefined): string {
	return [error instanceof Error ? error.message : undefined, capturedErrorResponse?.bodyText]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");
}

export function isCompiledGrammarTooLargeStrictError(
	error: unknown,
	capturedErrorResponse: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;
	return AIError.matchesCompiledGrammarTooLargeText(rejectionText(error, capturedErrorResponse));
}

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

export function normalizeOpenAIStableId(
	value: string | undefined,
	maxLength: number,
	hashPrefix: string,
): string | undefined {
	if (!value || value.length === 0) return undefined;
	const wellFormed = value.toWellFormed();
	if (wellFormed.length <= maxLength) return wellFormed;
	return `${hashPrefix}${Bun.hash(wellFormed).toString(36)}`;
}

export function formatOpenAiError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { message, type } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
