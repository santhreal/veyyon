import { scheduler } from "node:timers/promises";
import { calculateCost, discardAttemptUsage, emptyUsage, scaleUsageCost } from "@veyyon/catalog/models";
import { toFields, toStringValue } from "@veyyon/catalog/utils";
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION, getCodexAccountId } from "@veyyon/catalog/wire/codex";
import { $env, $flag } from "@veyyon/utils/env";
import { structuredCloneJSON } from "@veyyon/utils/json";
import { parseStreamingJson } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { readSseJson } from "@veyyon/utils/stream";
import { asRecord, errorMessage } from "@veyyon/utils/type-guards";
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
import * as AIError from "../error";
import {
	CodexProviderStreamError,
	CodexWebSocketTransportError,
	CodexWhitespaceToolCallLoopError,
} from "../error/classes";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	TextContent,
	Tool,
	ToolCall,
	Usage,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "../utils";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import { withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { type FirstEventBudget, isPreResponseStall, openStallLadderBudget } from "../utils/first-event-budget";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import type { OpenAIStreamHandle } from "../utils/openai-http";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
import { notifyProviderResponse } from "../utils/provider-response";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { notifyRawSseEvent } from "../utils/sse-debug";
import { compactGrammarDefinition } from "./grammar";
import {
	type CodexRequestOptions,
	type InputItem,
	type RequestBody,
	resolveCodexResponsesLite,
	transformRequestBody,
} from "./openai-codex/request-transformer";
import { CodexApiError } from "./openai-codex/response-handler";
import {
	CODEX_DEBUG,
	CODEX_MAX_RETRIES,
	CODEX_MODERATION_METADATA_KEY,
	CODEX_RATE_LIMIT_BUDGET_MS,
	CODEX_RETRY_DELAY_MS,
	CODEX_RETRYABLE_EVENT_CODES,
	CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS,
	CODEX_WEBSOCKET_FATAL_PATTERNS,
	CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS,
	CODEX_WEBSOCKET_IDLE_TIMEOUT_MS,
	CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS,
	CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY,
	CODEX_WEBSOCKET_PING_INTERVAL_MS,
	CODEX_WEBSOCKET_PONG_TIMEOUT_MS,
	CODEX_WEBSOCKET_RETRY_BUDGET,
	CODEX_WEBSOCKET_RETRY_DELAY_MS,
	CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS,
	CODEX_WHITESPACE_LOOP_RETRY_LIMIT,
	CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY,
	type CodexEventItem,
	type CodexOpenItem,
	type CodexOutputBlock,
	type CodexProviderSessionState,
	type CodexRequestContext,
	type CodexRequestMetadata,
	type CodexRequestSetup,
	type CodexResponseUsage,
	type CodexStreamCompletion,
	type CodexStreamFailureContext,
	CodexStreamRuntime,
	type CodexTransport,
	type CodexWebSocketSessionState,
	createCodexCompatibilityIdentity,
	createCodexHeaders,
	createCodexProviderSessionState,
	createCodexRequestMetadata,
	createCodexWebSocketTimeoutMessage,
	extractCodexFrameResponseId,
	extractCodexFrameSequenceNumber,
	extractCodexWebSocketHandshakeHeaders,
	getCodexProviderSessionState,
	getCodexServiceTierCostMultiplier,
	getOrCreateCodexMetadataSessionState,
	isCodexStreamProgressEvent,
	isCodexWebSocketRetryableStreamError,
	normalizeCodexToolChoice,
	notifyCodexWebSocketInbound,
	notifyCodexWebSocketMalformed,
	notifyCodexWebSocketOutbound,
	type OpenAICodexRequestKind,
	type OpenAICodexResponsesOptions,
	type OpenAICodexTurnRequestDiagnostics,
	type OpenAICodexTurnUsageDiagnostics,
	type OpenAICodexWebSocketDebugStats,
	redactHeaders,
	resetCodexWebSocketAppendState,
	resolveCodexResponsesUrl,
	resolveCodexStartNewTurn,
	updateCodexSessionMetadataFromHeaders,
	X_CODEX_TURN_STATE_HEADER,
	X_MODELS_ETAG_HEADER,
} from "./openai-codex-responses-helpers";
import type {
	ResponseInput,
	ResponseInputContent,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
} from "./openai-responses-wire";
import {
	appendMessageContentPart,
	appendMessageTextDelta,
	appendReasoningSummaryPart,
	appendReasoningSummaryPartDone,
	appendReasoningSummaryTextDelta,
	appendResponsesToolResultMessages,
	applyOpenAIServiceTier,
	applyReasoningSummaryDone,
	buildResponsesDeltaInput,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	finalizeMessageText,
	finalizePendingResponsesToolCalls,
	finalizeReasoningThinking,
	mapOpenAIResponsesStopReason,
	normalizeOpenAIPromptCacheKey,
	populateResponsesUsageFromResponse,
	promoteResponsesToolUseStopReason,
	resolveResponsesToolCallDeltaShape,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";

export {
	type CodexWebSocketSessionState,
	createOpenAICodexCompactionRequestContext,
	createOpenAICodexCompatibilityMetadata,
	createOpenAICodexDirectRequest,
	normalizeCodexToolChoice,
	type OpenAICodexCompactionResetOptions,
	type OpenAICodexCompatibilityMetadata,
	type OpenAICodexCompatibilityMetadataOptions,
	type OpenAICodexRequestKind,
	type OpenAICodexResponsesOptions,
	type OpenAICodexTurnDiagnostics,
	type OpenAICodexTurnRequestDiagnostics,
	type OpenAICodexTurnUsageDiagnostics,
	type OpenAICodexWebSocketDebugStats,
	resetOpenAICodexHistoryAfterCompaction,
} from "./openai-codex-responses-helpers";

function resolveCodexCostServiceTier(res: unknown, req?: unknown): ServiceTier | "default" | undefined {
	switch (res) {
		case "flex":
			return "flex";
		case "priority":
			return "priority";
		default:
			if (req === "flex" || req === "priority") {
				return req;
			}
			return "default";
	}
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "id">,
	usage: AssistantMessage["usage"],
	resTier: unknown,
	reqTier: unknown,
): void {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier);
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	scaleUsageCost(usage, multiplier);
}

function resetOutputState(model: Model<"openai-codex-responses">, output: AssistantMessage): void {
	output.content.length = 0;
	output.usage = discardAttemptUsage(model, output.usage, emptyUsage());
	output.stopReason = "stop";
	output.stopDetails = undefined;
}

function createRequestSetup(options: OpenAICodexResponsesOptions | undefined): CodexRequestSetup {
	const requestAbortController = new AbortController();
	const requestSignal = options?.signal
		? AbortSignal.any([options.signal, requestAbortController.signal])
		: requestAbortController.signal;
	const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
	const websocketIdleTimeoutMs = options?.streamIdleTimeoutMs ?? CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
	const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	const websocketFirstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS;
	const wrapCodexSseStream = (
		source: AsyncGenerator<Record<string, unknown>>,
	): AsyncGenerator<Record<string, unknown>> =>
		iterateWithIdleTimeout(source, {
			idleTimeoutMs,
			firstItemTimeoutMs: firstEventTimeoutMs,
			firstItemErrorMessage: "OpenAI Codex SSE stream timed out while waiting for the first event",
			errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			onFirstItemTimeout: () => requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isCodexStreamProgressEvent,
		});
	return {
		requestAbortController,
		requestSignal,
		wrapCodexSseStream,
		firstEventTimeoutMs,
		firstEventBudget: openStallLadderBudget(firstEventTimeoutMs),
		websocketIdleTimeoutMs,
		websocketFirstEventTimeoutMs,
	};
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	output: AssistantMessage,
): Promise<CodexRequestContext> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	const accountId = getCodexAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const promptCacheKey = normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const codexClientVersion = CODEX_CLIENT_VERSION;
	const transformedBody = await buildTransformedCodexRequestBody(model, context, options, promptCacheKey);

	const requestHeaders = { ...(model.headers ?? {}), ...(options?.headers ?? {}) };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: output.api,
		model: model.id,
		method: "POST",
		url,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const isolatedTransportState = options?.codexCompaction ? createCodexProviderSessionState() : undefined;
	const transportProviderSessionState = isolatedTransportState ?? providerSessionState;
	const responsesLite = resolveCodexResponsesLite(model, options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (sessionKey && publicSessionKey) {
		transportProviderSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const sharedWebsocketState =
		sessionKey && providerSessionState
			? isolatedTransportState
				? providerSessionState.webSocketSessions.get(sessionKey)
				: getCodexWebSocketSessionState(sessionKey, providerSessionState)
			: undefined;
	const websocketState =
		sessionKey && isolatedTransportState
			? getCodexWebSocketSessionState(sessionKey, isolatedTransportState)
			: sharedWebsocketState;
	if (isolatedTransportState && websocketState && sharedWebsocketState) {
		websocketState.disableWebsocket = sharedWebsocketState.disableWebsocket;
		websocketState.turnState = sharedWebsocketState.turnState;
		websocketState.modelsEtag = sharedWebsocketState.modelsEtag;
	}
	const withinTurnContinuation = isCodexWithinTurnContinuation(context);
	const metadataSessionId = transportSessionId ?? crypto.randomUUID();
	const metadataSession = getOrCreateCodexMetadataSessionState(metadataSessionId, providerSessionState);
	const compaction = options?.codexCompaction;
	const requestKind: OpenAICodexRequestKind = compaction ? "compaction" : "turn";
	const startNewTurn = resolveCodexStartNewTurn(
		metadataSession,
		requestKind,
		compaction,
		compaction ? undefined : !withinTurnContinuation,
	);
	if (websocketState && startNewTurn) {
		websocketState.turnState = undefined;
	}
	const requestMetadata = createCodexRequestMetadata(metadataSession, requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: compaction
			? startNewTurn || !metadataSession.turnId
				? Date.now()
				: undefined
			: getCodexTurnStartedAtUnixMs(context),
		clientMetadata: transformedBody.client_metadata,
		compaction,
	});
	transformedBody.client_metadata = requestMetadata.clientMetadata;
	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		transportSessionId,
		providerSessionState,
		isolatedTransportState,
		websocketState,
		responsesLite,
		requestMetadata,
		codexClientVersion,
		transformedBody,
		rawRequestDump,
	};
}

export async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	promptCacheKey = normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
): Promise<RequestBody> {
	const params: RequestBody = {
		model: model.requestModelId ?? model.id,
		input: convertMessages(model, context),
		stream: true,
		prompt_cache_key: promptCacheKey,
	};

	applyOpenAIServiceTier(params, options?.serviceTier, model);
	if (context.tools && context.tools.length > 0) {
		params.tools = convertOpenAICodexResponsesTools(context.tools, model);
		if (options?.toolChoice) {
			const toolChoice = normalizeCodexToolChoice(options.toolChoice, context.tools, model);
			if (toolChoice) {
				params.tool_choice = toolChoice;
			}
		}
	}

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		params.instructions = systemPrompts[0];
	}
	const developerMessages = systemPrompts.slice(1);
	if (options?.clientMetadata && Object.keys(options.clientMetadata).length > 0) {
		params.client_metadata = { ...options.clientMetadata };
	}
	const codexOptions: CodexRequestOptions = {
		reasoningEffort: options?.reasoning,
		reasoningSummary: options?.reasoningSummary === undefined ? "auto" : options.reasoningSummary,
		reasoningContext: options?.reasoningContext,
		textVerbosity: options?.textVerbosity,
		include: options?.include,
		responsesLite: options?.responsesLite,
	};

	return transformRequestBody(params, model, codexOptions, { developerMessages });
}

async function openInitialCodexEventStream(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const { transformedBody, websocketState } = requestContext;
	if (websocketState && shouldUseCodexWebSocket(model, websocketState, options?.preferWebsockets)) {
		const websocketRetryBudget = CODEX_WEBSOCKET_RETRY_BUDGET;
		let websocketRetries = 0;
		while (true) {
			try {
				return await openCodexWebSocketTransport(
					model,
					options,
					requestContext,
					requestSetup,
					websocketState,
					websocketRetries,
					options ? event => options.onSseEvent?.(event, model) : undefined,
				);
			} catch (error) {
				if (!(error instanceof CodexWebSocketTransportError)) throw error;
				const fatalWebSocketMessage = error.message.toLowerCase();
				const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
					fatalWebSocketMessage.includes(pattern.toLowerCase()),
				);
				const activateFallback = isFatal || websocketRetries >= websocketRetryBudget;
				recordCodexWebSocketFailure(websocketState, activateFallback, {
					cause: isFatal ? "fatal-websocket-error" : "retry-budget-exhausted",
					error: error.message,
				});
				CODEX_DEBUG &&
					logger.debug("[codex] codex websocket fallback", {
						error: error.message,
						retry: websocketRetries,
						retryBudget: websocketRetryBudget,
						activated: activateFallback,
						fatal: isFatal,
					});
				if (!activateFallback) {
					websocketRetries += 1;
					await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, websocketRetries), {
						signal: requestSetup.requestSignal,
					});
					continue;
				}
				break;
			}
		}
	}
	return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
}
async function openCodexWebSocketTransport(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	websocketState: CodexWebSocketSessionState,
	retry: number,
	onSseEvent?: (event: RawSseEvent) => void,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const canAppendBeforeRequest = websocketState.canAppend === true;
	const chainedBody = buildCodexChainedRequestBody(requestContext.transformedBody, websocketState);
	const websocketClientMetadata = { ...(chainedBody.client_metadata ?? {}) };
	if (requestContext.responsesLite) {
		websocketClientMetadata[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY] = "true";
	}
	if (websocketState.turnState) {
		websocketClientMetadata[X_CODEX_TURN_STATE_HEADER] = websocketState.turnState;
	}
	let websocketRequest = {
		type: "response.create",
		...chainedBody,
		client_metadata: websocketClientMetadata,
	};
	const replacementWebsocketRequest = await options?.onPayload?.(websocketRequest, model);
	if (replacementWebsocketRequest !== undefined) {
		websocketRequest = replacementWebsocketRequest as typeof websocketRequest;
	}
	recordCodexTurnRequestDiagnostics(websocketState, websocketRequest, "websocket", canAppendBeforeRequest);
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.codexClientVersion,
		requestContext.transportSessionId,
		"websocket",
		websocketState,
		requestContext.responsesLite,
		requestContext.requestMetadata,
	);
	const requestBodyForState = structuredCloneJSON(requestContext.transformedBody);
	if (websocketRequest.stream_options === undefined) {
		delete requestBodyForState.stream_options;
	} else {
		requestBodyForState.stream_options = websocketRequest.stream_options;
	}
	requestContext.wireBodyJson = JSON.stringify(websocketRequest);
	CODEX_DEBUG &&
		logger.debug("[codex] codex websocket request", {
			url: toWebSocketUrl(requestContext.url),
			model: requestContext.transformedBody.model,
			reasoningEffort: requestContext.transformedBody.reasoning?.effort ?? null,
			headers: redactHeaders(websocketHeaders),
			requestType: websocketRequest.type,
			retry,
			retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
		});
	const websocketConnection = await getOrCreateCodexWebSocketConnection(
		websocketState,
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		requestSetup.requestSignal,
	);
	const eventStream = websocketConnection.streamRequest(
		websocketRequest,
		{
			idleTimeoutMs: requestSetup.websocketIdleTimeoutMs,
			firstEventTimeoutMs: requestSetup.websocketFirstEventTimeoutMs,
		},
		requestSetup.requestSignal,
		onSseEvent,
	);
	return {
		eventStream,
		requestBodyForState,
		transport: "websocket",
	};
}

function getCodexTurnStartedAtUnixMs(context: Context): number {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role === "user" && Number.isFinite(message.timestamp)) {
			return Math.trunc(message.timestamp);
		}
	}
	return Date.now();
}

function isCodexWithinTurnContinuation(context: Context): boolean {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const role = context.messages[i]?.role;
		if (role === "toolResult") continue;
		return role === "assistant";
	}
	return false;
}

async function openCodexSseTransport(
	model: Model<"openai-codex-responses">,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	options: OpenAICodexResponsesOptions | undefined,
	state: CodexWebSocketSessionState | undefined,
	body = requestContext.transformedBody,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const canAppendBeforeRequest = state?.canAppend === true;
	let wireBody = body;
	const prepareBody = async (): Promise<RequestBody> => {
		const bodyJson = JSON.stringify(body);
		let wireParams = body;
		if (options?.onPayload) {
			const attemptBody = JSON.parse(bodyJson) as RequestBody;
			const replacementWireBody = await options.onPayload(attemptBody, model);
			wireParams =
				replacementWireBody !== undefined && replacementWireBody !== attemptBody
					? (replacementWireBody as RequestBody)
					: attemptBody;
		}
		wireBody = wireParams;
		requestContext.wireBodyJson = wireParams === body ? bodyJson : JSON.stringify(wireParams);
		return wireParams;
	};
	if (requestSetup.requestSignal.aborted) await prepareBody();
	const handle = await openCodexSseEventStream(
		requestContext.url,
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.transportSessionId,
		body,
		state,
		requestContext.responsesLite,
		requestContext.codexClientVersion,
		requestContext.requestMetadata,
		requestSetup.requestSignal,
		requestSetup.firstEventTimeoutMs,
		requestSetup.firstEventBudget,
		options?.maxRetryDelayMs,
		event => options?.onSseEvent?.(event, model),
		options?.fetch,
		prepareBody,
	);
	await notifyProviderResponse(options, handle.response, model, handle.requestId);
	recordCodexTurnRequestDiagnostics(state, wireBody, "sse", canAppendBeforeRequest);
	return {
		eventStream: requestSetup.wrapCodexSseStream(handle.events),
		requestBodyForState: structuredCloneJSON(wireBody),
		transport: "sse",
	};
}

function createOutputBlockForItem(item: CodexEventItem): CodexOutputBlock | null {
	if (item.type === "reasoning") {
		return { type: "thinking", thinking: "" };
	}
	if (item.type === "message") {
		const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
		return { type: "text", text: "", textSignature: encodeTextSignatureV1(item.id, phase) };
	}
	if (item.type === "function_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: {},
			[kStreamingPartialJson]: item.arguments || "",
		};
	}
	if (item.type === "custom_tool_call") {
		return {
			type: "toolCall",
			id: encodeResponsesToolCallId(item.call_id, item.id),
			name: item.name,
			arguments: { input: item.input ?? "" },
			customWireName: item.name,
			[kStreamingPartialJson]: item.input ?? "",
		};
	}
	return null;
}

function getOutputBlockStartEventType(block: CodexOutputBlock): "thinking_start" | "text_start" | "toolcall_start" {
	if (block.type === "thinking") return "thinking_start";
	if (block.type === "text") return "text_start";
	return "toolcall_start";
}

const CODEX_STALE_PREVIOUS_RESPONSE_CODES: Record<string, true> = {
	// OpenAI-standard code for an expired/missing `previous_response_id` chain.
	previous_response_not_found: true,
	codex_previous_response_stale: true,
};

function isCodexStalePreviousResponseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (
		"code" in error &&
		typeof error.code === "string" &&
		Object.hasOwn(CODEX_STALE_PREVIOUS_RESPONSE_CODES, error.code)
	) {
		return true;
	}
	// Stale chain fallback when previous_response_id is rejected.
	return (
		/previous[ _]?response/i.test(error.message) &&
		/not[ _]?found|invalid|expired|stale|unsupported/i.test(error.message)
	);
}

async function handleCodexStreamFailure(context: CodexStreamFailureContext, error: unknown): Promise<AssistantMessage> {
	const { output } = context;
	if (context.requestContext.websocketState) {
		resetCodexWebSocketAppendState(context.requestContext.websocketState);
		context.requestContext.websocketState.turnState = undefined;
		context.requestContext.websocketState.modelsEtag = undefined;
	}
	const result = await AIError.finalize(error, {
		api: context.model.api,
		signal: context.options?.signal,
		rawRequestDump: materializeDumpBody(context.requestContext.rawRequestDump, context.requestContext.wireBodyJson),
	});
	output.stopReason = result.stopReason;
	output.errorStatus = result.status;
	output.errorId = result.id;
	output.errorMessage = result.message;
	output.duration = performance.now() - context.startTime;
	if (context.firstTokenTime) {
		output.ttft = context.firstTokenTime - context.startTime;
	}
	return output;
}

class CodexStreamProcessor {
	runtime: CodexStreamRuntime;
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	options: OpenAICodexResponsesOptions | undefined;
	requestSetup: CodexRequestSetup;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;

	constructor(init: {
		runtime: CodexStreamRuntime;
		model: Model<"openai-codex-responses">;
		output: AssistantMessage;
		stream: AssistantMessageEventStream;
		options: OpenAICodexResponsesOptions | undefined;
		requestSetup: CodexRequestSetup;
		requestContext: CodexRequestContext;
		startTime: number;
	}) {
		this.runtime = init.runtime;
		this.model = init.model;
		this.output = init.output;
		this.stream = init.stream;
		this.options = init.options;
		this.requestSetup = init.requestSetup;
		this.requestContext = init.requestContext;
		this.startTime = init.startTime;
	}

	get #sequentialCutoffSummaries(): boolean {
		return this.runtime.requestBodyForState.stream_options?.reasoning_summary_delivery === "sequential_cutoff";
	}

	async process(): Promise<CodexStreamCompletion> {
		const { output, stream } = this;
		stream.push({ type: "start", partial: output });

		while (true) {
			try {
				let firstTokenTime = this.firstTokenTime;
				for await (const rawEvent of this.runtime.eventStream) {
					firstTokenTime = this.#handleStreamEvent(rawEvent, firstTokenTime);
					if (this.runtime.sawTerminalEvent) break;
				}
				return { firstTokenTime };
			} catch (error) {
				const recovered = await this.#recoverStreamError(error);
				if (!recovered) {
					throw error;
				}
				stream.push({ type: "start", partial: output });
			}
		}
	}

	#handleStreamEvent(rawEvent: Record<string, unknown>, firstTokenTime: number | undefined): number | undefined {
		const { output, stream } = this;
		const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
		if (!eventType) return firstTokenTime;

		if (eventType === "response.output_item.added") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			if (!firstTokenTime) firstTokenTime = performance.now();
			const item = rawEvent.item as CodexEventItem;
			this.runtime.currentItem = item;
			this.runtime.currentBlock = createOutputBlockForItem(item);
			let contentIndex = -1;
			if (this.runtime.currentBlock) {
				output.content.push(this.runtime.currentBlock);
				contentIndex = output.content.length - 1;
			}
			const itemId = typeof (item as { id?: string }).id === "string" ? (item as { id: string }).id : undefined;
			const outputIndex =
				typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
					? Math.trunc(rawEvent.output_index)
					: undefined;
			const entry: CodexOpenItem = { item, block: this.runtime.currentBlock, contentIndex, itemId, outputIndex };
			this.runtime.currentEntry = entry;
			if (itemId) this.runtime.openItems.set(itemId, entry);
			if (outputIndex !== undefined) this.runtime.openItemsByOutputIndex.set(outputIndex, entry);
			if (!this.runtime.currentBlock) return firstTokenTime;
			stream.push({
				type: getOutputBlockStartEventType(this.runtime.currentBlock),
				contentIndex,
				partial: output,
			});
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.added") {
			if (this.#sequentialCutoffSummaries) return firstTokenTime;
			if (this.runtime.currentItem?.type === "reasoning") {
				appendReasoningSummaryPart(
					this.runtime.currentItem,
					(rawEvent as { part: ResponseReasoningItem["summary"][number] }).part,
				);
			}
			return firstTokenTime;
		}
		if (eventType === "response.reasoning_summary_text.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (this.#sequentialCutoffSummaries) {
				this.runtime.queueSummaryDelta(entry, delta);
				return firstTokenTime;
			}
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				appendReasoningSummaryTextDelta(entry.item, entry.block, delta, stream, output, entry.contentIndex);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_text.done") {
			if (!this.#sequentialCutoffSummaries) return firstTokenTime;
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				this.runtime.takeSummaryDeltas(entry);
				if (!firstTokenTime) firstTokenTime = performance.now();
				const summaryIndex =
					typeof rawEvent.summary_index === "number" && Number.isFinite(rawEvent.summary_index)
						? Math.trunc(rawEvent.summary_index)
						: 0;
				applyReasoningSummaryDone(
					this.runtime.cutoffSummaries,
					entry.block,
					typeof rawEvent.text === "string" ? rawEvent.text : "",
					summaryIndex,
					stream,
					output,
					entry.contentIndex,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_text.delta") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				entry.block.thinking += delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: entry.contentIndex,
					delta,
					partial: output,
				});
			}
			return firstTokenTime;
		}

		if (eventType === "response.reasoning_summary_part.done") {
			const entry = this.runtime.openItemForEvent(rawEvent);
			if (this.#sequentialCutoffSummaries) {
				if (entry && this.runtime.pendingSummaryDeltas.has(entry)) this.runtime.queueSummaryDelta(entry, "\n\n");
				return firstTokenTime;
			}
			if (entry?.item.type === "reasoning" && entry.block?.type === "thinking") {
				appendReasoningSummaryPartDone(entry.item, entry.block, stream, output, entry.contentIndex);
			}
			return firstTokenTime;
		}

		if (eventType === "response.content_part.added") {
			if (this.runtime.currentItem?.type === "message") {
				appendMessageContentPart(
					this.runtime.currentItem,
					(rawEvent as { part?: ResponseOutputMessage["content"][number] }).part,
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
			if (this.runtime.currentItem?.type === "message" && this.runtime.currentBlock?.type === "text") {
				appendMessageTextDelta(
					this.runtime.currentItem,
					this.runtime.currentBlock,
					(rawEvent as { delta?: string }).delta || "",
					stream,
					output,
					output.content.length - 1,
					eventType === "response.refusal.delta" ? "refusal" : "output_text",
				);
			}
			return firstTokenTime;
		}

		if (eventType === "response.function_call_arguments.delta") {
			const interruption = this.runtime.handleToolCallArgumentsDelta(
				rawEvent,
				stream,
				output,
				resolveResponsesToolCallDeltaShape(this.model),
			);
			if (interruption) {
				this.runtime.websocketState?.connection?.close("degenerate-tool-call");
				throw new CodexWhitespaceToolCallLoopError(interruption.message);
			}
			return firstTokenTime;
		}

		if (eventType === "response.function_call_arguments.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.runtime.handleToolCallArgumentsDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.custom_tool_call_input.delta") {
			const interruption = this.runtime.handleCustomToolCallInputDelta(rawEvent, stream, output);
			if (interruption) {
				this.runtime.websocketState?.connection?.close("degenerate-tool-call");
				throw new CodexWhitespaceToolCallLoopError(interruption.message);
			}
			return firstTokenTime;
		}

		if (eventType === "response.custom_tool_call_input.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.runtime.handleCustomToolCallInputDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.output_item.done") {
			this.runtime.whitespaceToolCallArgumentsDelta = undefined;
			this.#handleOutputItemDone(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.created") {
			this.runtime.handleResponseCreated(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.completed" || eventType === "response.done" || eventType === "response.incomplete") {
			this.#handleResponseCompleted(rawEvent);
			return firstTokenTime;
		}

		if (eventType === "response.metadata") {
			const moderation = asRecord(rawEvent.metadata)?.[CODEX_MODERATION_METADATA_KEY];
			if (moderation !== undefined) {
				try {
					this.options?.onModerationMetadata?.(moderation);
				} catch {}
			}
			return firstTokenTime;
		}

		if (eventType === "error" || eventType === "response.failed") {
			throw createCodexProviderStreamError(rawEvent);
		}

		return firstTokenTime;
	}

	#flushSummaryDeltas(entry: CodexOpenItem | null): void {
		if (entry?.block?.type !== "thinking") return;
		for (const delta of this.runtime.takeSummaryDeltas(entry)) {
			entry.block.thinking += delta;
			this.stream.push({
				type: "thinking_delta",
				contentIndex: entry.contentIndex,
				delta,
				partial: this.output,
			});
		}
	}
	#handleOutputItemDone(rawEvent: Record<string, unknown>): void {
		const { runtime, output, stream } = this;
		const rawItem = rawEvent.item;
		if (!rawItem || typeof rawItem !== "object") return;
		const item = structuredCloneJSON(rawItem) as CodexEventItem;
		runtime.nativeOutputItems.push(item as unknown as Record<string, unknown>);

		const itemId = "id" in item && typeof item.id === "string" ? item.id : "";
		const entry = (itemId ? runtime.openItems.get(itemId) : null) ?? runtime.openItemForEvent(rawEvent);
		const block = entry?.block ?? null;
		const contentIndex = entry?.contentIndex ?? output.content.length - 1;

		if (item.type === "reasoning" && block?.type === "thinking") {
			this.#flushSummaryDeltas(entry);
			block.thinking = finalizeReasoningThinking(
				item,
				block.thinking,
				this.#sequentialCutoffSummaries ? this.runtime.cutoffSummaries : undefined,
			);
			block.thinkingSignature = JSON.stringify(item);
			stream.push({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: output,
			});
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "message" && block?.type === "text") {
			block.text = finalizeMessageText(item, block.text);
			const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
			block.textSignature = encodeTextSignatureV1(item.id, phase);
			stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: output,
			});
			runtime.closeOpenItem(entry);
			return;
		}

		if (item.type === "function_call") {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: parseStreamingJson(item.arguments || "{}"),
			};
			if (block?.type === "toolCall") {
				block.arguments = toolCall.arguments;
				clearStreamingPartialJson(block);
			}
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			return;
		}

		if (item.type === "custom_tool_call") {
			const partial = block?.type === "toolCall" ? block[kStreamingPartialJson] : undefined;
			const rawInput = partial && partial.length > 0 ? partial : (item.input ?? "");
			const toolCall: ToolCall = {
				type: "toolCall",
				id: encodeResponsesToolCallId(item.call_id, item.id),
				name: item.name,
				arguments: { input: rawInput },
				customWireName: item.name,
			};
			if (block?.type === "toolCall") {
				block.arguments = { input: rawInput };
				clearStreamingPartialJson(block);
			}
			runtime.closeOpenItem(entry);
			runtime.canSafelyReplayWebsocketOverSse = false;
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			return;
		}
	}

	#handleResponseCompleted(rawEvent: Record<string, unknown>): void {
		const { runtime, model, output } = this;
		runtime.sawTerminalEvent = true;
		const rawResponse = rawEvent.response;
		const response = rawResponse && typeof rawResponse === "object" ? rawResponse : undefined;
		const responseId = response && "id" in response && typeof response.id === "string" ? response.id : undefined;
		const usage = response && "usage" in response ? parseCodexResponseUsage(response.usage) : undefined;
		const serviceTier =
			response && "service_tier" in response ? parseCodexServiceTier(response.service_tier) : undefined;
		const status = response && "status" in response ? parseCodexResponseStatus(response.status) : undefined;
		const endTurn = response && "end_turn" in response ? response.end_turn : undefined;

		populateResponsesUsageFromResponse(output, usage);
		recordCodexTurnUsageDiagnostics(runtime.websocketState, usage, output.usage);
		if (responseId) {
			output.responseId = responseId;
		}

		const state = runtime.websocketState;
		if (state) {
			if (runtime.transport !== "websocket") {
				resetCodexWebSocketAppendState(state);
			} else {
				state.lastRequest = structuredCloneJSON(runtime.requestBodyForState);
				if (responseId) {
					state.lastResponseId = responseId;
					state.lastResponseItems = stripInputItemIds(structuredCloneJSON(runtime.nativeOutputItems));
					state.canAppend = rawEvent.type === "response.done" || rawEvent.type === "response.completed";
				} else {
					state.canAppend = false;
				}
			}
		}

		finalizePendingResponsesToolCalls(output);

		calculateCost(model, output.usage);
		applyCodexServiceTierPricing(model, output.usage, serviceTier, runtime.requestBodyForState.service_tier);
		output.stopReason = mapOpenAIResponsesStopReason(status);
		promoteResponsesToolUseStopReason(output, endTurn === true ? true : endTurn === false ? false : undefined);
	}

	async #recoverStreamError(error: unknown): Promise<boolean> {
		if (await this.#tryRecoverWhitespaceToolCallLoop(error)) {
			return true;
		}
		if (await this.#tryReconnectWebSocketOnConnectionLimit(error)) {
			return true;
		}
		if (await this.#tryRecoverPreviousResponseNotFound(error)) {
			return true;
		}
		if (await this.#tryReplayWebsocketFailureOverSse(error)) {
			return true;
		}
		if (await this.#tryRetryProviderError(error)) {
			return true;
		}
		return false;
	}

	async #tryRecoverWhitespaceToolCallLoop(error: unknown): Promise<boolean> {
		if (!(error instanceof CodexWhitespaceToolCallLoopError)) {
			return false;
		}
		this.#dropTrailingDegenerateToolCall();
		if (
			this.runtime.whitespaceLoopRetries >= CODEX_WHITESPACE_LOOP_RETRY_LIMIT ||
			!this.runtime.canSafelyReplayWebsocketOverSse ||
			this.output.content.some(block => block.type !== "thinking") ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		this.runtime.whitespaceLoopRetries += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
			websocketState.turnState = undefined;
			websocketState.modelsEtag = undefined;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] retrying codex turn after whitespace-only tool-call argument loop", {
				retry: this.runtime.whitespaceLoopRetries,
				retryBudget: CODEX_WHITESPACE_LOOP_RETRY_LIMIT,
				transport: this.runtime.transport,
			});

		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		this.runtime.whitespaceToolCallArgumentsDelta = undefined;
		resetOutputState(this.model, this.output);
		this.firstTokenTime = undefined;
		await scheduler.wait(CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS * this.runtime.whitespaceLoopRetries, {
			signal: this.requestSetup.requestSignal,
		});

		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
			return true;
		}

		await this.#reopenSseStream(websocketState);
		return true;
	}

	#dropTrailingDegenerateToolCall(): void {
		const { runtime, output } = this;
		const block = runtime.currentBlock;
		if (block && block.type === "toolCall" && output.content[output.content.length - 1] === block) {
			output.content.pop();
		}
		runtime.closeOpenItem(runtime.currentEntry);
	}

	async #tryReconnectWebSocketOnConnectionLimit(error: unknown): Promise<boolean> {
		if (!(error instanceof CodexProviderStreamError) || error.code !== "websocket_connection_limit_reached") {
			return false;
		}
		const websocketState = this.requestContext.websocketState;
		if (!websocketState || this.runtime.transport !== "websocket" || this.options?.signal?.aborted) {
			return false;
		}

		websocketState.connection?.close("connection_limit");
		websocketState.connection = undefined;
		resetCodexWebSocketAppendState(websocketState);

		if (this.output.content.length > 0 && !this.runtime.canSafelyReplayWebsocketOverSse) {
			return false;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket connection limit reached, reconnecting", {
				hadContent: this.output.content.length > 0,
				retry: this.runtime.websocketStreamRetries,
			});

		if (this.output.content.length > 0) {
			this.runtime.resetAccumulators();
			resetOutputState(this.model, this.output);
			this.firstTokenTime = undefined;
			recordCodexWebSocketFailure(websocketState, true, { cause: "connection-limit-after-partial-output" });
			await this.#reopenSseStream(websocketState);
			return true;
		}

		this.runtime.resetAccumulators();
		this.firstTokenTime = undefined;
		if (this.runtime.websocketStreamRetries >= CODEX_WEBSOCKET_RETRY_BUDGET) {
			recordCodexWebSocketFailure(websocketState, true, { cause: "connection-limit-retry-budget-exhausted" });
			await this.#reopenSseStream(websocketState);
			return true;
		}
		this.runtime.websocketStreamRetries += 1;
		await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, this.runtime.websocketStreamRetries), {
			signal: this.requestSetup.requestSignal,
		});
		await this.#reopenWebSocketStream(websocketState);
		return true;
	}

	async #tryRecoverPreviousResponseNotFound(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		if (
			!isCodexStalePreviousResponseError(error) ||
			!websocketState ||
			this.output.content.length > 0 ||
			this.options?.signal?.aborted ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES
		) {
			return false;
		}
		if (this.runtime.transport !== "websocket") {
			// SSE never sends previous_response_id; let other recovery handle it.
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		resetCodexWebSocketAppendState(websocketState);
		websocketState.turnState = undefined;
		websocketState.modelsEtag = undefined;
		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.model, this.output);
		this.firstTokenTime = undefined;

		CODEX_DEBUG &&
			logger.debug("[codex] codex previous_response_id expired; retrying with full context", {
				retry: this.runtime.providerRetryAttempt,
			});
		await this.#reopenWebSocketStream(websocketState);
		return true;
	}

	async #tryReplayWebsocketFailureOverSse(error: unknown): Promise<boolean> {
		const websocketState = this.requestContext.websocketState;
		const canReplay =
			this.runtime.transport === "websocket" &&
			websocketState &&
			isCodexWebSocketRetryableStreamError(error) &&
			this.runtime.canSafelyReplayWebsocketOverSse &&
			!this.runtime.sawTerminalEvent &&
			!this.options?.signal?.aborted;
		if (!canReplay) return false;

		const state = websocketState;
		const streamError = error instanceof Error ? error : new Error(String(error));
		const replayingBufferedOutputOverSse = this.output.content.length > 0;
		const fatalWebSocketMessage = streamError.message.toLowerCase();
		const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
			fatalWebSocketMessage.includes(pattern.toLowerCase()),
		);
		const activateFallback =
			replayingBufferedOutputOverSse ||
			isFatal ||
			this.runtime.websocketStreamRetries >= CODEX_WEBSOCKET_RETRY_BUDGET;
		recordCodexWebSocketFailure(state, activateFallback, {
			cause: replayingBufferedOutputOverSse
				? "stream-failed-while-replaying-over-sse"
				: isFatal
					? "fatal-stream-error"
					: "stream-retry-budget-exhausted",
			error: streamError.message,
		});
		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket stream fallback", {
				error: streamError.message,
				retry: this.runtime.websocketStreamRetries,
				retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
				activated: activateFallback,
				fatal: isFatal,
				replayedBufferedOutput: replayingBufferedOutputOverSse,
			});

		if (!activateFallback) {
			this.runtime.websocketStreamRetries += 1;
			this.runtime.resetAccumulators();
			this.firstTokenTime = undefined;
			await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, this.runtime.websocketStreamRetries), {
				signal: this.requestSetup.requestSignal,
			});
			await this.#reopenWebSocketStream(state);
			return true;
		}

		this.runtime.resetAccumulators();
		resetOutputState(this.model, this.output);
		this.firstTokenTime = undefined;

		await this.#reopenSseStream(state);
		return true;
	}

	async #tryRetryProviderError(error: unknown): Promise<boolean> {
		const stallOutlivedBudget = isPreResponseStall(error) && this.requestSetup.firstEventBudget.spent();
		if (
			!(error instanceof CodexProviderStreamError && error.retryable) ||
			this.output.content.length > 0 ||
			this.runtime.providerRetryAttempt >= CODEX_MAX_RETRIES ||
			stallOutlivedBudget ||
			this.options?.signal?.aborted
		) {
			return false;
		}

		this.runtime.providerRetryAttempt += 1;
		const websocketState = this.requestContext.websocketState;
		if (websocketState) {
			resetCodexWebSocketAppendState(websocketState);
			websocketState.turnState = undefined;
			websocketState.modelsEtag = undefined;
		}

		CODEX_DEBUG &&
			logger.debug("[codex] retrying codex provider stream error", {
				error: errorMessage(error),
				retry: this.runtime.providerRetryAttempt,
				retryBudget: CODEX_MAX_RETRIES,
				transport: this.runtime.transport,
			});

		this.runtime.resetAccumulators();
		this.runtime.sawTerminalEvent = false;
		resetOutputState(this.model, this.output);
		this.firstTokenTime = undefined;
		await scheduler.wait(CODEX_RETRY_DELAY_MS * this.runtime.providerRetryAttempt, {
			signal: this.requestSetup.requestSignal,
		});

		if (this.runtime.transport === "websocket" && websocketState) {
			await this.#reopenWebSocketStream(websocketState);
			return true;
		}

		await this.#reopenSseStream(websocketState);
		return true;
	}

	async #reopenWebSocketStream(state: CodexWebSocketSessionState): Promise<void> {
		try {
			const next = await openCodexWebSocketTransport(
				this.model,
				this.options,
				this.requestContext,
				this.requestSetup,
				state,
				this.runtime.websocketStreamRetries,
				this.options ? event => this.options?.onSseEvent?.(event, this.model) : undefined,
			);
			this.runtime.eventStream = next.eventStream;
			this.runtime.requestBodyForState = next.requestBodyForState;
			this.runtime.transport = next.transport;
			state.lastTransport = next.transport;
		} catch (error) {
			if (!(error instanceof CodexWebSocketTransportError)) throw error;
			recordCodexWebSocketFailure(state, true, { cause: "reopen-failed", error: error.message });
			CODEX_DEBUG &&
				logger.debug("[codex] codex websocket reopen failed, falling back to SSE", {
					error: error.message,
					retry: this.runtime.websocketStreamRetries,
				});
			await this.#reopenSseStream(state);
		}
	}

	async #reopenSseStream(state: CodexWebSocketSessionState | undefined): Promise<void> {
		const next = await openCodexSseTransport(this.model, this.requestContext, this.requestSetup, this.options, state);
		this.runtime.eventStream = next.eventStream;
		this.runtime.requestBodyForState = next.requestBodyForState;
		this.runtime.transport = next.transport;
		if (state) {
			state.lastTransport = next.transport;
		}
	}

	finalize(completion: CodexStreamCompletion): AssistantMessage {
		const { output } = this;
		if (this.options?.signal?.aborted) {
			throw new AIError.RequestAbortError();
		}
		if (!this.runtime.sawTerminalEvent) {
			if (this.requestContext.websocketState) {
				resetCodexWebSocketAppendState(this.requestContext.websocketState);
				this.requestContext.websocketState.turnState = undefined;
				this.requestContext.websocketState.modelsEtag = undefined;
			}
			CODEX_DEBUG &&
				logger.debug("[codex] codex stream ended unexpectedly", {
					transport: this.runtime.transport,
					terminalEventSeen: this.runtime.sawTerminalEvent,
					unexpectedStreamEnd: true,
					sentTurnStateHeader: Boolean(this.requestContext.websocketState?.turnState),
					sentModelsEtagHeader: Boolean(this.requestContext.websocketState?.modelsEtag),
				});
			throw new CodexProviderStreamError("Codex stream ended before terminal completion event", {
				retryable: false,
			});
		}
		if (output.stopReason === "aborted" || output.stopReason === "error") {
			throw new CodexProviderStreamError("Codex response failed", { retryable: false });
		}

		output.providerPayload = createOpenAIResponsesHistoryPayload(this.model.provider, this.runtime.nativeOutputItems);
		output.duration = performance.now() - this.startTime;
		if (completion.firstTokenTime) {
			output.ttft = completion.firstTokenTime - this.startTime;
		}
		return output;
	}
}

const streamOpenAICodexResponsesOnce = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const requestSetup = createRequestSetup(options);
		let processingContext: CodexStreamProcessor | undefined;
		const cacheEnforcement: CacheEnforcement = resolveCacheEnforcement(options?.cacheEnforcement);
		const cacheTracker: CacheTrackerState | undefined =
			cacheEnforcement === "off"
				? undefined
				: getCodexProviderSessionState(options?.providerSessionState)?.cacheTracker;
		const cacheKey = normalizeOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId);
		let cacheTracked: CacheTrackedRequest | undefined;
		let requestContext: CodexRequestContext | undefined;

		try {
			requestContext = await buildCodexRequestContext(model, context, options, output);
			if (cacheTracker) {
				const pending = takePendingCacheFailure(cacheTracker, cacheKey);
				if (pending) throw new CacheRejectedError(pending, model.provider, model.id);
				cacheTracked = beginCacheTrackedRequest(cacheTracker, {
					anchors: typeof requestContext.transformedBody.prompt_cache_key === "string" ? 1 : 0,
					retention: resolveCacheRetention(options?.cacheRetention),
					reportsCacheWrites: false,
					...(cacheKey === undefined ? {} : { cacheKey }),
				});
			}
			const initialTransport = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
			const runtime = new CodexStreamRuntime({
				...initialTransport,
				websocketState: requestContext.websocketState,
			});
			if (requestContext.websocketState) {
				requestContext.websocketState.lastTransport = initialTransport.transport;
			}

			processingContext = new CodexStreamProcessor({
				runtime,
				model,
				output,
				stream,
				options,
				requestSetup,
				requestContext,
				startTime,
			});

			const completion = await processingContext.process();
			processingContext.firstTokenTime = completion.firstTokenTime;
			const message = processingContext.finalize(completion);
			if (cacheTracker && cacheTracked) {
				const { verdict, decision } = recordCacheOutcome(
					cacheTracker,
					cacheTracked,
					message.usage,
					cacheEnforcement,
				);
				if (decision.report) {
					logger.warn(`${model.provider}: ${describeCacheVerdict(verdict)}`, {
						model: model.id,
						provider: model.provider,
						verdict: verdict.kind,
						anchors: cacheTracked.expectation.anchors,
						willFailNextRequest: decision.failNext,
					});
				}
			}
			stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			stream.end();
		} catch (error) {
			const failureContext =
				processingContext ??
				({
					model,
					output,
					options,
					requestContext: requestContext ?? {
						apiKey: "",
						accountId: "",
						baseUrl: model.baseUrl || CODEX_BASE_URL,
						url: "",
						requestHeaders: {},
						codexClientVersion: CODEX_CLIENT_VERSION,
						responsesLite: options?.responsesLite === true,
						transformedBody: { model: model.id },
						rawRequestDump: {
							provider: model.provider,
							api: output.api,
							model: model.id,
							method: "POST",
							url: "",
							body: { model: model.id },
						},
					},
					startTime,
				} satisfies CodexStreamFailureContext);
			try {
				const failure = await handleCodexStreamFailure(failureContext, error);
				stream.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
			} catch (failureError) {
				logger.error("Codex stream failure handler threw", {
					error: errorMessage(failureError),
				});
				output.stopReason = "error";
				output.errorMessage ??= errorMessage(error);
				stream.push({ type: "error", reason: "error", error: output });
			}
			stream.end();
		} finally {
			requestContext?.isolatedTransportState?.close();
		}
	})();

	return stream;
};

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAICodexResponsesOnce, { providerRetriesStalls: true });

export async function prewarmOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	options?: Pick<
		OpenAICodexResponsesOptions,
		"apiKey" | "headers" | "sessionId" | "signal" | "preferWebsockets" | "providerSessionState" | "responsesLite"
	>,
): Promise<void> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) return;
	const accountId = getCodexAccountId(apiKey);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);
	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const promptCacheKey = transportSessionId;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const responsesLite = resolveCodexResponsesLite(model, options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (publicSessionKey && sessionKey) {
		providerSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	if (!sessionKey || !providerSessionState) return;
	const state = getCodexWebSocketSessionState(sessionKey, providerSessionState);
	if (!shouldUseCodexWebSocket(model, state, options?.preferWebsockets)) return;
	const metadataSession = getOrCreateCodexMetadataSessionState(
		transportSessionId ?? crypto.randomUUID(),
		providerSessionState,
	);
	const codexClientVersion = CODEX_CLIENT_VERSION;
	const requestIdentity = createCodexCompatibilityIdentity(metadataSession);
	const headers = logger.time(
		"prewarmCodex:createHeaders",
		createCodexHeaders,
		{ ...(model.headers ?? {}), ...(options?.headers ?? {}) },
		accountId,
		apiKey,
		codexClientVersion,
		promptCacheKey,
		"websocket",
		state,
		responsesLite,
		requestIdentity,
	);
	await logger.time(
		"prewarmCodex:establishWs",
		getOrCreateCodexWebSocketConnection,
		state,
		toWebSocketUrl(url),
		headers,
		options?.signal,
	);
	state.prewarmed = true;
}

function getCodexWebSocketSessionKey(
	normalizedSessionId: string | undefined,
	model: Model<"openai-codex-responses">,
	accountId: string | undefined,
	apiKey: string,
	baseUrl: string,
	responsesLite: boolean,
): string | undefined {
	if (!normalizedSessionId) return undefined;
	const credentialKey = accountId ? `account:${accountId}` : `token:${Bun.hash(apiKey).toString(36)}`;
	const liteSuffix = responsesLite ? ":lite" : "";
	return `${credentialKey}:${baseUrl}:${model.id}:${normalizedSessionId}${liteSuffix}`;
}

function getCodexWebSocketSessionState(
	sessionKey: string,
	providerSessionState: CodexProviderSessionState,
): CodexWebSocketSessionState {
	const existing = providerSessionState.webSocketSessions.get(sessionKey);
	if (existing) return existing;
	const created: CodexWebSocketSessionState = {
		disableWebsocket: false,
		canAppend: false,
		fallbackCount: 0,
		prewarmed: false,
		stats: {
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
		},
	};
	providerSessionState.webSocketSessions.set(sessionKey, created);
	return created;
}

export function recordCodexWebSocketFailure(
	state: CodexWebSocketSessionState,
	activateFallback: boolean,
	reason?: { error?: string; cause?: string },
): void {
	resetCodexWebSocketAppendState(state);
	if (state.connection && !state.connection.isConnecting()) {
		state.connection.close("fallback");
		state.connection = undefined;
	}
	state.lastFallbackAt = Date.now();
	if (activateFallback && !state.disableWebsocket) {
		state.disableWebsocket = true;
		state.fallbackCount += 1;
		logger.warn(
			"[codex] the websocket transport failed and has been disabled, so the rest of this session runs over SSE and turns may be slower",
			{ cause: reason?.cause ?? "unknown", error: reason?.error, fallbackCount: state.fallbackCount },
		);
	}
}

function getCodexWebSocketEnvValue(): boolean | undefined {
	const envVal = $env.VEYYON_CODEX_WEBSOCKET;
	if (envVal !== undefined) {
		return $flag("VEYYON_CODEX_WEBSOCKET");
	}
	return undefined;
}

function shouldUseCodexWebSocket(
	model: Model<"openai-codex-responses">,
	state: CodexWebSocketSessionState | undefined,
	preferWebsockets?: boolean,
): boolean {
	if (model.preferWebsockets === false) return false;
	if (!state || state.disableWebsocket) return false;
	const envVal = getCodexWebSocketEnvValue();
	if (envVal !== undefined) return envVal;
	if (preferWebsockets === false) return false;
	return true;
}

export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	hasTurnState: boolean;
	lastFallbackAt?: number;
}

function getCodexWebSocketStateForPublicSession(
	model: Model<"openai-codex-responses">,
	options:
		| {
				sessionId?: string;
				baseUrl?: string;
				providerSessionState?: Map<string, ProviderSessionState>;
		  }
		| undefined,
): CodexWebSocketSessionState | undefined {
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const normalizedSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const publicSessionKey = normalizedSessionId ? `${baseUrl}:${model.id}:${normalizedSessionId}` : undefined;
	const privateSessionKey = publicSessionKey
		? providerSessionState?.webSocketPublicToPrivate.get(publicSessionKey)
		: undefined;
	return privateSessionKey ? providerSessionState?.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = getCodexWebSocketStateForPublicSession(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		preferWebsockets?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexTransportDetails {
	const envVal = getCodexWebSocketEnvValue();
	const websocketPreferred =
		envVal !== undefined
			? envVal
			: options?.preferWebsockets === false
				? false
				: options?.preferWebsockets === true || model.preferWebsockets === true;
	const state = getCodexWebSocketStateForPublicSession(model, options);

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		hasTurnState: state?.turnState !== undefined,
		lastFallbackAt: state?.lastFallbackAt,
	};
}

function stripInputItemIds(items: Array<Record<string, unknown>>): InputItem[] {
	return items.map(item => {
		if (item.id == null) return item as InputItem;
		const { id: _id, ...rest } = item;
		return rest as InputItem;
	});
}

const codexDiagnosticsTextEncoder = new TextEncoder();

function jsonByteLength(value: unknown): number {
	const json = JSON.stringify(value);
	return codexDiagnosticsTextEncoder.encode(json === undefined ? "undefined" : json).byteLength;
}

function hashJson(value: unknown): string {
	const json = JSON.stringify(value);
	return String(Bun.hash(json === undefined ? "undefined" : json));
}

function parseCodexServiceTier(value: unknown): ServiceTier | undefined {
	switch (value) {
		case "auto":
		case "default":
		case "flex":
		case "scale":
		case "priority":
			return value;
		default:
			return undefined;
	}
}

function parseCodexResponseStatus(value: unknown): ResponseStatus | undefined {
	switch (value) {
		case "completed":
		case "failed":
		case "in_progress":
		case "cancelled":
		case "queued":
		case "incomplete":
			return value;
		default:
			return undefined;
	}
}

function parseCodexResponseUsage(value: unknown): CodexResponseUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage: CodexResponseUsage = {};
	let hasUsage = false;
	if ("input_tokens" in value && typeof value.input_tokens === "number") {
		usage.input_tokens = value.input_tokens;
		hasUsage = true;
	}
	if ("output_tokens" in value && typeof value.output_tokens === "number") {
		usage.output_tokens = value.output_tokens;
		hasUsage = true;
	}
	if ("total_tokens" in value && typeof value.total_tokens === "number") {
		usage.total_tokens = value.total_tokens;
		hasUsage = true;
	}
	if ("prompt_cache_hit_tokens" in value && typeof value.prompt_cache_hit_tokens === "number") {
		usage.prompt_cache_hit_tokens = value.prompt_cache_hit_tokens;
		hasUsage = true;
	}
	if (
		"input_tokens_details" in value &&
		value.input_tokens_details &&
		typeof value.input_tokens_details === "object"
	) {
		const details = value.input_tokens_details;
		const parsedDetails: NonNullable<CodexResponseUsage["input_tokens_details"]> = {};
		let hasDetails = false;
		if ("cached_tokens" in details && typeof details.cached_tokens === "number") {
			parsedDetails.cached_tokens = details.cached_tokens;
			hasDetails = true;
		}
		if ("cache_write_tokens" in details && typeof details.cache_write_tokens === "number") {
			parsedDetails.cache_write_tokens = details.cache_write_tokens;
			hasDetails = true;
		}
		if ("orchestration_input_tokens" in details && typeof details.orchestration_input_tokens === "number") {
			parsedDetails.orchestration_input_tokens = details.orchestration_input_tokens;
			hasDetails = true;
		}
		if (
			"orchestration_input_cached_tokens" in details &&
			typeof details.orchestration_input_cached_tokens === "number"
		) {
			parsedDetails.orchestration_input_cached_tokens = details.orchestration_input_cached_tokens;
			hasDetails = true;
		}
		if (hasDetails) {
			usage.input_tokens_details = parsedDetails;
			hasUsage = true;
		}
	}
	if (
		"output_tokens_details" in value &&
		value.output_tokens_details &&
		typeof value.output_tokens_details === "object"
	) {
		const details = value.output_tokens_details;
		const parsedDetails: NonNullable<CodexResponseUsage["output_tokens_details"]> = {};
		let hasDetails = false;
		if ("reasoning_tokens" in details && typeof details.reasoning_tokens === "number") {
			parsedDetails.reasoning_tokens = details.reasoning_tokens;
			hasDetails = true;
		}
		if ("orchestration_output_tokens" in details && typeof details.orchestration_output_tokens === "number") {
			parsedDetails.orchestration_output_tokens = details.orchestration_output_tokens;
			hasDetails = true;
		}
		if (hasDetails) {
			usage.output_tokens_details = parsedDetails;
			hasUsage = true;
		}
	}
	return hasUsage ? usage : undefined;
}

function describeCodexInputItemType(item: unknown): string {
	if (item && typeof item === "object") {
		if ("type" in item && typeof item.type === "string") return item.type;
		if ("role" in item && typeof item.role === "string") return item.role;
	}
	return typeof item;
}

function createCodexOptionsHash(request: Record<string, unknown>): string {
	const options: Record<string, unknown> = {};
	for (const key in request) {
		if (key === "input" || key === "previous_response_id" || key === "type" || key === "client_metadata") {
			continue;
		}
		options[key] = request[key];
	}
	return hashJson(options);
}

function buildCodexTurnRequestDiagnostics(
	request: Record<string, unknown>,
	transport: CodexTransport,
	canAppendBeforeRequest: boolean,
): OpenAICodexTurnRequestDiagnostics {
	const input = request.input;
	const inputItems = Array.isArray(input) ? input : [];
	const inputItemTypes = inputItems.map(describeCodexInputItemType);
	const promptCacheKey = typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined;
	const toolsHash = request.tools === undefined ? undefined : hashJson(request.tools);
	return {
		transport,
		previousResponseIdPresent:
			typeof request.previous_response_id === "string" && request.previous_response_id.length > 0,
		inputItemCount: inputItems.length,
		inputItemTypes,
		...(inputItemTypes[0] ? { firstInputItemType: inputItemTypes[0] } : {}),
		inputJsonBytes: jsonByteLength(inputItems),
		...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
		...(toolsHash !== undefined ? { toolsHash } : {}),
		optionsHash: createCodexOptionsHash(request),
		canAppendBeforeRequest,
	};
}

function recordCodexTurnRequestDiagnostics(
	state: CodexWebSocketSessionState | undefined,
	request: Record<string, unknown>,
	transport: CodexTransport,
	canAppendBeforeRequest: boolean,
): void {
	if (!state) return;
	const input = request.input;
	state.stats.lastInputItems = Array.isArray(input) ? input.length : 0;
	const previousResponseId =
		typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
	if (previousResponseId && previousResponseId.length > 0) {
		state.stats.deltaRequests += 1;
		state.stats.lastDeltaInputItems = state.stats.lastInputItems;
		state.stats.lastPreviousResponseId = previousResponseId;
	} else {
		state.stats.fullContextRequests += 1;
		state.stats.lastDeltaInputItems = undefined;
		state.stats.lastPreviousResponseId = undefined;
	}
	state.stats.lastTurn = {
		request: buildCodexTurnRequestDiagnostics(request, transport, canAppendBeforeRequest),
	};
	CODEX_DEBUG && logger.debug("[codex] codex turn request diagnostics", { diagnostics: state.stats.lastTurn.request });
}

function recordCodexTurnUsageDiagnostics(
	state: CodexWebSocketSessionState | undefined,
	rawUsage: CodexResponseUsage | undefined,
	displayedUsage: Usage,
): void {
	if (!state?.stats.lastTurn || !rawUsage) return;
	const details = rawUsage.input_tokens_details;
	const outputDetails = rawUsage.output_tokens_details;
	const rawInputTokens = rawUsage.input_tokens ?? 0;
	const rawCachedTokens = details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const usageDiagnostics: OpenAICodexTurnUsageDiagnostics = {
		rawInputTokens,
		rawCachedTokens,
		rawUncachedTokens: Math.max(0, rawInputTokens - rawCachedTokens),
		rawOutputTokens: rawUsage.output_tokens ?? 0,
		...(typeof rawUsage.total_tokens === "number" ? { rawTotalTokens: rawUsage.total_tokens } : {}),
		...(typeof details?.orchestration_input_tokens === "number"
			? { rawOrchestrationInputTokens: details.orchestration_input_tokens }
			: {}),
		...(typeof details?.orchestration_input_cached_tokens === "number"
			? { rawOrchestrationCachedTokens: details.orchestration_input_cached_tokens }
			: {}),
		...(typeof outputDetails?.orchestration_output_tokens === "number"
			? { rawOrchestrationOutputTokens: outputDetails.orchestration_output_tokens }
			: {}),
		displayedInputTokens: displayedUsage.input,
		displayedOutputTokens: displayedUsage.output,
		displayedCacheReadTokens: displayedUsage.cacheRead,
		displayedCacheWriteTokens: displayedUsage.cacheWrite,
		displayedTotalTokens: displayedUsage.totalTokens,
		displayedOrchestrationInputTokens: displayedUsage.orchestration?.input ?? 0,
		displayedOrchestrationCacheReadTokens: displayedUsage.orchestration?.cacheRead ?? 0,
		displayedOrchestrationOutputTokens: displayedUsage.orchestration?.output ?? 0,
	};
	state.stats.lastTurn = {
		...state.stats.lastTurn,
		usage: usageDiagnostics,
	};
	CODEX_DEBUG && logger.debug("[codex] codex turn diagnostics", { diagnostics: state.stats.lastTurn });
}

function buildCodexChainedRequestBody(
	requestBody: RequestBody,
	state: CodexWebSocketSessionState | undefined,
): RequestBody {
	const chainable = state?.canAppend === true;
	const appendInput = chainable
		? buildResponsesDeltaInput(state.lastRequest, state.lastResponseItems, requestBody)
		: null;
	if (appendInput && appendInput.length > 0 && state?.lastResponseId) {
		return { ...requestBody, previous_response_id: state.lastResponseId, input: appendInput };
	}
	if (chainable && state) {
		CODEX_DEBUG &&
			logger.debug("[codex] codex append reset", {
				hadTurnStateHeader: Boolean(state.turnState),
				hadModelsEtagHeader: Boolean(state.modelsEtag),
			});
		resetCodexWebSocketAppendState(state);
		state.turnState = undefined;
		state.modelsEtag = undefined;
	}
	return requestBody;
}

function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

interface CodexWebSocketRequestTimeouts {
	idleTimeoutMs?: number;
	firstEventTimeoutMs?: number;
}

interface CodexWebSocketConnectionOptions {
	onHandshakeHeaders?: (headers: Headers) => void;
}

export class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;
	#streamObserver?: (event: RawSseEvent) => void;
	#heartbeatInterval: NodeJS.Timeout | undefined;
	#removePongListener?: () => void;
	#handshakeHeaders?: Headers;
	#debugResponseLog?: RequestDebugResponseLog;
	#lastInboundAt = 0;
	#lastPingAt = 0;
	#lastSeenResponseId?: string;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	isConnecting(): boolean {
		return this.#connectPromise !== undefined;
	}

	isHealthyForReuse(): boolean {
		if (!this.isOpen()) return false;
		const maxIdleMs = CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS;
		if (maxIdleMs <= 0) return true;
		if (this.#lastInboundAt === 0) return false;
		return Date.now() - this.#lastInboundAt <= maxIdleMs;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		if (
			this.#socket &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
		this.#stopHeartbeat();
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const clearPending = () => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			socket.close(1000, "aborted");
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`request was aborted`));
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		if (!settled) {
			timeout = setTimeout(() => {
				socket.close(1000, "connect-timeout");
				if (!settled) {
					settled = true;
					clearPending();
					reject(new CodexWebSocketTransportError(`connection timeout`));
				}
			}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);
		}

		socket.onopen = event => {
			if (!settled) {
				settled = true;
				clearPending();
				this.#lastInboundAt = Date.now();
				this.#captureHandshakeHeaders(socket, event);
				this.#startHeartbeat(socket);
				resolve();
			}
		};
		socket.onerror = event => {
			const eventRecord = event as unknown as Record<string, unknown>;
			const detail =
				(typeof eventRecord.message === "string" && eventRecord.message) ||
				(eventRecord.error instanceof Error && eventRecord.error.message) ||
				String(event.type);
			const error = new CodexWebSocketTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			this.#stopHeartbeat();
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(new CodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			this.#lastInboundAt = Date.now();
			this.#writeDebugWebSocketFrame(event.data);
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (parsed.type === "error" && typeof parsed.error === "object" && parsed.error) {
					const inner = parsed.error as Record<string, unknown>;
					if (typeof parsed.code !== "string" && typeof inner.code === "string") {
						parsed.code = inner.code;
					}
					if (typeof parsed.message !== "string" && typeof inner.message === "string") {
						parsed.message = inner.message;
					}
				}
				notifyCodexWebSocketInbound(this.#streamObserver, parsed, text);
				this.#push(parsed);
			} catch (error) {
				notifyCodexWebSocketMalformed(this.#streamObserver, event.data, error);
				this.#push(new CodexWebSocketTransportError(`${String(error)}`));
			}
		};

		logger.time("codexWs:awaitTcpHandshake");
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		timeouts: CodexWebSocketRequestTimeouts,
		signal?: AbortSignal,
		onSseEvent?: (event: RawSseEvent) => void,
	): AsyncGenerator<Record<string, unknown>> {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
		}
		if (this.#activeRequest) {
			throw new CodexWebSocketTransportError(`websocket request already in progress`);
		}
		if (signal?.aborted) {
			throw new CodexWebSocketTransportError(`request was aborted`);
		}
		this.#activeRequest = true;
		this.#streamObserver = onSseEvent;
		this.#dropStaleFrames();
		const onAbort = () => {
			this.close("aborted");
			this.#push(new CodexWebSocketTransportError(`request was aborted`));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });

		try {
			const debugSession = isRequestDebugEnabled()
				? await createRequestDebugSession({
						protocol: "websocket",
						method: "POST",
						url: this.#url,
						headers: this.#headers,
						body: request,
					})
				: undefined;
			this.#debugResponseLog = debugSession
				? await debugSession.openResponseLog("WebSocket 101 Switching Protocols", this.#handshakeHeaders)
				: undefined;

			const requestPayload = JSON.stringify(request);
			notifyCodexWebSocketOutbound(onSseEvent, request, requestPayload);
			const socket = this.#socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
			}
			try {
				socket.send(requestPayload);
			} catch (error) {
				throw new CodexWebSocketTransportError(`websocket send failed: ${errorMessage(error)}`);
			}
			let sawFirstEvent = false;
			const { idleTimeoutMs, firstEventTimeoutMs } = timeouts;
			let lastProgressAt = Date.now();
			let lastProgressEventType: string | undefined;
			let lastEventAt = lastProgressAt;
			let lastEventType: string | undefined;
			let activeResponseId: string | undefined;
			let lastSequence: number | undefined;
			const priorResponseId = this.#lastSeenResponseId;
			while (true) {
				let timeoutMs: number | undefined;
				let timeoutReason: string;
				if (sawFirstEvent) {
					timeoutReason = createCodexWebSocketTimeoutMessage("idle timeout waiting for websocket", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
						timeoutMs = idleTimeoutMs - (Date.now() - lastProgressAt);
						if (timeoutMs <= 0) {
							CODEX_DEBUG &&
								logger.debug("[codex] codex websocket idle timeout", {
									lastEventType,
									lastProgressEventType,
									msSinceLastEvent: Date.now() - lastEventAt,
									msSinceLastProgress: Date.now() - lastProgressAt,
								});
							throw new CodexWebSocketTransportError(`${timeoutReason}`);
						}
					}
				} else {
					timeoutReason = createCodexWebSocketTimeoutMessage("timeout waiting for first websocket event", {
						lastEventAt,
						lastEventType,
						lastProgressAt,
						lastProgressEventType,
					});
					if (firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0) {
						timeoutMs = firstEventTimeoutMs;
					}
				}
				const next = await this.#nextMessage(timeoutMs, timeoutReason);
				if (next instanceof Error) {
					throw next;
				}
				if (next === null) {
					throw new CodexWebSocketTransportError(`websocket closed before response completion`);
				}
				const eventType = typeof next.type === "string" ? next.type : "";
				const frameResponseId = extractCodexFrameResponseId(next);
				const frameSequence = extractCodexFrameSequenceNumber(next);
				if (frameResponseId !== undefined) {
					if (activeResponseId === undefined) {
						if (priorResponseId !== undefined && frameResponseId === priorResponseId) {
							continue;
						}
						activeResponseId = frameResponseId;
					} else if (frameResponseId !== activeResponseId) {
						this.close("stale-frame");
						throw new CodexWebSocketTransportError(
							`websocket frame for response ${frameResponseId} interleaved into active response ${activeResponseId}`,
						);
					}
					this.#lastSeenResponseId = frameResponseId;
				}
				if (frameSequence !== undefined) {
					if (activeResponseId !== undefined && lastSequence !== undefined && frameSequence < lastSequence) {
						this.close("stale-frame");
						throw new CodexWebSocketTransportError(
							`websocket sequence_number ${frameSequence} regressed below ${lastSequence} within response ${activeResponseId}`,
						);
					}
					lastSequence = frameSequence;
				}
				sawFirstEvent = true;
				lastEventAt = Date.now();
				lastEventType = eventType || undefined;
				if (isCodexStreamProgressEvent(next)) {
					lastProgressAt = lastEventAt;
					lastProgressEventType = lastEventType;
				}
				yield next;
				if (
					eventType === "response.completed" ||
					eventType === "response.done" ||
					eventType === "response.incomplete" ||
					eventType === "response.failed" ||
					eventType === "error"
				) {
					break;
				}
			}
		} finally {
			this.#activeRequest = false;
			this.#streamObserver = undefined;
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			const debugResponseLog = this.#debugResponseLog;
			this.#debugResponseLog = undefined;
			await debugResponseLog?.close();
		}
	}

	#captureHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): void {
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (!headers) return;
		this.#handshakeHeaders = headers;
		this.#onHandshakeHeaders?.(headers);
	}

	#writeDebugWebSocketFrame(data: unknown): void {
		const log = this.#debugResponseLog;
		if (!log) return;
		if (typeof data === "string") {
			log.write(data);
			return;
		}
		if (data instanceof Uint8Array) {
			log.write(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			log.write(new Uint8Array(data));
			return;
		}
		log.write(String(data));
	}

	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		const intervalMs = CODEX_WEBSOCKET_PING_INTERVAL_MS;
		if (intervalMs <= 0) return;

		this.#lastPingAt = 0;
		const socketEventTarget = socket as EventTarget;
		const onPong = () => {
			this.#lastInboundAt = Date.now();
		};
		if (
			typeof socketEventTarget.addEventListener === "function" &&
			typeof socketEventTarget.removeEventListener === "function"
		) {
			socketEventTarget.addEventListener("pong", onPong);
			this.#removePongListener = () => socketEventTarget.removeEventListener("pong", onPong);
		}

		this.#heartbeatInterval = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}
			const pongTimeoutMs = CODEX_WEBSOCKET_PONG_TIMEOUT_MS;
			if (
				pongTimeoutMs > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > pongTimeoutMs
			) {
				this.#failQueue(new CodexWebSocketTransportError(`websocket pong timeout`), "pong-timeout");
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#failQueue(
					new CodexWebSocketTransportError(`websocket ping failed: ${errorMessage(error)}`),
					"ping-failed",
				);
			}
		}, intervalMs);
		this.#heartbeatInterval.unref();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatInterval) {
			clearInterval(this.#heartbeatInterval);
			this.#heartbeatInterval = undefined;
		}
		if (this.#removePongListener) {
			this.#removePongListener();
			this.#removePongListener = undefined;
		}
		this.#lastPingAt = 0;
	}

	#failQueue(error: Error, closeReason: string): void {
		CODEX_DEBUG && logger.debug("[codex] codex websocket transport failure", { error: error.message, closeReason });
		this.#queue.length = 0;
		this.#queue.push(error);
		this.close(closeReason);
		this.#wakeWaiters();
	}

	#dropStaleFrames(): number {
		if (this.#queue.length === 0) return 0;
		const surviving = this.#queue.filter(item => item instanceof Error);
		const dropped = this.#queue.length - surviving.length;
		if (dropped === 0) return 0;
		this.#queue.length = 0;
		for (const item of surviving) this.#queue.push(item);
		CODEX_DEBUG && logger.debug("[codex] codex websocket dropped stale frames before request", { dropped });
		return dropped;
	}

	#wakeWaiters(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: Record<string, unknown> | Error | null): void {
		if (item instanceof Error) {
			this.#queue.push(item);
			this.#wakeWaiters();
			return;
		}
		if (item !== null && this.#queue.length >= CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY) {
			this.#failQueue(
				new CodexWebSocketTransportError(
					`websocket message queue exceeded ${CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY} items`,
				),
				"queue-overflow",
			);
			return;
		}
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextMessage(
		timeoutMs: number | undefined,
		timeoutReason: string,
	): Promise<Record<string, unknown> | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					resolve();
				}, timeoutMs);
			}
			await promise;
			if (timeout) clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) {
				return new CodexWebSocketTransportError(`${timeoutReason}`);
			}
		}
		return this.#queue.shift() ?? null;
	}
}

async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	url: string,
	headers: Headers,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const headerRecord = headersToRecord(headers);
	for (let joinAttempt = 0; joinAttempt < 3; joinAttempt += 1) {
		const pending = state.connection;
		if (!pending || pending.isOpen() || !pending.isConnecting()) break;
		try {
			await pending.connect(signal);
		} catch {}
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (state.connection.isHealthyForReuse()) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		} else {
			CODEX_DEBUG && logger.debug("[codex] codex websocket reuse rejected by health check", {});
			state.connection.close("stale-reuse");
			resetCodexWebSocketAppendState(state);
		}
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(state, handshakeHeaders);
		},
	});
	await state.connection.connect(signal);
	return state.connection;
}

async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	responsesLite: boolean,
	codexClientVersion: string,
	requestMetadata: CodexRequestMetadata | undefined,
	signal: AbortSignal | undefined,
	firstEventTimeoutMs: number | undefined,
	firstEventBudget: FirstEventBudget,
	maxRetryDelayMs: number | undefined,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
	prepareBody: () => RequestBody | Promise<RequestBody> = () => structuredCloneJSON(body),
): Promise<OpenAIStreamHandle<Record<string, unknown>>> {
	const headers = createCodexHeaders(
		requestHeaders,
		accountId,
		apiKey,
		codexClientVersion,
		sessionId,
		"sse",
		state,
		responsesLite,
		requestMetadata,
	);
	CODEX_DEBUG &&
		logger.debug("[codex] codex request", {
			url,
			model: body.model,
			headers: redactHeaders(headers),
			sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
		});
	let clearPreResponseTimeout: (() => void) | undefined;
	const fetchAttempt: FetchImpl = async (input, init) => {
		try {
			return await (fetchOverride ?? fetch)(input, init);
		} finally {
			clearPreResponseTimeout?.();
			clearPreResponseTimeout = undefined;
		}
	};
	let response: Response;
	try {
		response = await fetchProviderWithRetry(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
			prepareInit: async () => {
				const wireBody = await prepareBody();
				const watchdog = armPreResponseTimeout(signal, firstEventTimeoutMs);
				clearPreResponseTimeout = watchdog.clear;
				return { body: JSON.stringify(wireBody), signal: watchdog.signal };
			},
			maxAttempts: CODEX_MAX_RETRIES + 1,
			defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
			maxDelayMs: maxRetryDelayMs ?? CODEX_RATE_LIMIT_BUDGET_MS,
			shouldRetryError: error => !(isPreResponseStall(error) && firstEventBudget.spent()),
			fetch: fetchAttempt,
			timeout: false,
		});
	} finally {
		clearPreResponseTimeout?.();
	}
	CODEX_DEBUG &&
		logger.debug("[codex] codex response", {
			url: response.url,
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") || null,
			cfRay: response.headers.get("cf-ray") || null,
		});
	if (!response.ok) {
		throw await CodexApiError.fromResponse(response);
	}
	updateCodexSessionMetadataFromHeaders(state, response.headers);
	if (!response.body) {
		throw new CodexProviderStreamError("No response body", { retryable: false });
	}
	const events = readSseJson<Record<string, unknown>>(response.body, signal, event =>
		notifyRawSseEvent(onSseEvent, { event: event.event, data: event.data, raw: event.raw.slice() }),
	);
	return { events, response, requestId: response.headers.get("x-request-id") };
}

function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string): string => {
		if (!id.includes("|")) return id;
		const [callId, itemId] = id.split("|");
		const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
		let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitizedItemId.startsWith("fc")) {
			sanitizedItemId = `fc_${sanitizedItemId}`;
		}
		let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
		let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
		normalizedCallId = normalizedCallId.replace(/_+$/, "");
		normalizedItemId = normalizedItemId.replace(/_+$/, "");
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	let msgIndex = 0;
	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider) as
				| Array<ResponseInput[number]>
				| undefined;
			if (historyItems) {
				for (const item of historyItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				for (let hi = 0; hi < historyItems.length; hi++) messages.push(historyItems[hi]!);
				msgIndex += 1;
				continue;
			}

			if (
				msg.role === "developer" &&
				Array.isArray(msg.content) &&
				msg.content.some(item => item.type === "image")
			) {
				const textContent = normalizeInputMessageContent(
					model,
					msg.content.filter((item): item is TextContent => item.type === "text"),
				);
				const imageContent = normalizeInputMessageContent(
					model,
					msg.content.filter(item => item.type === "image"),
				);
				if (textContent.length > 0) messages.push({ role: "developer", content: textContent });
				if (imageContent.length > 0) messages.push({ role: "user", content: imageContent });
				msgIndex += 1;
				continue;
			}
			const normalizedContent = normalizeInputMessageContent(model, msg.content);
			if (normalizedContent.length === 0) continue;
			messages.push({ role: msg.role, content: normalizedContent });
			msgIndex += 1;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload =
				assistantMsg.api === model.api && assistantMsg.model === model.id
					? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
					: undefined;
			const historyItems = providerPayload?.items as Array<Record<string, unknown>> | undefined;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(historyItems);
				if (sanitizedHistoryItems) {
					for (const item of sanitizedHistoryItems) {
						const maybe = item as { type?: string; call_id?: string };
						if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
							customCallIds.add(maybe.call_id);
						}
					}
					if (providerPayload?.dt) {
						for (let hi = 0; hi < sanitizedHistoryItems.length; hi++) messages.push(sanitizedHistoryItems[hi]!);
					} else {
						messages.splice(0, messages.length, ...sanitizedHistoryItems);
					}
					msgIndex += 1;
					continue;
				}
				suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				msg as AssistantMessage,
				model,
				msgIndex,
				knownCallIds,
				!suppressHiddenEmptyFallback,
				customCallIds,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length > 0) {
				for (let oi = 0; oi < outputItems.length; oi++) messages.push(outputItems[oi]!);
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				model,
				false,
				model.compat.supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
			);
		}

		msgIndex += 1;
	}

	return messages;
}

function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content: string | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>,
): ResponseInputContent[] {
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		return [{ type: "input_text", text: content.toWellFormed() }];
	}

	return (
		convertResponsesInputContent(content, model.input.includes("image"), model.compat.supportsImageDetailOriginal) ??
		[]
	);
}

export { convertMessages as convertCodexResponsesMessages };

type CodexToolPayload =
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

export function convertOpenAICodexResponsesTools(
	tools: Tool[],
	model: Model<"openai-codex-responses">,
): CodexToolPayload[] {
	const allowFreeform = model.applyPatchToolType === "freeform";
	return tools.map((tool): CodexToolPayload => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			};
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool));
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict ? { strict: true } : !NO_STRICT && tool.strict === false ? { strict: false } : {}),
		};
	});
}

interface CodexErrorDetail {
	code?: string | undefined;
	type?: string | undefined;
	message?: string | undefined;
}

interface CodexFailureResponse {
	error?: CodexErrorDetail | undefined;
	message?: string | undefined;
	status?: string | undefined;
}

interface CodexFailureEvent {
	type?: string | undefined;
	code?: string | undefined;
	message?: string | undefined;
	status?: string | undefined;
	error?: CodexErrorDetail | undefined;
	response?: CodexFailureResponse | undefined;
}

function readCodexErrorDetail(value: unknown): CodexErrorDetail | undefined {
	const fields = toFields(value);
	if (!fields) {
		return undefined;
	}
	return {
		code: toStringValue(fields.code),
		type: toStringValue(fields.type),
		message: toStringValue(fields.message),
	};
}

function readCodexFailureEvent(rawEvent: Record<string, unknown>): CodexFailureEvent {
	const response = toFields(rawEvent.response);
	return {
		type: toStringValue(rawEvent.type),
		code: toStringValue(rawEvent.code),
		message: toStringValue(rawEvent.message),
		status: toStringValue(rawEvent.status),
		error: readCodexErrorDetail(rawEvent.error),
		response: response
			? {
					error: readCodexErrorDetail(response.error),
					message: toStringValue(response.message),
					status: toStringValue(response.status),
				}
			: undefined,
	};
}

export function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const event = readCodexFailureEvent(rawEvent);
	const error = event.error ?? event.response?.error;
	const code = error?.code ?? error?.type ?? event.code;
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code.toLowerCase())) {
		return true;
	}
	const message = error?.message ?? event.message ?? event.response?.message;
	return !!message && AIError.isTransientErrorText(message);
}

export function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const event = readCodexFailureEvent(rawEvent);
	const nestedError = event.error ?? event.response?.error;
	const code = nestedError?.code ?? nestedError?.type ?? event.code ?? "";
	const message = event.message ?? "";
	const formattedMessage =
		event.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, {
		retryable: isRetryableCodexFailureEvent(rawEvent),
		code: code || undefined,
	});
}

function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const event = readCodexFailureEvent(rawEvent);
	const error = event.error ?? event.response?.error;
	const message = error?.message ?? event.message ?? event.response?.message;
	const code = error?.code ?? error?.type ?? event.code;
	const status = event.response?.status ?? event.status;

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex response failed: ${truncatedRawEventJson}`;
	} catch {
		return "Codex response failed";
	}
}

function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex error event: ${truncatedRawEventJson}`;
	} catch {
		return "Codex error event";
	}
}
