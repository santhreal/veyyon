import { scheduler } from "node:timers/promises";
import { mapEffortToAnthropicAdaptiveEffort } from "@veyyon/catalog/model-thinking";
import { calculateCost } from "@veyyon/catalog/models";
import { ANTHROPIC_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { isAnthropicOAuthToken } from "@veyyon/catalog/utils";
import { parseGitHubCopilotApiKey } from "@veyyon/catalog/wire/github-copilot";
import { DEFAULT_MAX_DELAY_MS } from "@veyyon/utils/fetch-retry";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import {
	beginCacheTrackedRequest,
	type CacheEnforcement,
	CacheRejectedError,
	type CacheTrackedRequest,
	type CacheTrackerState,
	describeCacheVerdict,
	recordCacheOutcome,
	resolveCacheEnforcement,
	takePendingCacheFailure,
} from "../cache";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	Model,
	RawSseEvent,
	StopReason,
	StreamFunction,
	Tool,
	ToolResultMessage,
} from "../types";
import { EMPTY_ERROR_TOOL_RESULT_TEXT, realizesPriorityServiceTier } from "../types";
import { isRecord, normalizeSystemPrompts, normalizeToolCallId } from "../utils";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { clearStreamingPartialJson } from "../utils/block-symbols";
import { withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { type FirstEventBudget, isPreResponseStall, openStallLadderBudget } from "../utils/first-event-budget";
import { finalizeErrorMessage, materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { createSdkStreamRequestOptions } from "../utils/sdk-stream-timeout";
import {
	AnthropicApiError,
	AnthropicConnectionTimeoutError,
	type AnthropicFetchOptions,
	AnthropicMessagesClient,
	type AnthropicMessagesClientLike,
	calculateAnthropicRetryDelayMs,
	retryDelayFromHeaders,
} from "./anthropic-client";
import { buildAnthropicToolSchemaPlans } from "./anthropic-schema";
import type {
	Tool as AnthropicWireTool,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
} from "./anthropic-wire";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers";
import { transformMessages } from "./transform-messages";

export { normalizeAnthropicToolSchema } from "./anthropic-schema";

import {
	ANTHROPIC_STOP_SEQUENCES_MAX,
	type AnthropicCacheControl,
	type AnthropicClientOptionsArgs,
	type AnthropicClientOptionsResult,
	type AnthropicEffort,
	type AnthropicOptions,
	type AnthropicOutputConfig,
	type AnthropicOutputEffort,
	type AnthropicProviderSessionState,
	type AnthropicStreamBlock,
	type AnthropicStreamContext,
	type AnthropicStreamEvent,
	type AnthropicThinkingDisplay,
	type AnthropicToolResultContent,
	anthropicWire,
	applyAnthropicUsageExtras,
	buildAnthropicHeaders,
	buildBetaHeader,
	buildClaudeCodeBetas,
	buildClaudeCodeTlsFetchOptions,
	CLAUDE_BILLING_HEADER_PREFIX,
	CLAUDE_CODE_MAX_OUTPUT_TOKENS,
	calculateFallbackTurnCost,
	claudeCodeSystemInstruction,
	cloneAnthropicCacheControl,
	convertContentBlocks,
	createClaudeBillingHeader,
	createEmptyUsage,
	discardAnthropicAttempt,
	dropAnthropicFastMode,
	dropAnthropicStrictTools,
	encodeAnthropicToolName,
	extractClaudeMetadataSessionId,
	fallbackServedModelFromUsage,
	finalizeAnthropicStreamBlock,
	fineGrainedToolStreamingBeta,
	getAnthropicProviderSessionState,
	getAnthropicStreamResponse,
	getCacheControl,
	getHeaderCaseInsensitive,
	getUmansWebSearchHeader,
	handleAnthropicContentBlockDeltaEvent,
	handleAnthropicContentBlockStartEvent,
	handleAnthropicMessageStartEvent,
	hasStrictAnthropicTools,
	interleavedThinkingBeta,
	isAnthropicStreamRetryable,
	isInvalidThinkingSignatureError,
	maybeAddReplayUnsignedThinkingHint,
	mergeHeaders,
	observeDecodedAnthropicSdkEvents,
	PING_PROGRESS_MAX_IDLE_MULTIPLIER,
	PROVIDER_MAX_RETRIES,
	prepareAnthropicManyImageContext,
	readAnthropicMetadataAccountId,
	reportAnthropicEnvelopeAnomaly,
	resolveAnthropicBaseUrl,
	resolveAnthropicCustomHeaders,
	resolveAnthropicMetadataUserId,
	resolveAnthropicStreamBetas,
	shouldIgnoreAnthropicPreambleEvent,
	wrapFetchForCch,
} from "./anthropic-helpers";

export { CLAUDE_CODE_VERSION as claudeCodeVersion } from "@veyyon/catalog/wire/anthropic";
export {
	__resetDroppedEnforcedHeaderReportsForTests,
	type AnthropicClientOptionsArgs,
	type AnthropicClientOptionsResult,
	type AnthropicEffort,
	type AnthropicHeaderOptions,
	type AnthropicOptions,
	type AnthropicOutputEffort,
	type AnthropicThinkingDisplay,
	type AnthropicUsageLike,
	applyAnthropicUsageExtras,
	applyClaudeToolPrefix,
	buildAnthropicHeaders,
	buildBetaHeader,
	buildClaudeCodeBetas,
	CLAUDE_CODE_MAX_OUTPUT_TOKENS,
	claudeAgentSdkVersion,
	claudeClientVersion,
	claudeCodeHeaders,
	claudeCodeSystemInstruction,
	claudeToolPrefix,
	clearAnthropicFastModeFallback,
	contextManagementBeta,
	deriveClaudeDeviceId,
	effortBeta,
	fastModeBeta,
	fineGrainedToolStreamingBeta,
	generateClaudeCloakingUserId,
	getHeaderCaseInsensitive,
	interleavedThinkingBeta,
	isAnthropicStreamRetryable,
	isClaudeCloakingUserId,
	isClaudeCodeClientUserAgent,
	isInvalidThinkingSignatureError,
	iterateAnthropicEvents,
	mapStainlessArch,
	mapStainlessOs,
	maybeAddReplayUnsignedThinkingHint,
	midConversationSystemBeta,
	normalizeAnthropicBaseUrl,
	reportDroppedEnforcedHeaders,
	resolveAnthropicCustomHeadersForBaseUrl,
	resolveAnthropicMetadataUserId,
	serverSideFallbackBeta,
	sharedHeaders,
	stripClaudeToolPrefix,
	taskBudgetBeta,
	wrapFetchForCch,
} from "./anthropic-helpers";

let warnedStopSequencesTrim = false;

function handleAnthropicContentBlockStopEvent(
	event: Extract<AnthropicStreamEvent, { type: "content_block_stop" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawTerminalEnvelope) {
		reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
		return;
	}
	const openBlock = ctx.openBlocks.get(event.index);
	if (!openBlock) {
		reportAnthropicEnvelopeAnomaly(`received content_block_stop for unopened index ${event.index}`);
		return;
	}
	if (openBlock.kind === "ignored") {
		ctx.openBlocks.delete(event.index);
		return;
	}
	const block = ctx.blocks[openBlock.contentIndex];
	if (!block || block.type !== openBlock.kind) {
		reportAnthropicEnvelopeAnomaly(`content_block_stop kind mismatch for index ${event.index}`);
		ctx.openBlocks.delete(event.index);
		return;
	}
	ctx.openBlocks.delete(event.index);
	ctx.closedBlockIndexes.add(event.index);
	finalizeAnthropicStreamBlock(block, openBlock.contentIndex, ctx.output, ctx.stream);
}

function handleAnthropicMessageDeltaEvent(
	event: Extract<AnthropicStreamEvent, { type: "message_delta" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawTerminalEnvelope) {
		reportAnthropicEnvelopeAnomaly("received message_delta after terminal stop signal");
		return;
	}
	const delta = event.delta;
	const rawStopReason = delta?.stop_reason;
	if (rawStopReason) {
		ctx.output.stopReason = mapStopReason(rawStopReason);
		ctx.sawTerminalEnvelope = true;
	}
	if (ctx.output.stopReason === "error") {
		const stopDetails = delta?.stop_details;
		ctx.output.stopDetails = stopDetails ?? (rawStopReason ? { type: rawStopReason } : null);
		if (stopDetails?.type === "refusal") {
			const explanation = stopDetails.explanation?.trim();
			const category = stopDetails.category;
			const label = category ? `Refusal (${category})` : "Refusal";
			ctx.output.errorMessage = explanation ? `${label}: ${explanation}` : label;
		} else if (!ctx.output.errorMessage) {
			ctx.output.errorMessage =
				rawStopReason === "refusal"
					? "Refusal (no details provided)"
					: rawStopReason === "sensitive"
						? "Content flagged by safety filters"
						: `Anthropic stream ended with stop_reason: ${rawStopReason ?? "unknown"}`;
		}
	}
	const deltaUsage = event.usage;
	if (deltaUsage) {
		if (deltaUsage.input_tokens != null) ctx.output.usage.input = deltaUsage.input_tokens;
		if (deltaUsage.output_tokens != null) ctx.output.usage.output = deltaUsage.output_tokens;
		if (deltaUsage.cache_read_input_tokens != null) ctx.output.usage.cacheRead = deltaUsage.cache_read_input_tokens;
		if (deltaUsage.cache_creation_input_tokens != null)
			ctx.output.usage.cacheWrite = deltaUsage.cache_creation_input_tokens;
		applyAnthropicUsageExtras(ctx.output.usage, deltaUsage);
		ctx.output.usage.totalTokens =
			ctx.output.usage.input + ctx.output.usage.output + ctx.output.usage.cacheRead + ctx.output.usage.cacheWrite;
		if (ctx.serverSideFallback) {
			const served = fallbackServedModelFromUsage(deltaUsage);
			if (served) ctx.output.model = served;
			if (!calculateFallbackTurnCost(ctx.model, ctx.output.usage, deltaUsage)) {
				calculateCost(ctx.model, ctx.output.usage);
			}
		} else {
			calculateCost(ctx.model, ctx.output.usage);
		}
	}
}

function processAnthropicStreamEvent(event: AnthropicStreamEvent, ctx: AnthropicStreamContext): void {
	ctx.sawEvent = true;
	if (event.type === "message_start") {
		handleAnthropicMessageStartEvent(event, ctx);
	} else if (!ctx.sawMessageStart) {
		if (!shouldIgnoreAnthropicPreambleEvent(event.type)) {
			throw new AIError.AnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
		}
	} else if (event.type === "content_block_start") {
		handleAnthropicContentBlockStartEvent(event, ctx);
	} else if (event.type === "content_block_delta") {
		handleAnthropicContentBlockDeltaEvent(event, ctx);
	} else if (event.type === "content_block_stop") {
		handleAnthropicContentBlockStopEvent(event, ctx);
	} else if (event.type === "message_delta") {
		handleAnthropicMessageDeltaEvent(event, ctx);
	} else if (event.type === "message_stop") {
		ctx.sawTerminalEnvelope = true;
		ctx.sawMessageStop = true;
	}
}

function finalizeAnthropicStreamTurn(ctx: AnthropicStreamContext, activeAbortTracker: AbortSourceTracker): void {
	const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
	if (firstEventTimeoutError) throw firstEventTimeoutError;
	if (activeAbortTracker.wasCallerAbort()) throw new AIError.RequestAbortError();
	if (!ctx.sawEvent || !ctx.sawMessageStart) {
		throw new AIError.AnthropicStreamEnvelopeError("stream ended before message_start");
	}
	if (!ctx.sawMessageStop) {
		reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
	}
	const truncatedMidDelta = ctx.openBlocks.size > 0 && !ctx.sawTerminalEnvelope;
	for (const [openIndex, openBlock] of ctx.openBlocks) {
		reportAnthropicEnvelopeAnomaly(`stream ended with an unterminated ${openBlock.kind} block at index ${openIndex}`);
		if (openBlock.kind === "ignored" || openBlock.contentIndex < 0) continue;
		const danglingBlock = ctx.blocks[openBlock.contentIndex];
		if (danglingBlock) finalizeAnthropicStreamBlock(danglingBlock, openBlock.contentIndex, ctx.output, ctx.stream);
	}
	ctx.openBlocks.clear();
	if (truncatedMidDelta) {
		throw new AIError.AnthropicStreamEnvelopeError(
			"Anthropic stream ended mid-message with an unterminated content block, so the turn is truncated",
		);
	}
	if (ctx.output.stopReason === "aborted" || ctx.output.stopReason === "error") {
		throw new AIError.ProviderResponseError(ctx.output.errorMessage ?? "An unknown error occurred", {
			provider: ctx.model.provider,
			kind: "output",
		});
	}
}

function recordAnthropicCacheResult(
	cacheTracker: CacheTrackerState | undefined,
	cacheTracked: CacheTrackedRequest | undefined,
	cacheEnforcement: CacheEnforcement,
	params: MessageCreateParamsStreaming,
	output: AssistantMessage,
	model: Model<"anthropic-messages">,
): void {
	if (!cacheTracker || !cacheTracked || cacheEnforcement === "off") return;
	const sent = {
		key: cacheTracked.key,
		expectation: { ...cacheTracked.expectation, anchors: countCacheControlBreakpoints(params) },
	};
	const { verdict, decision } = recordCacheOutcome(cacheTracker, sent, output.usage, cacheEnforcement);
	if (decision.report) {
		logger.warn(`anthropic: ${describeCacheVerdict(verdict)}`, {
			model: model.id,
			provider: model.provider,
			verdict: verdict.kind,
			anchors: sent.expectation.anchors,
			willFailNextRequest: decision.failNext,
		});
	}
}

interface AnthropicStreamRetryContext {
	model: Model<"anthropic-messages">;
	output: AssistantMessage;
	options?: AnthropicOptions;
	activeAbortTracker: AbortSourceTracker;
	firstEventBudget: FirstEventBudget;
	idleTimeoutAbortError: AIError.StreamTimeoutError;
	firstTokenTime: number | undefined;
	streamedReplayUnsafeContent: boolean;
	providerRetryAttempt: number;
	copilotDynamicHeaders?: { premiumRequests?: number };
	params: MessageCreateParamsStreaming;
	rawRequestDump?: RawHttpRequestDump;
	anthropicWireBodyJson?: string;
	providerSessionState?: AnthropicProviderSessionState;
	baseUrl: string;
	disableStrictTools: boolean;
	forceDemoteUnsignedThinking: boolean;
	dropFastMode: boolean;
	prepareParams: (
		disableStrict?: boolean,
		dropFast?: boolean,
		forceDemote?: boolean,
	) => Promise<MessageCreateParamsStreaming>;
}

async function handleAnthropicStreamPreflightRetry(
	streamFailure: unknown,
	ctx: AnthropicStreamRetryContext,
): Promise<{
	disableStrictTools: boolean;
	forceDemoteUnsignedThinking: boolean;
	dropFastMode: boolean;
	providerRetryAttempt: number;
	params: MessageCreateParamsStreaming;
} | null> {
	if (
		!ctx.disableStrictTools &&
		ctx.firstTokenTime === undefined &&
		hasStrictAnthropicTools(ctx.params) &&
		AIError.isGrammarError(streamFailure)
	) {
		logger.warn("anthropic: strict tools rejected, retrying without strict tools", {
			model: ctx.model.id,
			error: await finalizeErrorMessage(
				streamFailure,
				materializeDumpBody(ctx.rawRequestDump, ctx.anthropicWireBodyJson),
			),
		});
		if (ctx.providerSessionState) ctx.providerSessionState.strictToolsDisabled = true;
		const nextParams = await ctx.prepareParams(true, ctx.dropFastMode, ctx.forceDemoteUnsignedThinking);
		discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
		return {
			disableStrictTools: true,
			forceDemoteUnsignedThinking: ctx.forceDemoteUnsignedThinking,
			dropFastMode: ctx.dropFastMode,
			providerRetryAttempt: 0,
			params: nextParams,
		};
	}
	if (
		!ctx.forceDemoteUnsignedThinking &&
		ctx.firstTokenTime === undefined &&
		!ctx.streamedReplayUnsafeContent &&
		isInvalidThinkingSignatureError(errorMessage(streamFailure))
	) {
		logger.warn(
			"anthropic: signing proxy detected (Invalid signature in thinking block), demoting unsigned thinking and retrying",
			{
				provider: ctx.model.provider,
				model: ctx.model.id,
				baseUrl: ctx.baseUrl,
				error: errorMessage(streamFailure),
			},
		);
		if (ctx.providerSessionState) ctx.providerSessionState.replayUnsignedThinkingDisabled = true;
		const nextParams = await ctx.prepareParams(ctx.disableStrictTools, ctx.dropFastMode, true);
		discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
		return {
			disableStrictTools: ctx.disableStrictTools,
			forceDemoteUnsignedThinking: true,
			dropFastMode: ctx.dropFastMode,
			providerRetryAttempt: 0,
			params: nextParams,
		};
	}
	if (
		!ctx.dropFastMode &&
		realizesPriorityServiceTier(ctx.options?.serviceTier, ctx.model) &&
		ctx.firstTokenTime === undefined &&
		AIError.isFastModeUnsupported(streamFailure)
	) {
		logger.warn(
			"anthropic: fast mode is not available for this model, so the request was retried at the standard service tier and fast mode is off for the rest of this session",
			{
				model: ctx.model.id,
				provider: ctx.model.provider,
				error: errorMessage(streamFailure),
			},
		);
		if (ctx.providerSessionState) ctx.providerSessionState.fastModeDisabled = true;
		const nextParams = await ctx.prepareParams(ctx.disableStrictTools, true, ctx.forceDemoteUnsignedThinking);
		discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
		return {
			disableStrictTools: ctx.disableStrictTools,
			forceDemoteUnsignedThinking: ctx.forceDemoteUnsignedThinking,
			dropFastMode: true,
			providerRetryAttempt: 0,
			params: nextParams,
		};
	}
	return null;
}

async function handleAnthropicStreamRetry(
	streamFailure: unknown,
	ctx: AnthropicStreamRetryContext,
): Promise<{
	disableStrictTools: boolean;
	forceDemoteUnsignedThinking: boolean;
	dropFastMode: boolean;
	providerRetryAttempt: number;
	params: MessageCreateParamsStreaming;
}> {
	const preflightResult = await handleAnthropicStreamPreflightRetry(streamFailure, ctx);
	if (preflightResult) return preflightResult;
	const isTransientEnvelopeFailure =
		AIError.isTransientStreamParseError(streamFailure) || AIError.isStreamEnvelopeError(streamFailure);
	const isLocalIdleTimeout =
		streamFailure === ctx.idleTimeoutAbortError ||
		(streamFailure instanceof Error && streamFailure.message === ctx.idleTimeoutAbortError.message);
	const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !ctx.streamedReplayUnsafeContent;
	const canRetryProviderFailure =
		!isLocalIdleTimeout &&
		ctx.firstTokenTime === undefined &&
		!ctx.streamedReplayUnsafeContent &&
		isAnthropicStreamRetryable(streamFailure, ctx.model.provider);
	const nothingArrivedOutlivedBudget =
		ctx.firstTokenTime === undefined &&
		(isPreResponseStall(streamFailure) || AIError.isEmptyStreamEnvelopeError(streamFailure)) &&
		ctx.firstEventBudget.spent();
	if (
		ctx.activeAbortTracker.wasCallerAbort() ||
		ctx.providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
		nothingArrivedOutlivedBudget ||
		(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
	) {
		throw streamFailure;
	}
	const nextAttempt = ctx.providerRetryAttempt + 1;
	const backoffDelayMs = calculateAnthropicRetryDelayMs(ctx.providerRetryAttempt);
	const headerDelayMs =
		streamFailure instanceof Error && streamFailure instanceof AnthropicApiError
			? retryDelayFromHeaders(streamFailure.headers)
			: undefined;
	const maxRetryDelayMs = ctx.options?.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS;
	if (headerDelayMs !== undefined && headerDelayMs > maxRetryDelayMs) throw streamFailure;
	const delayMs = headerDelayMs !== undefined ? Math.max(headerDelayMs, backoffDelayMs) : backoffDelayMs;
	if (ctx.options?.providerRetryWait) {
		await ctx.options.providerRetryWait(delayMs, ctx.options.signal);
	} else {
		await scheduler.wait(delayMs, { signal: ctx.options?.signal });
	}
	discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
	return {
		disableStrictTools: ctx.disableStrictTools,
		forceDemoteUnsignedThinking: ctx.forceDemoteUnsignedThinking,
		dropFastMode: ctx.dropFastMode,
		providerRetryAttempt: nextAttempt,
		params: ctx.params,
	};
}

const streamAnthropicOnce = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let anthropicWireBodyJson: string | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;

		try {
			const copilotDynamicHeaders =
				anthropicWire(model).credential === "copilot-bearer"
					? buildCopilotDynamicHeaders({
							messages: context.messages,
							hasImages: hasCopilotVisionInput(context.messages),
							premiumMultiplier: model.premiumMultiplier,
							headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
							initiatorOverride: options?.initiatorOverride,
						})
					: undefined;
			if (copilotDynamicHeaders?.premiumRequests !== undefined) {
				output.usage.premiumRequests = copilotDynamicHeaders.premiumRequests;
			}
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? ANTHROPIC_API_ENDPOINT;
			const providerSessionState = getAnthropicProviderSessionState(
				options?.providerSessionState,
				baseUrl,
				model.id,
			);
			let disableStrictTools =
				(providerSessionState?.strictToolsDisabled ?? false) || (model.compat?.disableStrictTools ?? false);
			let dropFastMode = providerSessionState?.fastModeDisabled ?? false;
			let forceDemoteUnsignedThinking = providerSessionState?.replayUnsignedThinkingDisabled ?? false;
			const mergedCallerHeaders = mergeHeaders(model.headers, options?.headers);
			const umansGatewayWebSearchHeader = getUmansWebSearchHeader(model, mergedCallerHeaders);

			let client: AnthropicMessagesClientLike;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const extraBetas = resolveAnthropicStreamBetas(model, options, dropFastMode);
				const created = createClient(model, {
					model,
					apiKey,
					extraBetas,
					stream: true,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
					hasTools: !!context.tools?.length,
					thinkingEnabled: options?.thinkingEnabled,
					thinkingDisplay: options?.thinkingDisplay,
					fetch: options?.fetch,
					claudeCodeSessionId: options?.sessionId ?? extractClaudeMetadataSessionId(options?.metadata?.user_id),
					disableStrictTools,
				});
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			const preparedContext = await prepareAnthropicManyImageContext(context, model.input.includes("image"));
			const prepareParams = async (
				currentDisableStrict = disableStrictTools,
				currentDropFast = dropFastMode,
				currentForceDemote = forceDemoteUnsignedThinking,
			): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(
					model,
					preparedContext,
					isOAuthToken,
					options,
					currentDisableStrict,
					umansGatewayWebSearchHeader !== undefined,
					currentForceDemote,
				);
				if (currentDisableStrict) dropAnthropicStrictTools(nextParams);
				if (currentDropFast) dropAnthropicFastMode(nextParams);
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				nextParams = toWellFormedDeep(nextParams) as typeof nextParams;
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
				};
				anthropicWireBodyJson = JSON.stringify(nextParams);
				return nextParams;
			};
			let params = await prepareParams();

			const cacheEnforcement: CacheEnforcement = resolveCacheEnforcement(options?.cacheEnforcement);
			const cacheTracker: CacheTrackerState | undefined = providerSessionState?.cacheTracker;
			if (cacheTracker && cacheEnforcement !== "off") {
				const pending = takePendingCacheFailure(cacheTracker, options?.promptCacheKey);
				if (pending) throw new CacheRejectedError(pending, model.provider, model.id);
			}
			const cacheTracked = cacheTracker
				? beginCacheTrackedRequest(cacheTracker, {
						anchors: countCacheControlBreakpoints(params),
						retention: anthropicRetentionFromParams(params),
						reportsCacheWrites: true,
						...(options?.promptCacheKey === undefined ? {} : { cacheKey: options.promptCacheKey }),
					})
				: undefined;

			const serverSideFallback = !!options?.fallbacks?.length;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const blocks = output.content as AnthropicStreamBlock[];

			stream.push({ type: "start", partial: output });
			let providerRetryAttempt = 0;
			const firstEventBudget = openStallLadderBudget(firstEventTimeoutMs);
			const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream timed out while waiting for the first event",
			);
			const idleTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream stalled while waiting for the next event",
			);

			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const { requestSignal } = activeAbortTracker;
				const requestOptions = {
					...createSdkStreamRequestOptions(requestSignal, requestTimeoutMs),
					maxRetries: 0,
					...(umansGatewayWebSearchHeader ? { headers: umansGatewayWebSearchHeader } : {}),
				};
				const anthropicRequest: unknown =
					isOAuthToken && client.beta
						? client.beta.messages.create({ ...params, stream: true }, requestOptions)
						: client.messages.create({ ...params, stream: true }, requestOptions);

				const streamContext: AnthropicStreamContext = {
					model,
					output,
					stream,
					serverSideFallback,
					isOAuthToken,
					openBlocks: new Map(),
					closedBlockIndexes: new Set(),
					blocks,
					firstTokenTime,
					streamedReplayUnsafeContent: false,
					sawEvent: false,
					sawMessageStart: false,
					sawTerminalEnvelope: false,
					sawMessageStop: false,
					sawSplicedEnvelope: false,
				};

				try {
					let requestTimeout: NodeJS.Timeout | undefined;
					if (requestTimeoutMs !== undefined) {
						requestTimeout = setTimeout(
							() => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
							requestTimeoutMs,
						);
					}
					let anthropicStream: AsyncIterable<AnthropicStreamEvent>;
					let response: Response;
					let requestId: string | null;
					let recordsRawSseEvents: boolean;
					try {
						({
							events: anthropicStream,
							response,
							requestId,
							recordsRawSseEvents,
						} = await getAnthropicStreamResponse(anthropicRequest, requestSignal, rawSseObserver));
					} catch (error) {
						if (error instanceof AnthropicConnectionTimeoutError && !activeAbortTracker.wasCallerAbort()) {
							throw firstEventTimeoutAbortError;
						}
						throw error;
					} finally {
						if (requestTimeout !== undefined) clearTimeout(requestTimeout);
					}
					await notifyProviderResponse(options, response, model, requestId);

					let sawNonPingEvent = false;
					let lastNonPingProgressAtMs = 0;
					const pingProgressCapMs =
						idleTimeoutMs !== undefined && idleTimeoutMs > 0
							? idleTimeoutMs * PING_PROGRESS_MAX_IDLE_MULTIPLIER
							: undefined;
					const timedAnthropicStream = iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventTimeoutMs,
						errorMessage: idleTimeoutAbortError.message,
						firstItemErrorMessage: firstEventTimeoutAbortError.message,
						onIdle: () => activeAbortTracker.abortLocally(idleTimeoutAbortError),
						onFirstItemTimeout: () => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
						abortSignal: options?.signal,
						isProgressItem: item => {
							if ((item as AnthropicStreamEvent).type === "ping") {
								if (!sawNonPingEvent) return false;
								if (pingProgressCapMs === undefined) return true;
								return Date.now() - lastNonPingProgressAtMs < pingProgressCapMs;
							}
							sawNonPingEvent = true;
							lastNonPingProgressAtMs = Date.now();
							return true;
						},
					});
					const observedAnthropicStream =
						rawSseObserver && !recordsRawSseEvents
							? observeDecodedAnthropicSdkEvents(timedAnthropicStream, rawSseObserver)
							: timedAnthropicStream;

					for await (const event of observedAnthropicStream) {
						processAnthropicStreamEvent(event, streamContext);
					}
					firstTokenTime = streamContext.firstTokenTime;

					finalizeAnthropicStreamTurn(streamContext, activeAbortTracker);
					recordAnthropicCacheResult(cacheTracker, cacheTracked, cacheEnforcement, params, output, model);
					break;
				} catch (streamError) {
					firstTokenTime = streamContext.firstTokenTime;
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					const retryResult = await handleAnthropicStreamRetry(streamFailure, {
						model,
						output,
						options,
						activeAbortTracker,
						firstEventBudget,
						idleTimeoutAbortError,
						firstTokenTime,
						streamedReplayUnsafeContent: streamContext.streamedReplayUnsafeContent,
						providerRetryAttempt,
						copilotDynamicHeaders,
						params,
						rawRequestDump,
						anthropicWireBodyJson,
						providerSessionState,
						baseUrl,
						disableStrictTools,
						forceDemoteUnsignedThinking,
						dropFastMode,
						prepareParams,
					});
					disableStrictTools = retryResult.disableStrictTools;
					forceDemoteUnsignedThinking = retryResult.forceDemoteUnsignedThinking;
					dropFastMode = retryResult.dropFastMode;
					providerRetryAttempt = retryResult.providerRetryAttempt;
					params = retryResult.params;
					firstTokenTime = undefined;
				}
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			if (dropFastMode && realizesPriorityServiceTier(options?.serviceTier, model)) {
				output.disabledFeatures = (output.disabledFeatures ?? []).concat(["priority"]);
			}
			if (forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking) {
				output.disabledFeatures = (output.disabledFeatures ?? []).concat(["unsigned-thinking-replay"]);
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker: activeAbortTracker,
				rawRequestDump: materializeDumpBody(rawRequestDump, anthropicWireBodyJson),
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = maybeAddReplayUnsignedThinkingHint(model, result.message);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamAnthropicOnce, { providerRetriesStalls: true });

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];

	firstUserMessageText?: string;
	cacheControl?: AnthropicCacheControl;
};

function applyClaudeCodeSystemCache(
	blocks: AnthropicSystemBlock[],
	cacheControl: AnthropicCacheControl | undefined,
): number {
	if (!cacheControl || blocks.length === 0) return 0;
	const lastIndex = blocks.length - 1;
	if (blocks[lastIndex].cache_control != null) return 0;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cloneAnthropicCacheControl(cacheControl) };
	return 1;
}

export function buildAnthropicSystemBlocks(
	systemPrompt: readonly string[] | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction = false, extraInstructions = [], firstUserMessageText, cacheControl } = options;
	const sanitizedPrompts = normalizeSystemPrompts(systemPrompt);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompts.some(prompt => prompt.startsWith(CLAUDE_BILLING_HEADER_PREFIX));

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const blocks: AnthropicSystemBlock[] = [
			{ type: "text", text: createClaudeBillingHeader(firstUserMessageText ?? "") },
			{ type: "text", text: claudeCodeSystemInstruction },
		];

		for (const instruction of trimmedInstructions) {
			blocks.push({ type: "text", text: instruction });
		}
		for (const prompt of sanitizedPrompts) {
			blocks.push({ type: "text", text: prompt });
		}
		applyClaudeCodeSystemCache(blocks, cacheControl);

		return blocks;
	}

	const blocks: AnthropicSystemBlock[] = [];
	for (const instruction of trimmedInstructions) {
		blocks.push({ type: "text", text: instruction });
	}
	for (const prompt of sanitizedPrompts) {
		blocks.push({ type: "text", text: prompt });
	}
	const lastIndex = blocks.length - 1;
	if (cacheControl && lastIndex >= 0 && blocks[lastIndex].cache_control == null) {
		blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cloneAnthropicCacheControl(cacheControl) };
	}
	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		hasTools = false,
		thinkingEnabled = false,
		thinkingDisplay,
		isOAuth,
		claudeCodeSessionId,
		disableStrictTools: disableStrictToolsOverride,
	} = args;
	const compat = model.compat;
	const disableStrictTools = disableStrictToolsOverride ?? compat.disableStrictTools;
	const needsInterleavedBeta = interleavedThinking && !model.thinking?.supportsDisplay;
	const needsFineGrainedToolStreamingBeta = hasTools && !compat.supportsEagerToolInputStreaming;
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model);
	const tlsFetchOptions = buildClaudeCodeTlsFetchOptions(model, baseUrl);
	const fetchOptions: AnthropicFetchOptions = { ...(tlsFetchOptions ?? {}), timeout: false };
	const baseFetch = args.fetch ?? fetch;

	const cchFetch = oauthToken ? wrapFetchForCch(baseFetch) : baseFetch;
	const wire = anthropicWire(model);
	if (wire.credential === "copilot-bearer") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;
		const betaFeatures = extraBetas.slice();
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	const betaFeatures = extraBetas.slice();
	if (needsFineGrainedToolStreamingBeta) {
		betaFeatures.push(fineGrainedToolStreamingBeta);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(interleavedThinkingBeta);
	}

	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: mergeHeaders(
			model.headers,
			foundryCustomHeaders,
			getUmansWebSearchHeader(model, mergeHeaders(model.headers, headers)),
			headers,
			dynamicHeaders,
		),
		isCloudflareAiGateway: wire.credential === "gateway-managed",
		claudeCodeSessionId,
		claudeCodeBetas: oauthToken
			? buildClaudeCodeBetas(
					hasTools || thinkingEnabled,
					thinkingEnabled,
					thinkingDisplay === "omitted",
					disableStrictTools,
				)
			: [],
	});

	if (wire.credential === "gateway-managed") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	if (wire.credential === "api-key-header") {
		delete defaultHeaders.Authorization;
		return {
			isOAuthToken: false,
			apiKey,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	if (wire.credential === "bearer-only") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	const authorizationHeader = getHeaderCaseInsensitive(defaultHeaders, "Authorization");
	const shouldSuppressClientApiKey =
		!oauthToken && !model.compat.officialEndpoint && typeof authorizationHeader === "string";

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken || shouldSuppressClientApiKey ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		defaultHeaders,
		fetch: cchFetch,
		fetchOptions,
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: AnthropicMessagesClient; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new AnthropicMessagesClient(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(params: MessageCreateParamsStreaming): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type !== "any" && toolChoice.type !== "tool") return;

	delete params.thinking;
	delete params.context_management;
	const outputConfig = params.output_config as AnthropicOutputConfig | undefined;
	if (!outputConfig) return;

	delete outputConfig.effort;
	if (Object.keys(outputConfig).length === 0) {
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, maxAllowedTokens: number): void {
	const thinking = params.thinking;
	if (thinking?.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const currentMaxTokens = Math.min(params.max_tokens ?? maxAllowedTokens, maxAllowedTokens);
	const raisedMaxTokens = Math.min(
		Math.max(currentMaxTokens, budgetTokens + OUTPUT_FALLBACK_BUFFER),
		maxAllowedTokens,
	);
	params.max_tokens = raisedMaxTokens;

	if (budgetTokens + OUTPUT_FALLBACK_BUFFER <= raisedMaxTokens) return;

	const clampedBudget = raisedMaxTokens - OUTPUT_FALLBACK_BUFFER;
	if (clampedBudget <= 0) {
		throw new AIError.ConfigurationError(
			`Anthropic thinking budget requires max_tokens greater than ${OUTPUT_FALLBACK_BUFFER}; got ${raisedMaxTokens}`,
		);
	}
	thinking.budget_tokens = clampedBudget;
}

type CacheControlBlock = {
	cache_control?: AnthropicCacheControl | null;
};

function applyCacheControlToLastBlock<T extends CacheControlBlock>(
	blocks: T[],
	cacheControl: AnthropicCacheControl,
): boolean {
	if (blocks.length === 0) return false;
	const lastIndex = blocks.length - 1;
	if (blocks[lastIndex].cache_control != null) return false;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cloneAnthropicCacheControl(cacheControl) };
	return true;
}
function applyCacheControlToStableSystemPrefix<T extends CacheControlBlock>(
	blocks: T[],
	cacheControl: AnthropicCacheControl,
	index: number,
): boolean {
	if (index < 0 || index >= blocks.length - 1) return false;
	if (blocks[index].cache_control != null) return false;
	blocks[index] = { ...blocks[index], cache_control: cloneAnthropicCacheControl(cacheControl) };
	return true;
}

function applyCacheControlToLastTextBlock(
	blocks: Array<ContentBlockParam & CacheControlBlock>,
	cacheControl: AnthropicCacheControl,
): boolean {
	if (blocks.length === 0) return false;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].type === "text") {
			if (blocks[i].cache_control != null) return false;
			blocks[i] = { ...blocks[i], cache_control: cloneAnthropicCacheControl(cacheControl) };
			return true;
		}
	}
	for (let i = blocks.length - 1; i >= 0; i--) {
		const type = blocks[i].type;
		if (type === "thinking" || type === "redacted_thinking") continue;
		if (blocks[i].cache_control != null) return false;
		blocks[i] = { ...blocks[i], cache_control: cloneAnthropicCacheControl(cacheControl) };
		return true;
	}
	return false;
}

function applyPromptCaching(params: MessageCreateParamsStreaming, cacheControl?: AnthropicCacheControl): void {
	if (!cacheControl) return;

	const MAX_CACHE_BREAKPOINTS = 4;
	let cacheBreakpointsUsed = countCacheControlBreakpoints(params);
	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;
	let isCCLayout = false;

	if (params.system && Array.isArray(params.system) && params.system.length > 0) {
		isCCLayout =
			params.system.length >= 3 &&
			(params.system[0] as { text?: string }).text?.startsWith(CLAUDE_BILLING_HEADER_PREFIX) === true;
		if (isCCLayout) {
			const placed = Math.min(
				MAX_CACHE_BREAKPOINTS - cacheBreakpointsUsed,
				applyClaudeCodeSystemCache(params.system as AnthropicSystemBlock[], cacheControl),
			);
			cacheBreakpointsUsed += placed;
		} else if (applyCacheControlToLastBlock(params.system, cacheControl)) {
			cacheBreakpointsUsed++;
		}

		const stablePrefixIndex = isCCLayout ? 2 : 0;
		if (
			cacheBreakpointsUsed < MAX_CACHE_BREAKPOINTS &&
			applyCacheControlToStableSystemPrefix(params.system, cacheControl, stablePrefixIndex)
		) {
			cacheBreakpointsUsed++;
		}
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	const start = isCCLayout ? Math.max(0, params.messages.length - 1) : Math.max(0, params.messages.length - 2);
	for (let i = start; i < params.messages.length; i++) {
		if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) break;
		const message = params.messages[i];
		if (!message) continue;
		if (typeof message.content === "string") {
			message.content = [
				{ type: "text", text: message.content, cache_control: cloneAnthropicCacheControl(cacheControl) },
			];
			cacheBreakpointsUsed++;
		} else if (Array.isArray(message.content) && message.content.length > 0) {
			if (
				applyCacheControlToLastTextBlock(
					message.content as Array<ContentBlockParam & CacheControlBlock>,
					cacheControl,
				)
			) {
				cacheBreakpointsUsed++;
			}
		}
	}
}

function normalizeCacheControlBlockTtl(block: CacheControlBlock, seenFiveMinute: { value: boolean }): void {
	const cacheControl = block.cache_control;
	if (!cacheControl) return;
	if (cacheControl.ttl !== "1h") {
		seenFiveMinute.value = true;
		return;
	}
	if (seenFiveMinute.value) {
		const normalized = cloneAnthropicCacheControl(cacheControl);
		delete normalized.ttl;
		block.cache_control = normalized;
	}
}

function normalizeCacheControlTtlOrdering(params: MessageCreateParamsStreaming): void {
	const seenFiveMinute = { value: false };
	if (params.tools) {
		for (const tool of params.tools as Array<AnthropicWireTool & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(tool, seenFiveMinute);
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
}

function findLastCacheControlIndex<T extends CacheControlBlock>(blocks: T[]): number {
	for (let index = blocks.length - 1; index >= 0; index--) {
		if (blocks[index]?.cache_control != null) return index;
	}
	return -1;
}

function stripCacheControlExceptIndex<T extends CacheControlBlock>(
	blocks: T[],
	preserveIndex: number,
	excessCounter: { value: number },
): void {
	for (let index = 0; index < blocks.length && excessCounter.value > 0; index++) {
		if (index === preserveIndex) continue;
		if (!blocks[index]?.cache_control) continue;
		delete blocks[index].cache_control;
		excessCounter.value--;
	}
}

function stripAllCacheControl<T extends CacheControlBlock>(blocks: T[], excessCounter: { value: number }): void {
	for (const block of blocks) {
		if (excessCounter.value <= 0) return;
		if (!block.cache_control) continue;
		delete block.cache_control;
		excessCounter.value--;
	}
}

function stripMessageCacheControl(
	messages: MessageCreateParamsStreaming["messages"],
	excessCounter: { value: number },
): void {
	for (const message of messages) {
		if (excessCounter.value <= 0) return;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (excessCounter.value <= 0) return;
			if (!block.cache_control) continue;
			delete block.cache_control;
			excessCounter.value--;
		}
	}
}

function anthropicRetentionFromParams(params: MessageCreateParamsStreaming): CacheRetention {
	let sawMarker = false;
	const inspect = (cacheControl: AnthropicCacheControl | null | undefined): boolean => {
		if (!cacheControl) return false;
		sawMarker = true;
		return cacheControl.ttl === "1h";
	};
	if (params.tools) {
		for (const tool of params.tools as Array<AnthropicWireTool & CacheControlBlock>) {
			if (inspect(tool.cache_control)) return "long";
		}
	}
	if (Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (inspect(block.cache_control)) return "long";
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (inspect(block.cache_control)) return "long";
		}
	}
	return sawMarker ? "short" : "none";
}

function countCacheControlBreakpoints(params: MessageCreateParamsStreaming): number {
	let total = 0;
	if (params.tools) {
		for (const tool of params.tools as Array<AnthropicWireTool & CacheControlBlock>) {
			if (tool.cache_control) total++;
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	return total;
}

function enforceCacheControlLimit(params: MessageCreateParamsStreaming, maxBreakpoints: number): void {
	const total = countCacheControlBreakpoints(params);
	if (total <= maxBreakpoints) return;
	const excessCounter = { value: total - maxBreakpoints };
	const systemBlocks =
		params.system && Array.isArray(params.system)
			? (params.system as Array<AnthropicSystemBlock & CacheControlBlock>)
			: [];
	const toolBlocks = (params.tools ?? []) as Array<AnthropicWireTool & CacheControlBlock>;
	const lastSystemIndex = findLastCacheControlIndex(systemBlocks);
	const lastToolIndex = findLastCacheControlIndex(toolBlocks);
	if (systemBlocks.length > 0) {
		stripCacheControlExceptIndex(systemBlocks, lastSystemIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripCacheControlExceptIndex(toolBlocks, lastToolIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	stripMessageCacheControl(params.messages, excessCounter);
	if (excessCounter.value <= 0) return;
	if (systemBlocks.length > 0) {
		stripAllCacheControl(systemBlocks, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripAllCacheControl(toolBlocks, excessCounter);
	}
}

export function usesAdaptiveThinkingTagOnly(model: Model<"anthropic-messages">): boolean {
	const thinking = model.thinking;
	if (thinking?.mode !== "anthropic-adaptive") return false;
	const effortMap = thinking.effortMap;
	if (!effortMap) return false;
	for (const effort of thinking.efforts) {
		if (effortMap[effort] !== "adaptive") return false;
	}
	return thinking.efforts.length > 0;
}

function resolveAnthropicAdaptiveEffort(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
): AnthropicEffort | undefined {
	if (options.effort) return usesAdaptiveThinkingTagOnly(model) ? "adaptive" : options.effort;
	const requestedEffort = options.reasoning;
	if (!requestedEffort) return undefined;
	return mapEffortToAnthropicAdaptiveEffort(model, requestedEffort);
}

function extractClaudeCodeFirstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		for (const block of content) {
			if (block.type === "text") return block.text;
		}
		return "";
	}
	return "";
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disableStrictTools = false,
	useUmansGatewayWebSearch = false,
	forceDemoteUnsignedThinking = false,
): MessageCreateParamsStreaming {
	const effectiveModel =
		forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking
			? { ...model, compat: { ...model.compat, replayUnsignedThinking: false } }
			: model;
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, isOAuthToken);

	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const firstUserMessageText = shouldInjectClaudeCodeInstruction
		? extractClaudeCodeFirstUserMessageText(context.messages)
		: "";
	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		firstUserMessageText,
	});

	let tools: AnthropicWireTool[] | undefined;
	if (context.tools) {
		tools = convertTools(
			context.tools,
			isOAuthToken,
			disableStrictTools || anthropicWire(model).rejectsBetas === true,
			model.compat.supportsEagerToolInputStreaming,
			model.compat.escapeBuiltinToolNames,
			useUmansGatewayWebSearch,
		);
	} else if (isOAuthToken) {
		tools = [];
	}

	const metadataAccountId = readAnthropicMetadataAccountId(options?.metadata);
	const metadataUserId = resolveAnthropicMetadataUserId(
		options?.metadata?.user_id,
		isOAuthToken,
		options?.sessionId,
		metadataAccountId,
	);
	const metadata = metadataUserId ? { user_id: metadataUserId } : undefined;

	let thinking: MessageCreateParamsStreaming["thinking"] | undefined;
	let outputConfigEffort: AnthropicOutputEffort | undefined;
	if (model.reasoning) {
		if (options?.thinkingEnabled || model.compat.requiresThinkingEnabled) {
			const thinkingOptions = options ?? {};
			const mode = model.thinking?.mode;
			const effort = resolveAnthropicAdaptiveEffort(model, thinkingOptions);
			const compat = model.compat;
			if (mode === "anthropic-adaptive" && !compat.disableAdaptiveThinking) {
				const adaptive: { type: "adaptive"; display?: AnthropicThinkingDisplay } = { type: "adaptive" };
				if (model.thinking?.supportsDisplay) {
					adaptive.display = thinkingOptions.thinkingDisplay ?? "summarized";
				}
				thinking = adaptive;
				if (effort && effort !== "adaptive") outputConfigEffort = effort;
			} else {
				thinking = {
					type: "enabled",
					budget_tokens: thinkingOptions.thinkingBudgetTokens || 1024,
					display: thinkingOptions.thinkingDisplay ?? "summarized",
				};
				if (mode === "anthropic-budget-effort" && effort && effort !== "adaptive") outputConfigEffort = effort;
			}
		} else if (options?.thinkingEnabled === false) {
			const compat = model.compat;
			if (
				model.thinking?.mode === "anthropic-adaptive" &&
				!compat.disableAdaptiveThinking &&
				!usesAdaptiveThinkingTagOnly(model)
			) {
				outputConfigEffort = "low";
			} else {
				thinking = { type: "disabled" };
			}
		}
	}

	const shouldKeepThinkingContext =
		!options?.client &&
		!anthropicWire(model).rejectsContextManagement &&
		(thinking?.type === "adaptive" || thinking?.type === "enabled");
	const contextManagement = shouldKeepThinkingContext
		? { edits: [{ type: "clear_thinking_20251015" as const, keep: "all" as const }] }
		: undefined;

	const outputConfigEntries: AnthropicOutputConfig = {};
	if (outputConfigEffort) outputConfigEntries.effort = outputConfigEffort;
	if (options?.taskBudget) outputConfigEntries.task_budget = options.taskBudget;
	const outputConfig = Object.keys(outputConfigEntries).length ? outputConfigEntries : undefined;

	const modelMaxTokens = model.maxTokens ?? CLAUDE_CODE_MAX_OUTPUT_TOKENS;
	const maxOutputTokens = isOAuthToken ? Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, modelMaxTokens) : modelMaxTokens;

	const params: MessageCreateParamsStreaming = {
		model: options?.requestModelId ?? model.requestModelId ?? model.id,
		messages: convertAnthropicMessages(context.messages, effectiveModel, isOAuthToken, {
			serverSideFallbackEnabled: !!options?.fallbacks?.length,
		}),
		...(systemBlocks && { system: systemBlocks }),
		...(tools !== undefined && { tools }),
		...(metadata && { metadata }),
		max_tokens: Math.min(maxOutputTokens, options?.maxTokens || modelMaxTokens),
		...(thinking && { thinking }),
		...(contextManagement && { context_management: contextManagement }),
		...(outputConfig && { output_config: outputConfig }),
		...(options?.fallbacks?.length ? { fallbacks: options.fallbacks } : {}),
		stream: true,
	};

	const thinkingType = params.thinking?.type;
	const allowSamplingParams =
		model.compat.supportsSamplingParams && (thinkingType === undefined || thinkingType === "disabled");
	if (allowSamplingParams && options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (allowSamplingParams && options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (allowSamplingParams && options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		if (seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX && !warnedStopSequencesTrim) {
			warnedStopSequencesTrim = true;
			logger.warn("anthropic: stop_sequences exceeds 4; extra entries dropped", {
				received: seqs.length,
				kept: ANTHROPIC_STOP_SEQUENCES_MAX,
			});
		}
		params.stop_sequences =
			seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX ? seqs.slice(0, ANTHROPIC_STOP_SEQUENCES_MAX) : seqs;
	}

	if (realizesPriorityServiceTier(options?.serviceTier, model)) {
		params.speed = "fast";
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: encodeAnthropicToolName(
					options.toolChoice.name,
					isOAuthToken,
					model.compat.escapeBuiltinToolNames,
					useUmansGatewayWebSearch,
				),
			};
		}
		const choiceType = params.tool_choice?.type;
		if ((choiceType === "any" || choiceType === "tool") && !model.compat.supportsForcedToolChoice) {
			params.tool_choice = { type: "auto" };
		}
	}

	disableThinkingIfToolChoiceForced(params);
	ensureMaxTokensForThinking(params, maxOutputTokens);
	applyPromptCaching(params, cacheControl);
	enforceCacheControlLimit(params, 4);
	normalizeCacheControlTtlOrdering(params);

	return params;
}

function isEmptyToolResultWireContent(content: AnthropicToolResultContent): boolean {
	if (typeof content === "string") {
		return content.trim().length === 0;
	}
	return content.length === 0;
}

function ensureErrorToolResultWireContent(
	content: AnthropicToolResultContent,
	isError: boolean | undefined,
): AnthropicToolResultContent {
	if (!isError || !isEmptyToolResultWireContent(content)) {
		return content;
	}
	return typeof content === "string"
		? EMPTY_ERROR_TOOL_RESULT_TEXT
		: [{ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT }];
}

function buildToolResultBlock(
	model: Model<"anthropic-messages">,
	msg: ToolResultMessage,
	hoistedImages: ContentBlockParam[],
): ContentBlockParam {
	let content = convertContentBlocks(msg.content, model.input.includes("image"));
	if (msg.isError && typeof content !== "string" && content.some(block => block.type === "image")) {
		for (const block of content) {
			if (block.type === "image") hoistedImages.push(block);
		}
		content = content.filter(block => block.type === "text");
	}
	content = ensureErrorToolResultWireContent(content, msg.isError);
	const block: ContentBlockParam = {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content,
		is_error: msg.isError,
	};
	if (model.compat.requiresToolResultId) {
		(block as unknown as Record<string, unknown>).id = msg.toolCallId;
	}
	return block;
}

export type AnthropicMessageParam = MessageParam;

function toWellFormedDeep(value: unknown): unknown {
	if (typeof value === "string") {
		const wellFormed = value.toWellFormed();
		return wellFormed === value ? value : wellFormed;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(entry => {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			return sanitized;
		});
		return changed ? next : value;
	}
	if (isRecord(value)) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			next[key] = sanitized;
		}
		return changed ? next : value;
	}
	return value;
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	opts?: { serverSideFallbackEnabled?: boolean },
): AnthropicMessageParam[] {
	const developerParamIndices: number[] = [];
	const params: AnthropicMessageParam[] = [];

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user" || msg.role === "developer") {
			if (!msg.content) continue;

			let content: string | ContentBlockParam[];
			if (typeof msg.content === "string") {
				if (msg.content.trim().length === 0) continue;
				content = msg.content.toWellFormed();
			} else {
				const contentBlocks = convertContentBlocks(msg.content, model.input.includes("image"));
				if (typeof contentBlocks === "string") {
					if (contentBlocks.trim().length === 0) continue;
					content = contentBlocks;
				} else {
					if (contentBlocks.length === 0) continue;
					content = contentBlocks;
				}
			}
			if (msg.role === "developer") developerParamIndices.push(params.length);
			params.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						if (model.compat.replayUnsignedThinking) {
							blocks.push({
								type: "thinking",
								thinking: block.thinking.toWellFormed(),
								signature: "",
							});
						} else {
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
						}
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "fallback") {
					if (!opts?.serverSideFallbackEnabled || !model.compat.officialEndpoint) continue;
					blocks.push({
						type: "fallback",
						from: block.from,
						to: block.to,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: encodeAnthropicToolName(block.name, isOAuthToken, model.compat.escapeBuiltinToolNames),
						input: toWellFormedDeep(block.arguments ?? {}),
					});
				}
			}
			let sawToolUse = false;
			let needsPartition = false;
			for (const block of blocks) {
				if (block.type === "tool_use") {
					sawToolUse = true;
				} else if (sawToolUse) {
					needsPartition = true;
					break;
				}
			}
			if (needsPartition) {
				const nonToolUse: ContentBlockParam[] = [];
				const toolUse: ContentBlockParam[] = [];
				for (const block of blocks) {
					if (block.type === "tool_use") toolUse.push(block);
					else nonToolUse.push(block);
				}
				blocks.length = 0;
				for (let bi = 0; bi < nonToolUse.length; bi++) blocks.push(nonToolUse[bi]!);
				for (let bi = 0; bi < toolUse.length; bi++) blocks.push(toolUse[bi]!);
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			const toolResults: ContentBlockParam[] = [];

			const hoistedImages: ContentBlockParam[] = [];

			toolResults.push(buildToolResultBlock(model, msg, hoistedImages));

			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push(buildToolResultBlock(model, nextMsg, hoistedImages));
				j++;
			}

			i = j - 1;

			if (hoistedImages.length > 0) {
				toolResults.push(
					{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
					...hoistedImages,
				);
			}

			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (developerParamIndices.length > 0 && model.compat.supportsMidConversationSystem) {
		for (const idx of developerParamIndices) {
			const followsUser = idx > 0 && params[idx - 1]?.role === "user";
			const next = params[idx + 1];
			const lastOrBeforeAssistant = idx === params.length - 1 || next?.role === "assistant";

			const content = params[idx].content;
			const textOnly = typeof content === "string" || content.every(block => block.type === "text");
			if (followsUser && lastOrBeforeAssistant && textOnly) {
				params[idx] = { role: "system", content };
			}
		}
	}
	for (let i = params.length - 1; i > 0; i--) {
		if (params[i].role === "assistant" && params[i - 1]?.role === "assistant") {
			params.splice(i, 0, { role: "user", content: "Continue." });
		}
	}
	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	disableStrictTools = false,
	supportsEagerToolInputStreaming = true,
	escapeBuiltinToolNames = false,
	useUmansGatewayWebSearch = false,
): AnthropicWireTool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		const baseTool = {
			name: encodeAnthropicToolName(tool.name, isOAuthToken, escapeBuiltinToolNames, useUmansGatewayWebSearch),
			description: tool.description || "",
			input_schema: plan.inputSchema,
		};
		return {
			...baseTool,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(plan.strict ? { strict: true } : {}),
		};
	});
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // A caller-supplied stop_sequences entry matched; the turn completed normally.
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			reportAnthropicEnvelopeAnomaly(`unhandled stop reason: ${reason}`);
			return "stop";
	}
}
