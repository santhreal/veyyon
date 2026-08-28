import { isKimiModelId } from "@veyyon/catalog/identity";
import { calculateCost, emptyCost } from "@veyyon/catalog/models";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import { $env } from "@veyyon/utils/env";
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	MessageAttribution,
	Model,
	RawSseEvent,
	StopReason,
	StreamFunction,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import {
	clearStreamingPartialJson,
	isDemotedThinking,
	kStreamingLastParseLen,
	setStreamingPartialJson,
} from "../utils/block-symbols";
import {
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	withEmptyCompletionRetry,
} from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	iterateWithTerminalGrace,
} from "../utils/idle-iterator";
import { OpenAIHttpError, type OpenAIStreamHandle, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { adaptSchemaForStrict, NO_STRICT, normalizeSchemaForMoonshot, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../utils/sse-debug";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import type { CacheControlEphemeral } from "./anthropic-wire";
import type {
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
} from "./openai-chat-wire";
import {
	type AppliedToolStrictMode,
	type BuiltOpenAICompletionTools,
	firstPositiveNumber,
	getOpenAICompletionsProviderSessionState,
	getTrailingPartialDeepseekToken,
	hasPositiveCacheReadTokenField,
	hasToolHistory,
	isOpenAICompletionsProgressChunk,
	mergeStreamingArgumentObjects,
	normalizeMistralToolId,
	normalizeStreamingContentText,
	OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
	OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,
	type OpenAICompletionsAssistantMessageParam,
	type OpenAICompletionsChoiceUsage,
	type OpenAICompletionsCompletionTokenDetails,
	type OpenAICompletionsDeltaWithReasoningDetails,
	type OpenAICompletionsOptions,
	type OpenAICompletionsPromptTokenDetails,
	type OpenAICompletionsProviderSessionState,
	type OpenAICompletionsReasoningField,
	type OpenAICompletionsToolMessageParam,
	type OpenAICompletionsUsageLike,
	type OpenAIStreamBlock,
	type ProviderAttributedChatCompletionChunk,
	resolveOpenAICompletionsModelId,
	serializeToolArguments,
	stripDeepseekSpecialTokens,
	type ToolCallStreamBlock,
	type ToolStrictModeOverride,
} from "./openai-completions-helpers";
import {
	applyOpenAIReasoningEffortFallback,
	createOpenAIReasoningEffortFallbackKey,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import {
	applyChatCompletionsCompatPolicy,
	applyChatCompletionsToolStream,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyOpenAIServiceTier,
	calculateOpenAIUsageAccounting,
	createInitialResponsesAssistantMessage,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	type OpenAICompatPolicy,
	type OpenAICompletionsParams,
	type OpenAIRequestSetup,
	type OpenAIStrictToolsScope,
	parseAzureDeploymentNameMap,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	resolveZaiReasoningOutputClamp,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";
import {
	isDashscopeCompatibleModeTextOnlyQwen,
	joinTextWithImagePlaceholder,
	NON_VISION_IMAGE_PLACEHOLDER,
} from "./vision-guard";

export {
	isOpenAICompletionsProgressChunk,
	type OpenAICompletionsOptions,
	serializeToolArguments,
} from "./openai-completions-helpers";
export { applyOpenRouterRoutingVariant } from "./openai-shared";

interface OpenAICompletionsStreamContext {
	model: Model<"openai-completions">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	policy: OpenAICompatPolicy;
	firstTokenTime?: number;
	currentBlock?: OpenAIStreamBlock;
	pendingToolCallBlocks: ToolCallStreamBlock[];
	toolCallBlockByIndex: Map<number, ToolCallStreamBlock>;
	unkeyedBatchBlocks: (ToolCallStreamBlock | undefined)[];
	lastCumulativeReasoningBySignature: Map<string, string>;
	deepseekStripBuffer: string;
	stripDeepseekChatTemplateTokens: boolean;
	streamMarkupHealing?: StreamMarkupHealing;
	explicitReasoningDeltasMayBeCumulative?: boolean;
	suppressHealedThinking: boolean;
	healedToolCallEmitted: boolean;
	streamFinishedAt?: number;
	sawUsagePayload: boolean;
	awaitTrailingUsageDetails: boolean;
	premiumRequestsTotal?: number;
}

function getOpenAICompletionsBlockIndex(
	ctx: OpenAICompletionsStreamContext,
	block: OpenAIStreamBlock | undefined,
): number {
	if (!block) return Math.max(0, ctx.output.content.length - 1);
	return ctx.output.content.indexOf(block);
}

function hasCompleteToolCallBatch(ctx: OpenAICompletionsStreamContext): boolean {
	const toolCalls = ctx.output.content.filter((block): block is ToolCallStreamBlock => block.type === "toolCall");
	if (toolCalls.length === 0) return false;
	return toolCalls.every(block => {
		if (!block.id || !block.name) return false;
		const argumentsValue =
			block.partialArgs === undefined
				? block.arguments
				: typeof block.partialArgs === "string"
					? tryParseJson(block.partialArgs)
					: block.partialArgs;
		return isRecord(argumentsValue);
	});
}

function finishOpenAICompletionsToolCallBlock(ctx: OpenAICompletionsStreamContext, block: ToolCallStreamBlock): void {
	if (block.partialArgs === undefined) return;
	const contentIndex = getOpenAICompletionsBlockIndex(ctx, block);
	if (contentIndex < 0) return;
	if (typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)) {
		const fullJson = JSON.stringify(block.partialArgs);
		if (fullJson.length > 0 && fullJson !== "{}") {
			ctx.stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: ctx.output });
		}
	}
	block.arguments = typeof block.partialArgs === "string" ? parseStreamingJson(block.partialArgs) : block.partialArgs;
	delete block.partialArgs;
	clearStreamingPartialJson(block);
	if (block.streamIndex !== undefined) {
		ctx.toolCallBlockByIndex.delete(block.streamIndex);
		delete block.streamIndex;
	}
	const pendingIndex = ctx.pendingToolCallBlocks.indexOf(block);
	if (pendingIndex >= 0) ctx.pendingToolCallBlocks.splice(pendingIndex, 1);
	for (let index = 0; index < ctx.unkeyedBatchBlocks.length; index++) {
		if (ctx.unkeyedBatchBlocks[index] === block) ctx.unkeyedBatchBlocks[index] = undefined;
	}
	ctx.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: ctx.output });
}

function finishOpenAICompletionsCurrentBlock(
	ctx: OpenAICompletionsStreamContext,
	block: OpenAIStreamBlock | undefined,
): void {
	if (!block) return;
	const contentIndex = getOpenAICompletionsBlockIndex(ctx, block);
	if (contentIndex < 0) return;
	if (block.type === "text") {
		ctx.stream.push({ type: "text_end", contentIndex, content: block.text, partial: ctx.output });
		return;
	}
	if (block.type === "thinking") {
		ctx.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: ctx.output });
		return;
	}
	finishOpenAICompletionsToolCallBlock(ctx, block);
}

function finishOpenAICompletionsPendingToolCallBlocks(ctx: OpenAICompletionsStreamContext): void {
	for (const block of ctx.pendingToolCallBlocks.slice()) {
		finishOpenAICompletionsToolCallBlock(ctx, block);
	}
}

function appendOpenAICompletionsTextDelta(ctx: OpenAICompletionsStreamContext, text: string): void {
	if (!text) return;
	if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
	if (ctx.currentBlock?.type !== "text") {
		if (ctx.currentBlock?.type !== "toolCall") finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		ctx.currentBlock = { type: "text", text: "" };
		ctx.output.content.push(ctx.currentBlock);
		ctx.stream.push({
			type: "text_start",
			contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
			partial: ctx.output,
		});
	}
	ctx.currentBlock.text += text;
	ctx.stream.push({
		type: "text_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
		delta: text,
		partial: ctx.output,
	});
}

function appendOpenAICompletionsThinkingDelta(
	ctx: OpenAICompletionsStreamContext,
	thinking: string,
	signature?: string,
	source: "delta" | "cumulative" = "delta",
): void {
	if (!thinking) return;
	let emittedThinking = thinking;
	if (source === "cumulative") {
		const key = signature ?? "";
		const lastSnapshot = ctx.lastCumulativeReasoningBySignature.get(key) ?? "";
		if (thinking.startsWith(lastSnapshot)) {
			emittedThinking = thinking.slice(lastSnapshot.length);
		}
		ctx.lastCumulativeReasoningBySignature.set(key, thinking);
		if (!emittedThinking) return;
	}
	if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
	if (
		ctx.currentBlock?.type !== "thinking" ||
		(signature !== undefined && ctx.currentBlock.thinkingSignature !== signature)
	) {
		if (ctx.currentBlock?.type !== "toolCall") finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		ctx.currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
		ctx.output.content.push(ctx.currentBlock);
		ctx.stream.push({
			type: "thinking_start",
			contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
			partial: ctx.output,
		});
	}
	if (signature !== undefined && !ctx.currentBlock.thinkingSignature) {
		ctx.currentBlock.thinkingSignature = signature;
	}
	ctx.currentBlock.thinking += emittedThinking;
	ctx.stream.push({
		type: "thinking_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, ctx.currentBlock),
		delta: emittedThinking,
		partial: ctx.output,
	});
}

function flushDeepseekStripBuffer(ctx: OpenAICompletionsStreamContext, final: boolean): void {
	if (ctx.deepseekStripBuffer.length === 0) return;
	let flushable: string;
	if (final) {
		flushable = ctx.deepseekStripBuffer;
		ctx.deepseekStripBuffer = "";
	} else {
		const trailing = getTrailingPartialDeepseekToken(ctx.deepseekStripBuffer);
		flushable = ctx.deepseekStripBuffer.slice(0, ctx.deepseekStripBuffer.length - trailing.length);
		ctx.deepseekStripBuffer = trailing;
	}
	const stripped = stripDeepseekSpecialTokens(flushable);
	if (stripped && (stripped === flushable || stripped.trim().length > 0))
		appendOpenAICompletionsTextDelta(ctx, stripped);
}

function appendOpenAICompletionsProcessedText(ctx: OpenAICompletionsStreamContext, processedText: string): void {
	if (processedText.length === 0) return;
	if (ctx.stripDeepseekChatTemplateTokens) {
		ctx.deepseekStripBuffer += processedText;
		flushDeepseekStripBuffer(ctx, false);
	} else {
		appendOpenAICompletionsTextDelta(ctx, processedText);
	}
}

function emitHealedToolCall(ctx: OpenAICompletionsStreamContext, call: HealedToolCall): void {
	finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
	const block: ToolCall & { partialArgs: string } = {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: {},
		partialArgs: call.arguments,
	};
	block.arguments = parseStreamingJson(call.arguments);
	ctx.currentBlock = block;
	ctx.output.content.push(block);
	ctx.stream.push({
		type: "toolcall_start",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
		partial: ctx.output,
	});
	ctx.stream.push({
		type: "toolcall_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
		delta: call.arguments,
		partial: ctx.output,
	});
	finishOpenAICompletionsCurrentBlock(ctx, block);
	ctx.currentBlock = undefined;
	ctx.healedToolCallEmitted = true;
}

function emitHealingEvent(ctx: OpenAICompletionsStreamContext, event: StreamMarkupHealingEvent): void {
	if (event.type === "text") {
		appendOpenAICompletionsProcessedText(ctx, event.text);
	} else if (event.type === "thinking") {
		if (!ctx.suppressHealedThinking) appendOpenAICompletionsThinkingDelta(ctx, event.thinking);
	} else {
		emitHealedToolCall(ctx, event.call);
	}
}

function processOpenAICompletionsToolCallDelta(
	ctx: OpenAICompletionsStreamContext,
	toolCall: NonNullable<ChatCompletionChunk.Choice["delta"]["tool_calls"]>[number],
	toolCallOffset: number,
	toolCallsLength: number,
): void {
	const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
	const incomingName = toolCall.function?.name || "";
	const unkeyedBatchedArrayEntry = toolCallsLength > 1 && streamIndex === undefined && !toolCall.id;
	let block = streamIndex !== undefined ? ctx.toolCallBlockByIndex.get(streamIndex) : undefined;
	if (!block && toolCall.id) {
		block = ctx.pendingToolCallBlocks.find(candidate => candidate.id === toolCall.id);
	}
	if (!block && unkeyedBatchedArrayEntry) {
		const offsetBlock = ctx.unkeyedBatchBlocks[toolCallOffset];
		if (offsetBlock && offsetBlock.partialArgs !== undefined) block = offsetBlock;
	}
	if (
		!block &&
		!unkeyedBatchedArrayEntry &&
		ctx.currentBlock?.type === "toolCall" &&
		(!toolCall.id || ctx.currentBlock.id === toolCall.id)
	) {
		block = ctx.currentBlock;
	}

	if (!block) {
		if (ctx.currentBlock?.type !== "toolCall") {
			finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		}
		block = {
			type: "toolCall",
			id: toolCall.id || "",
			name: incomingName,
			arguments: {},
			partialArgs: "",
			streamIndex,
		};
		if (streamIndex !== undefined) ctx.toolCallBlockByIndex.set(streamIndex, block);
		ctx.pendingToolCallBlocks.push(block);
		ctx.currentBlock = block;
		ctx.output.content.push(block);
		ctx.stream.push({
			type: "toolcall_start",
			contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
			partial: ctx.output,
		});
		if (unkeyedBatchedArrayEntry) ctx.unkeyedBatchBlocks[toolCallOffset] = block;
	} else {
		if (ctx.currentBlock !== block && ctx.currentBlock && ctx.currentBlock.type !== "toolCall") {
			finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		}
		ctx.currentBlock = block;
		if (streamIndex !== undefined && block.streamIndex === undefined) {
			block.streamIndex = streamIndex;
			ctx.toolCallBlockByIndex.set(streamIndex, block);
		}
	}

	if (toolCall.id) block.id = toolCall.id;
	if (incomingName) block.name = incomingName;
	let delta = "";
	const rawArgs = toolCall.function?.arguments as string | Record<string, unknown> | undefined;
	if (typeof rawArgs === "string") {
		if (rawArgs.length > 0) {
			delta = rawArgs;
			const prev = typeof block.partialArgs === "string" ? block.partialArgs : "";
			block.partialArgs = prev + rawArgs;
			setStreamingPartialJson(block, block.partialArgs);
			const throttled = parseStreamingJsonThrottled(block.partialArgs, block[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				block.arguments = throttled.value;
				block[kStreamingLastParseLen] = throttled.parsedLen;
			}
		}
	} else if (isRecord(rawArgs)) {
		const prev =
			block.partialArgs !== null && typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)
				? (block.partialArgs as Record<string, unknown>)
				: undefined;
		const merged = mergeStreamingArgumentObjects(prev, rawArgs);
		block.partialArgs = merged;
		block.arguments = merged;
	}
	ctx.stream.push({
		type: "toolcall_delta",
		contentIndex: getOpenAICompletionsBlockIndex(ctx, block),
		delta,
		partial: ctx.output,
	});
}

function processOpenAICompletionsChunk(chunk: ChatCompletionChunk, ctx: OpenAICompletionsStreamContext): boolean {
	if (!chunk || typeof chunk !== "object") return true;

	ctx.output.responseId ||= chunk.id;

	if (!ctx.output.upstreamProvider) {
		const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
		ctx.output.upstreamProvider =
			typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
	}

	const applyUsage = (rawUsage: object) => {
		ctx.output.usage = parseChunkUsage(rawUsage, ctx.model, ctx.premiumRequestsTotal);
		ctx.sawUsagePayload = true;
		ctx.awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
	};

	if (chunk.usage) applyUsage(chunk.usage);

	const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
	if (!choice) {
		if (ctx.sawUsagePayload && hasCompleteToolCallBatch(ctx)) {
			ctx.output.stopReason = "toolUse";
			ctx.streamFinishedAt ??= Date.now();
			return false;
		}
		if (ctx.streamFinishedAt !== undefined && ctx.sawUsagePayload) return false;
		return true;
	}

	if (!chunk.usage) {
		const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
		if (typeof choiceUsage === "object" && choiceUsage !== null) {
			applyUsage(choiceUsage);
		}
	}

	if (choice.finish_reason) {
		const finishReasonResult = mapStopReason(choice.finish_reason);
		ctx.output.stopReason = finishReasonResult.stopReason;
		if (finishReasonResult.errorMessage) {
			ctx.output.errorMessage = finishReasonResult.errorMessage;
		}
		ctx.streamFinishedAt ??= Date.now();
	}

	if (choice.delta) {
		processOpenAICompletionsDelta(choice.delta, ctx);
	}

	if (ctx.streamFinishedAt !== undefined && ctx.sawUsagePayload && !ctx.awaitTrailingUsageDetails) return false;
	return true;
}

function processOpenAICompletionsDelta(
	delta: ChatCompletionChunk.Choice["delta"],
	ctx: OpenAICompletionsStreamContext,
): boolean {
	const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
	const deltaRecord = delta as Record<string, unknown>;
	let foundReasoningField: string | undefined;
	let foundReasoningDelta = "";
	for (const field of reasoningFields) {
		const reasoningDelta = deltaRecord[field];
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			foundReasoningField = field;
			foundReasoningDelta = reasoningDelta;
			break;
		}
	}

	if (foundReasoningField) {
		appendOpenAICompletionsThinkingDelta(
			ctx,
			foundReasoningDelta,
			foundReasoningField,
			ctx.explicitReasoningDeltasMayBeCumulative ? "cumulative" : "delta",
		);
		ctx.suppressHealedThinking = true;
	}

	const normalizedDeltaText = normalizeStreamingContentText(delta.content);
	if (normalizedDeltaText.length > 0) {
		if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
		const hasStructuredToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;

		if (ctx.streamMarkupHealing) {
			const healingEvents = hasStructuredToolCalls
				? ctx.streamMarkupHealing.feedEventsWithoutCalls(normalizedDeltaText)
				: ctx.streamMarkupHealing.feedEvents(normalizedDeltaText);
			for (const event of healingEvents) {
				emitHealingEvent(ctx, event);
			}
		} else {
			appendOpenAICompletionsProcessedText(ctx, normalizedDeltaText);
		}
	}

	if (delta.tool_calls && delta.tool_calls.length > 0) {
		const toolCalls = delta.tool_calls;
		for (let toolCallOffset = 0; toolCallOffset < toolCalls.length; toolCallOffset++) {
			const toolCall = toolCalls[toolCallOffset]!;
			processOpenAICompletionsToolCallDelta(ctx, toolCall, toolCallOffset, toolCalls.length);
		}
	}

	const reasoningDetails = (delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
	if (Array.isArray(reasoningDetails)) {
		for (const detail of reasoningDetails) {
			if (!detail || typeof detail !== "object") continue;
			const detailObject = detail as { type?: unknown; id?: unknown; data?: unknown };
			if (detailObject.type === "reasoning.encrypted" && detailObject.id && detailObject.data) {
				const matchingToolCall = ctx.output.content.find(b => b.type === "toolCall" && b.id === detailObject.id) as
					| ToolCall
					| undefined;
				if (matchingToolCall) {
					matchingToolCall.thoughtSignature = JSON.stringify(detailObject);
				}
			}
		}
	}
	if (ctx.streamFinishedAt !== undefined && ctx.sawUsagePayload && !ctx.awaitTrailingUsageDetails) return false;
	return true;
}

function finalizeOpenAICompletionsStream(ctx: OpenAICompletionsStreamContext): void {
	if (ctx.streamFinishedAt === undefined) {
		const stopReason = stopReasonForTerminallessEof(ctx.output.content, hasCompleteToolCallBatch(ctx));
		if (stopReason === undefined) {
			throw new AIError.ProviderResponseError(
				"OpenAI completions stream closed before a terminal finish reason was received",
				{ provider: ctx.model.provider, kind: "incomplete-stream" },
			);
		}
		ctx.output.stopReason = stopReason;
		ctx.streamFinishedAt = Date.now();
	}

	if (ctx.streamMarkupHealing) {
		for (const event of ctx.streamMarkupHealing.flushEvents()) {
			emitHealingEvent(ctx, event);
		}
		const calls = ctx.streamMarkupHealing.drainCompleted();
		for (const call of calls) emitHealedToolCall(ctx, call);
		if (ctx.healedToolCallEmitted && ctx.output.stopReason === "stop") {
			ctx.output.stopReason = "toolUse";
		}
	}

	if (ctx.stripDeepseekChatTemplateTokens) {
		flushDeepseekStripBuffer(ctx, true);
	}

	if (ctx.currentBlock?.type === "toolCall") {
		finishOpenAICompletionsPendingToolCallBlocks(ctx);
	} else {
		finishOpenAICompletionsCurrentBlock(ctx, ctx.currentBlock);
		finishOpenAICompletionsPendingToolCallBlocks(ctx);
	}

	if (ctx.output.stopReason === "stop" && ctx.output.content.some(b => b.type === "toolCall")) {
		ctx.output.stopReason = "toolUse";
	}

	if (
		ctx.policy.stream.emptyLengthFinishIsContextError &&
		ctx.output.stopReason === "length" &&
		!hasVisibleAssistantContent(ctx.output)
	) {
		ctx.output.stopReason = "error";
		ctx.output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
	}

	if (ctx.output.stopReason === "aborted") {
		throw new AIError.RequestAbortError();
	}
	if (ctx.output.stopReason === "error") {
		throw new AIError.ProviderResponseError(ctx.output.errorMessage || "Provider returned an error stop reason", {
			provider: ctx.model.provider,
			kind: "runtime",
		});
	}
	ctx.output.errorMessage = undefined;
}

async function resolveInitialCompletionsStream(
	createCompletionsStream: (
		toolStrictModeOverride?: ToolStrictModeOverride,
		captureOnly?: boolean,
		currentDisableStrict?: boolean,
	) => Promise<OpenAIStreamHandle<ChatCompletionChunk>>,
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	requestSignal: AbortSignal,
	state: {
		appliedStrictTools: boolean;
		requestReasoningEffortFallbacks: Map<string, OpenAIReasoningEffortFallback>;
		attemptedReasoningEffortFallbacks: Set<string>;
		activeReasoningEffortFallbackKey?: string;
		activeRequestParams?: OpenAICompletionsParams;
		providerSessionState?: OpenAICompletionsProviderSessionState;
		strictToolsScope: OpenAIStrictToolsScope;
		disableStrictTools: boolean;
	},
): Promise<{ openaiHandle: OpenAIStreamHandle<ChatCompletionChunk>; disableStrictTools: boolean }> {
	if (requestSignal.aborted) await createCompletionsStream(undefined, true);
	try {
		const openaiHandle = await callWithCopilotModelRetry(() => createCompletionsStream(), {
			provider: model.provider,
			signal: requestSignal,
		});
		return { openaiHandle, disableStrictTools: state.disableStrictTools };
	} catch (error) {
		const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
		const reasoningEffortFallback =
			state.activeReasoningEffortFallbackKey && state.activeRequestParams && !requestSignal.aborted
				? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, state.activeRequestParams, {
						explicitDisable: options?.disableReasoning === true && options.reasoning === undefined,
					})
				: undefined;
		if (reasoningEffortFallback !== undefined && state.activeReasoningEffortFallbackKey) {
			const retryMarker = `${state.activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
			if (state.attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
			state.attemptedReasoningEffortFallbacks.add(retryMarker);
			state.requestReasoningEffortFallbacks.set(state.activeReasoningEffortFallbackKey, reasoningEffortFallback);
			const openaiHandle = await createCompletionsStream(undefined, false, state.disableStrictTools);
			rememberOpenAIReasoningEffortFallback(
				state.providerSessionState,
				state.activeReasoningEffortFallbackKey,
				reasoningEffortFallback,
			);
			return { openaiHandle, disableStrictTools: state.disableStrictTools };
		}
		if (
			isOpenRouterAnthropicModel(model) &&
			!state.disableStrictTools &&
			isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
		) {
			disableStrictToolsForScope(state.providerSessionState, state.strictToolsScope);
			state.disableStrictTools = true;
			const openaiHandle = await createCompletionsStream("none", false, true);
			return { openaiHandle, disableStrictTools: true };
		}
		if (!shouldRetryWithoutStrictTools(error, capturedErrorResponse, state.appliedStrictTools, context.tools)) {
			throw error;
		}
		disableStrictToolsForScope(state.providerSessionState, state.strictToolsScope);
		state.disableStrictTools = true;
		const openaiHandle = await createCompletionsStream("none", false, true);
		return { openaiHandle, disableStrictTools: true };
	}
}

const streamOpenAICompletionsOnce = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const policy = resolveOpenAICompatForRequest(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let wireBodyJson: string | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const modelSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;
		const rawSseObserver = modelSseObserver
			? (event: RawSseEvent) => {
					resolveOpenAiSseEventName(event);
					notifyRawSseEvent(modelSseObserver, event);
				}
			: undefined;
		let finishOpenBlocksOnError: () => void = () => {};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutFallbackMs = model.compat.streamIdleTimeoutMs;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const { copilotPremiumRequests, baseUrl, headers, query, requestHeaders } = createRequestSetup(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				getOpenAIPromptCacheKey(options),
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			let disableStrictTools = isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
			const state = {
				appliedStrictTools: false,
				requestReasoningEffortFallbacks: new Map<string, OpenAIReasoningEffortFallback>(),
				attemptedReasoningEffortFallbacks: new Set<string>(),
				activeReasoningEffortFallbackKey: undefined as string | undefined,
				activeRequestParams: undefined as OpenAICompletionsParams | undefined,
				providerSessionState,
				strictToolsScope,
				disableStrictTools,
			};
			const trimmedBaseUrl = trimTrailingSlashes(baseUrl);
			const completionsUrl = query
				? `${trimmedBaseUrl}/chat/completions?${new URLSearchParams(query)}`
				: `${trimmedBaseUrl}/chat/completions`;

			const createCompletionsStream = async (
				toolStrictModeOverride?: ToolStrictModeOverride,
				captureOnly = false,
				currentDisableStrict = state.disableStrictTools,
			) => {
				const effectiveToolStrictModeOverride = currentDisableStrict ? "none" : toolStrictModeOverride;
				const { params, strictToolsApplied } = buildParams(
					model,
					context,
					options,
					effectiveToolStrictModeOverride,
				);
				state.appliedStrictTools = strictToolsApplied;
				const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
					"chat-completions",
					trimmedBaseUrl,
					params.model,
				);
				const requestReasoningEffortFallback = state.requestReasoningEffortFallbacks.has(reasoningEffortFallbackKey)
					? state.requestReasoningEffortFallbacks.get(reasoningEffortFallbackKey)
					: getOpenAIReasoningEffortFallback(providerSessionState, reasoningEffortFallbackKey);
				if (requestReasoningEffortFallback !== undefined) {
					applyOpenAIReasoningEffortFallback(params, requestReasoningEffortFallback);
				}
				state.activeReasoningEffortFallbackKey = reasoningEffortFallbackKey;
				const prepareRequest = async (): Promise<RequestInit> => {
					const bodyJson = JSON.stringify(params);
					let wireParams = params;
					if (options?.onPayload) {
						const attemptParams = JSON.parse(bodyJson) as OpenAICompletionsParams;
						const replacementPayload = await options.onPayload(attemptParams, model);
						wireParams =
							replacementPayload !== undefined && replacementPayload !== attemptParams
								? (replacementPayload as OpenAICompletionsParams)
								: attemptParams;
					}
					state.activeRequestParams = wireParams;
					const body = wireParams === params ? bodyJson : JSON.stringify(wireParams);
					rawRequestDump = {
						provider: model.provider,
						api: output.api,
						model: model.id,
						method: "POST",
						url: completionsUrl,
						headers: requestHeaders,
					};
					wireBodyJson = body;
					return { body };
				};
				if (captureOnly) {
					await prepareRequest();
					throw new AIError.RequestAbortError();
				}
				let requestTimeout: NodeJS.Timeout | undefined;
				if (requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					const headersWithTimeout = { ...headers };
					if (requestTimeoutMs !== undefined) {
						headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					const handle = await postOpenAIStream<ChatCompletionChunk>({
						url: completionsUrl,
						headers: headersWithTimeout,
						body: undefined,
						signal: requestSignal,
						fetch: options?.fetch,
						prepareInit: prepareRequest,
						maxRetryDelayMs: options?.maxRetryDelayMs,
						onSseEvent: rawSseObserver,
					});
					return handle;
				} finally {
					clearTimeout(requestTimeout);
				}
			};

			const initialStreamResult = await resolveInitialCompletionsStream(
				createCompletionsStream,
				model,
				context,
				options,
				requestSignal,
				state,
			);
			const openaiHandle = initialStreamResult.openaiHandle;
			disableStrictTools = initialStreamResult.disableStrictTools;
			await notifyProviderResponse(options, openaiHandle.response, model, openaiHandle.requestId);
			const openaiStream = openaiHandle.events;
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });

			const streamMarkupHealingPattern = policy.stream.markupHealingPattern;
			const streamMarkupHealing = streamMarkupHealingPattern
				? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
				: undefined;

			const streamCtx: OpenAICompletionsStreamContext = {
				model,
				output,
				stream,
				policy,
				firstTokenTime,
				pendingToolCallBlocks: [],
				toolCallBlockByIndex: new Map(),
				unkeyedBatchBlocks: [],
				lastCumulativeReasoningBySignature: new Map(),
				deepseekStripBuffer: "",
				stripDeepseekChatTemplateTokens: policy.stream.stripSpecialTokens === "deepseek",
				streamMarkupHealing,
				explicitReasoningDeltasMayBeCumulative: policy.stream.reasoningDeltasMayBeCumulative,
				suppressHealedThinking: false,
				healedToolCallEmitted: false,
				sawUsagePayload: false,
				awaitTrailingUsageDetails: false,
				premiumRequestsTotal,
			};

			finishOpenBlocksOnError = () => {
				if (streamCtx.currentBlock?.type !== "toolCall")
					finishOpenAICompletionsCurrentBlock(streamCtx, streamCtx.currentBlock);
				finishOpenAICompletionsPendingToolCallBlocks(streamCtx);
			};

			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAICompletionsProgressChunk,
			});
			const terminalAwareStream = iterateWithTerminalGrace(timedOpenaiStream, {
				finishedAtMs: () => streamCtx.streamFinishedAt,
				graceMs: OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,
				onGraceEnd: () => requestAbortController.abort(),
			});

			for await (const chunk of terminalAwareStream) {
				const shouldContinue = processOpenAICompletionsChunk(chunk, streamCtx);
				if (!shouldContinue) break;
			}

			firstTokenTime = streamCtx.firstTokenTime;

			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) throw localAbortReason;
			if (abortTracker.wasCallerAbort()) throw new AIError.RequestAbortError();

			finalizeOpenAICompletionsStream(streamCtx);

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			try {
				finishOpenBlocksOnError();
			} catch {}
			const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker,
				rawRequestDump: materializeDumpBody(rawRequestDump, wireBodyJson),
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAICompletionsOnce);

function createRequestSetup(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	promptCacheSessionId?: string,
): OpenAIRequestSetup & { baseUrl: string } {
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
	const deploymentName = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id) ?? model.id;
	const setup = resolveOpenAIRequestSetup(model, {
		apiKey,
		extraHeaders,
		initiatorOverride,
		promptCacheSessionId,
		messages: context.messages,
		defaultBaseUrl: "https://api.openai.com/v1",
		prependHeaders: model.provider === "kimi-code" ? getKimiCommonHeaders : undefined,
		alibabaCodingPlanAuth: true,
		azureChatCompletions: { apiVersion, deploymentName },
	});
	if (!setup.baseUrl) {
		throw new AIError.ConfigurationError("OpenAI request setup did not resolve a base URL");
	}
	return setup as OpenAIRequestSetup & { baseUrl: string };
}

function resolveOpenAICompatForRequest(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): OpenAICompatPolicy {
	return resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: mapToOpenAICompletionsToolChoice(options?.toolChoice),
	});
}

function dropOpenRouterKimiForcedToolReasoning(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
): void {
	if (
		policy.reasoning.disableReason === "forced-tool-choice" &&
		policy.reasoning.disableMode === "openrouter-enabled-false" &&
		policy.compat.isOpenRouterHost &&
		isKimiModelId(model.id)
	) {
		delete params.reasoning;
	}
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	toolStrictModeOverride?: ToolStrictModeOverride,
): {
	params: OpenAICompletionsParams;
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
} {
	const initialPolicy = resolveOpenAICompatForRequest(model, options);
	const initialCompat = initialPolicy.compat as ResolvedOpenAICompat;

	const requestModelId = resolveOpenAICompletionsModelId(model, options);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages: [],
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";
	let strictToolsApplied = false;

	if (initialCompat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (initialCompat.supportsStore) {
		params.store = false;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.minP !== undefined) {
		params.min_p = options.minP;
	}
	if (options?.presencePenalty !== undefined) {
		params.presence_penalty = options.presencePenalty;
	}
	if (options?.repetitionPenalty !== undefined) {
		params.repetition_penalty = options.repetitionPenalty;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	if (options?.frequencyPenalty !== undefined) {
		params.frequency_penalty = options.frequencyPenalty;
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, initialCompat, toolStrictModeOverride);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
		strictToolsApplied = builtTools.strictToolsApplied;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (options?.toolChoice && initialCompat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}
	if (
		typeof params.tool_choice === "object" &&
		params.tool_choice !== null &&
		!initialCompat.supportsNamedToolChoice
	) {
		params.tool_choice = "required";
	}
	if (isForcedToolChoice(params.tool_choice) && !initialCompat.supportsForcedToolChoice) {
		params.tool_choice = "auto";
	}

	if (params.tool_choice === "none" && (!Array.isArray(params.tools) || params.tools.length === 0)) {
		delete params.tool_choice;
	}

	const forcedToolName =
		typeof params.tool_choice === "object" && params.tool_choice !== null && "function" in params.tool_choice
			? params.tool_choice.function.name
			: undefined;
	if (
		forcedToolName !== undefined &&
		(!Array.isArray(params.tools) ||
			!params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName))
	) {
		delete params.tool_choice;
	}

	const finalPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
	});
	const compat = finalPolicy.compat as ResolvedOpenAICompat;
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages, resolveCacheRetention(options?.cacheRetention));
	params.messages = messages;
	const outputToken = resolveOpenAIOutputTokenParam({
		field: compat.maxTokensField,
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		routedUpstreamSelfCaps: compat.routedUpstreamSelfCaps,
		alwaysSendMaxTokens: compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveZaiReasoningOutputClamp(model, compat),
	});
	if (outputToken) {
		if (outputToken.field === "max_tokens") {
			params.max_tokens = outputToken.value;
		} else if (outputToken.field === "max_completion_tokens") {
			params.max_completion_tokens = outputToken.value;
		}
	}
	applyChatCompletionsToolStream(params, model, compat);

	applyChatCompletionsCompatPolicy(params, finalPolicy);
	dropOpenRouterKimiForcedToolReasoning(params, model, finalPolicy);

	applyOpenAIGatewayRouting(params, compat);

	applyOpenAIExtraBody(params, compat.extraBody, {
		dropThinkingWhenReasoningEffort: compat.dropThinkingWhenReasoningEffort,
	});

	return { params, toolStrictMode, strictToolsApplied };
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	const promptTokenDetails =
		typeof rawPromptTokenDetails === "object" && rawPromptTokenDetails !== null
			? (rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails)
			: undefined;
	const rawCompletionTokenDetails = usageLike.completion_tokens_details;
	const completionTokenDetails =
		typeof rawCompletionTokenDetails === "object" && rawCompletionTokenDetails !== null
			? (rawCompletionTokenDetails as OpenAICompletionsCompletionTokenDetails)
			: undefined;
	const completionTokens = usageLike.completion_tokens;
	const promptTokens = usageLike.prompt_tokens;
	const cachedTokens = usageLike.cached_tokens;
	const promptCacheHitTokens = usageLike.prompt_cache_hit_tokens;
	const promptCacheMissTokens = usageLike.prompt_cache_miss_tokens;
	const promptTokenCachedTokens = promptTokenDetails?.cached_tokens;
	const completionReasoningTokens = completionTokenDetails?.reasoning_tokens;
	const cacheWriteTokens = promptTokenDetails?.cache_write_tokens;
	const outputTokens = typeof completionTokens === "number" ? completionTokens : 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
		outputTokens,
		cachedTokens: firstPositiveNumber(cachedTokens, promptCacheHitTokens, promptTokenCachedTokens),
		reasoningTokens: typeof completionReasoningTokens === "number" ? completionReasoningTokens : 0,
		cacheWriteOpenRouter: typeof cacheWriteTokens === "number" ? cacheWriteTokens : undefined,
		cacheWriteDeepSeek: typeof promptCacheMissTokens === "number" ? promptCacheMissTokens : undefined,
		hasDeepSeekCacheHitAndMiss: typeof promptCacheHitTokens === "number" && typeof promptCacheMissTokens === "number",
	});
	const usage: AssistantMessage["usage"] = {
		...accounting,
		cost: emptyCost(),
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
	};
	calculateCost(model, usage);
	return usage;
}

function maybeAddAnthropicCacheControl(
	compat: ResolvedOpenAICompat,
	messages: ChatCompletionMessageParam[],
	cacheRetention: CacheRetention,
): void {
	if (compat.cacheControlFormat !== "anthropic") return;
	if (cacheRetention === "none") return;
	const cacheControl: CacheControlEphemeral =
		cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			if (content.trim().length === 0) continue;
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { ...cacheControl } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text" && part.text.trim().length > 0) {
				Object.assign(part, { cache_control: { ...cacheControl } });
				return;
			}
		}
	}
}

function convertUserOrDeveloperMessage(
	msg: Extract<Message, { role: "user" | "developer" }>,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const devAsUser = !compat.supportsDeveloperRole;
	const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
	if (typeof msg.content === "string") {
		const text = msg.content.toWellFormed();
		if (text.trim().length === 0) return [];
		return [{ role, content: text }];
	}
	const supportsImages = model.input.includes("image") && !isDashscopeCompatibleModeTextOnlyQwen(model);
	const content: ChatCompletionContentPart[] = [];
	let omittedImages = false;
	for (const item of msg.content) {
		if (item.type === "text") {
			const text = item.text.toWellFormed();
			if (text.trim().length === 0) continue;
			content.push({ type: "text", text } satisfies ChatCompletionContentPartText);
		} else if (supportsImages) {
			content.push({
				type: "image_url",
				image_url: {
					url: `data:${item.mimeType};base64,${item.data}`,
					...(item.detail && item.detail !== "original" ? { detail: item.detail } : {}),
				},
			} satisfies ChatCompletionContentPartImage);
		} else {
			omittedImages = true;
		}
	}
	if (omittedImages) {
		content.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER } satisfies ChatCompletionContentPartText);
	}
	if (content.length === 0) return [];
	if (msg.role === "developer" && role === "developer" && !msg.content.some(item => item.type === "image")) {
		return [
			{
				role: "developer",
				content: content
					.filter((item): item is ChatCompletionContentPartText => item.type === "text")
					.map(item => item.text)
					.join("\n"),
			},
		];
	}
	return [{ role: "user", content }];
}

function applyAssistantReasoningFields(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	msg: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	nonEmptyThinkingBlocks: ThinkingContent[],
	toolCalls: ToolCall[],
): void {
	if (nonEmptyThinkingBlocks.length > 0) {
		if (compat.requiresThinkingAsText) {
			const thinkingText = nonEmptyThinkingBlocks.map(b => renderDemotedThinking(model.id, b.thinking)).join(" ");
			assistantMsg.content =
				typeof assistantMsg.content === "string" && assistantMsg.content.length > 0
					? `${thinkingText} ${assistantMsg.content}`
					: thinkingText;
		} else if (compat.requiresReasoningContentForToolCalls) {
			const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
			const wireField =
				compat.allowsSyntheticReasoningContentForToolCalls &&
				(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text")
					? signature
					: signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
						? (compat.reasoningContentField ?? "reasoning_content")
						: undefined;
			if (wireField) {
				assistantMsg[wireField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
			}
		} else if (compat.thinkingFormat === "zai" && model.reasoning) {
			const reasoningField = compat.reasoningContentField ?? "reasoning_content";
			assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
		} else if (compat.replayReasoningContent) {
			const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
			const reasoningField: OpenAICompletionsReasoningField =
				signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
					? signature
					: (compat.reasoningContentField ?? "reasoning_content");
			assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
		}
	}

	if (compat.requiresReasoningContentForToolCalls) {
		const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
		const reasoningField =
			compat.allowsSyntheticReasoningContentForToolCalls &&
			(streamedReasoningField === "reasoning_content" ||
				streamedReasoningField === "reasoning" ||
				streamedReasoningField === "reasoning_text")
				? streamedReasoningField
				: (compat.reasoningContentField ?? "reasoning_content");
		const reasoningContent = assistantMsg[reasoningField];
		if (!reasoningContent) {
			const reasoning = assistantMsg.reasoning;
			const reasoningText = assistantMsg.reasoning_text;
			if (reasoning && reasoningField !== "reasoning") {
				assistantMsg[reasoningField] = reasoning;
			} else if (reasoningText && reasoningField !== "reasoning_text") {
				assistantMsg[reasoningField] = reasoningText;
			} else if (nonEmptyThinkingBlocks.length > 0) {
				assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
			}
		}
	}

	applySyntheticOrFallbackReasoning(assistantMsg, msg, compat, toolCalls);
}

function applySyntheticOrFallbackReasoning(
	assistantMsg: OpenAICompletionsAssistantMessageParam,
	msg: AssistantMessage,
	compat: ResolvedOpenAICompat,
	toolCalls: ToolCall[],
): void {
	const canUseSyntheticReasoningContent =
		compat.requiresReasoningContentForToolCalls &&
		compat.allowsSyntheticReasoningContentForToolCalls &&
		(compat.thinkingFormat === "openai" || compat.thinkingFormat === "openrouter" || compat.thinkingFormat === "zai");
	const needsReasoningOnAllTurns = compat.requiresReasoningContentForAllAssistantTurns;
	const needsReasoningField = needsReasoningOnAllTurns || toolCalls.length > 0;
	let hasReasoningField =
		assistantMsg.reasoning_content !== undefined ||
		assistantMsg.reasoning !== undefined ||
		assistantMsg.reasoning_text !== undefined;

	if (
		needsReasoningField &&
		!hasReasoningField &&
		compat.requiresReasoningContentForToolCalls &&
		!compat.allowsSyntheticReasoningContentForToolCalls
	) {
		const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
		if (allThinkingBlocks.length > 0) {
			const signature = allThinkingBlocks[0].thinkingSignature;
			if (signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text") {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = allThinkingBlocks.map(b => b.thinking).join("\n");
				hasReasoningField = true;
			}
		}
	}
	if (
		needsReasoningField &&
		!hasReasoningField &&
		compat.requiresReasoningContentForToolCalls &&
		!compat.allowsSyntheticReasoningContentForToolCalls
	) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = "";
		hasReasoningField = true;
	}
	if (toolCalls.length > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
		const reasoningField = compat.reasoningContentField ?? "reasoning_content";
		assistantMsg[reasoningField] = ".";
	}
}
function convertAssistantMessage(
	msg: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	msgIndex: number,
	idTracker: {
		ensureToolCallId: (rawId: string, seed: string) => string;
		rememberToolCallId: (originalId: string, normalizedId: string) => void;
	},
): OpenAICompletionsAssistantMessageParam | null {
	const assistantMsg: OpenAICompletionsAssistantMessageParam = {
		role: "assistant",
		content: null,
	};

	const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
	const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
	if (nonEmptyTextBlocks.length > 0) {
		assistantMsg.content = nonEmptyTextBlocks
			.map((b, i) => {
				const text = b.text.toWellFormed();
				return isDemotedThinking(b) && i < nonEmptyTextBlocks.length - 1 ? `${text}\n` : text;
			})
			.join("");
	}

	const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
	const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
	const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];

	applyAssistantReasoningFields(assistantMsg, msg, model, compat, nonEmptyThinkingBlocks, toolCalls);

	if (toolCalls.length > 0) {
		assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
			const toolCallId = idTracker.ensureToolCallId(tc.id, `${msgIndex}:${toolCallIndex}:${tc.name}`);
			idTracker.rememberToolCallId(tc.id, toolCallId);
			return {
				id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
				type: "function" as const,
				function: {
					name: tc.name,
					arguments: serializeToolArguments(tc.arguments, tc.name),
				},
			};
		});
		const reasoningDetails = toolCalls
			.filter(tc => tc.thoughtSignature)
			.map(tc => tryParseJson(tc.thoughtSignature!))
			.filter(Boolean);
		if (reasoningDetails.length > 0) {
			assistantMsg.reasoning_details = reasoningDetails;
		}
	}

	const hasReasoningField =
		assistantMsg.reasoning_content !== undefined ||
		assistantMsg.reasoning !== undefined ||
		assistantMsg.reasoning_text !== undefined;

	if (assistantMsg.content === null && (hasReasoningField || assistantMsg.tool_calls)) {
		assistantMsg.content = "";
	}
	const content = assistantMsg.content;
	const hasContent =
		content !== null &&
		content !== undefined &&
		(typeof content === "string" ? content.length > 0 : content.length > 0);
	if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
		assistantMsg.content = ".";
	}
	if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
		return null;
	}
	return assistantMsg;
}

function convertToolResultBatch(
	transformedMessages: Message[],
	startIndex: number,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
	idTracker: {
		consumeToolCallId: (originalId: string) => string | null;
		ensureToolCallId: (rawId: string, seed: string) => string;
	},
): {
	params: ChatCompletionMessageParam[];
	nextIndex: number;
	lastRole: string;
} {
	const params: ChatCompletionMessageParam[] = [];
	const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
	let j = startIndex;

	for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
		const toolMsg = transformedMessages[j] as ToolResultMessage;
		const textResult = toolMsg.content
			.filter(c => c.type === "text")
			.map(c => (c as TextContent).text)
			.join("\n");
		const supportsImages = model.input.includes("image") && !isDashscopeCompatibleModeTextOnlyQwen(model);
		const hasImages = toolMsg.content.some(c => c.type === "image");
		const omittedImages = hasImages && !supportsImages;
		const hasText = textResult.length > 0;
		const remappedToolCallId = idTracker.consumeToolCallId(toolMsg.toolCallId);
		const resolvedToolCallId =
			remappedToolCallId ?? idTracker.ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
		const toolResultContent = omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: hasText
				? textResult
				: hasImages
					? "(see attached image)"
					: "";
		const toolResultMsg: OpenAICompletionsToolMessageParam = {
			role: "tool",
			content: toolResultContent.toWellFormed(),
			tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
		};
		if (compat.requiresToolResultName && toolMsg.toolName) {
			toolResultMsg.name = toolMsg.toolName;
		}
		params.push(toolResultMsg);

		if (hasImages && supportsImages) {
			for (const block of toolMsg.content) {
				if (block.type === "image") {
					imageBlocks.push({
						type: "image_url",
						image_url: {
							url: `data:${block.mimeType};base64,${block.data}`,
						},
					});
				}
			}
		}
	}

	let lastRole = "toolResult";
	if (imageBlocks.length > 0) {
		if (compat.requiresAssistantAfterToolResult) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}
		params.push({
			role: "user",
			content: [
				{
					type: "text",
					text: "Attached image(s) from tool result:",
				},
				...imageBlocks,
			],
		});
		lastRole = "user";
	}
	return { params, nextIndex: j - 1, lastRole };
}

function createOpenAIToolCallIdTracker(
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompat,
): {
	normalizeToolCallId: (id: string) => string;
	idTracker: {
		rememberToolCallId: (originalId: string, normalizedId: string) => void;
		consumeToolCallId: (originalId: string) => string | null;
		ensureToolCallId: (rawId: string, seed: string) => string;
	};
} {
	const normalizeToolCallId = (id: string): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);
		if (id.includes("|")) {
			const [callId] = id.split("|");
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}
		if (compat.usesOpenAIToolCallIdLimit) return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const idTracker = {
		rememberToolCallId: (originalId: string, normalizedId: string): void => {
			const queue = remappedToolCallIds.get(originalId);
			if (queue) {
				queue.push(normalizedId);
				return;
			}
			remappedToolCallIds.set(originalId, [normalizedId]);
		},
		consumeToolCallId: (originalId: string): string | null => {
			const queue = remappedToolCallIds.get(originalId);
			if (!queue || queue.length === 0) return null;
			const nextId = queue.shift() ?? null;
			if (queue.length === 0) remappedToolCallIds.delete(originalId);
			return nextId;
		},
		ensureToolCallId: (rawId: string, seed: string): string => {
			const normalized = normalizeToolCallId(rawId);
			if (normalized.trim().length > 0) return normalized;
			return generateFallbackToolCallId(seed);
		},
	};

	return { normalizeToolCallId, idTracker };
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const maxNormalizedToolCallIdLength = compat.requiresMistralToolIds
		? 9
		: compat.usesOpenAIToolCallIdLimit
			? 40
			: undefined;
	const duplicateToolCallIdSuffixPrefix = compat.requiresMistralToolIds ? "dup" : undefined;
	const { normalizeToolCallId, idTracker } = createOpenAIToolCallIdTracker(model, compat);
	const transformedMessages = transformMessages(
		context.messages,
		model,
		id => normalizeToolCallId(id),
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
		compat,
	);

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		if (compat.supportsMultipleSystemMessages) {
			for (const systemPrompt of systemPrompts) {
				params.push({ role, content: systemPrompt });
			}
		} else {
			params.push({ role, content: systemPrompts.join("\n\n") });
		}
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user" || msg.role === "developer") {
			const converted = convertUserOrDeveloperMessage(msg, model, compat);
			params.push(...converted);
		} else if (msg.role === "assistant") {
			const converted = convertAssistantMessage(msg, model, compat, i, idTracker);
			if (converted) params.push(converted);
		} else if (msg.role === "toolResult") {
			const {
				params: toolParams,
				nextIndex,
				lastRole: newLastRole,
			} = convertToolResultBatch(transformedMessages, i, model, compat, idTracker);
			params.push(...toolParams);
			i = nextIndex;
			lastRole = newLastRole;
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
): BuiltOpenAICompletionTools {
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = toolWireSchema(tool);
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	return {
		tools: adaptedTools.map(({ tool, baseParameters, parameters, strict }) => {
			const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
			const includeExplicitFalse =
				!includeStrict &&
				tool.strict === false &&
				toolStrictMode === "mixed" &&
				compat.supportsStrictMode !== false;
			const wireParameters = includeStrict ? parameters : baseParameters;
			return {
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					parameters:
						compat.toolSchemaFlavor === "moonshot-mfjs"
							? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
							: wireParameters,
					...(includeStrict ? { strict: true } : includeExplicitFalse ? { strict: false } : {}),
				},
			};
		}),
		toolStrictMode,
		strictToolsApplied:
			tools.length > 0 &&
			(toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && adaptedTools.some(tool => tool.strict))),
	};
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("content_filter") };
		case "network_error":
			return { stopReason: "error", errorMessage: AIError.providerFinishErrorMessage("network_error") };
		default:
			return {
				stopReason: "error",
				errorMessage: AIError.providerFinishErrorMessage(typeof reason === "string" ? reason : undefined),
			};
	}
}
