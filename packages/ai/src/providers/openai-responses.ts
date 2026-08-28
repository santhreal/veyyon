import { hostMatchesUrl } from "@veyyon/catalog/hosts";
import { $flag } from "@veyyon/utils/env";
import { structuredCloneJSON } from "@veyyon/utils/json";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAICompat,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	ToolChoice,
} from "../types";
import { createOpenAIResponsesHistoryPayload, sanitizeOpenAIResponsesAssistantHistoryItemsForReplay } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, type OpenAIStreamHandle, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../utils/sse-debug";
import type { CacheControlEphemeral } from "./anthropic-wire";
import { formatOpenAIInputText, type OpenAIPromptCachePolicy } from "./openai-prompt-cache";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallbackState,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import { buildParams } from "./openai-responses-helpers";
import type { ResponseCreateParamsStreaming, ResponseInput, ResponseStreamEvent } from "./openai-responses-wire";
import {
	buildResponsesDeltaInput,
	clearOpenAIStrictToolsState,
	createInitialResponsesAssistantMessage,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIResponsesRoutingSessionId,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isOpenAIResponsesProgressEvent,
	isOpenRouterAnthropicModel,
	type OpenAIStrictToolsState,
	processResponsesStream,
	resolveOpenAIRequestSetup,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";

export {
	buildParams,
	convertTools,
	mapOpenAIResponsesToolChoiceForTools,
	supportsFreeformApplyPatch,
} from "./openai-responses-helpers";

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: ToolChoice;
	openrouterVariant?: string;
	maxTokensExplicit?: boolean;
	disableReasoning?: boolean;
	statefulResponses?: boolean;
	strictResponsesPairing?: boolean;
	includeEncryptedReasoning?: boolean;
	filterReasoningHistory?: boolean;
	omitReasoningEffort?: boolean;
	headers?: Record<string, string>;
	extraBody?: Record<string, unknown>;
}

const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";
const OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT = 3;

export interface OpenAIResponsesProviderSessionState
	extends ProviderSessionState,
		OpenAIStrictToolsState,
		OpenAIReasoningEffortFallbackState {
	nativeHistoryReplayWarmed: boolean;
	chains: Map<string, OpenAIResponsesChainState>;
}

interface OpenAIResponsesChainState {
	lastParams?: OpenAIResponsesSamplingParams;
	lastResponseId?: string;
	lastResponseItems?: ResponseInput;
	canAppend: boolean;
	staleFailures: number;
	disabled: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAIResponsesProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		nativeHistoryReplayWarmed: false,
		chains: new Map(),
		close: () => {
			state.nativeHistoryReplayWarmed = false;
			state.chains.clear();
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

function getOpenAIResponsesProviderSessionState(
	model: Model<"openai-responses">,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAIResponsesProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`;
	const existing = providerSessionState.get(key) as OpenAIResponsesProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAIResponsesProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

function isOpenAIResponsesStatefulEnabled(
	options: OpenAIResponsesOptions | undefined,
	baseUrl: string | undefined,
): boolean {
	if (options?.statefulResponses === false) return false;
	if (options?.statefulResponses === true) return true;
	return $flag("VEYYON_OPENAI_STATEFUL", !baseUrl || hostMatchesUrl(baseUrl, "openai"));
}

function getOpenAIResponsesChainState(
	providerSessionState: OpenAIResponsesProviderSessionState,
	model: Model<"openai-responses">,
	resolvedBaseUrl: string | undefined,
	sessionId: string,
): OpenAIResponsesChainState {
	const key = `${resolvedBaseUrl ?? model.baseUrl ?? ""}\u0000${model.id}\u0000${sessionId}`;
	const existing = providerSessionState.chains.get(key);
	if (existing) return existing;
	const created: OpenAIResponsesChainState = { canAppend: false, staleFailures: 0, disabled: false };
	providerSessionState.chains.set(key, created);
	return created;
}

function resetOpenAIResponsesChainState(state: OpenAIResponsesChainState): void {
	state.canAppend = false;
	state.lastParams = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

interface OpenAIResponsesChainedParams {
	params: OpenAIResponsesSamplingParams;
	previousResponseId?: string;
}

function buildOpenAIResponsesChainedParams(
	params: OpenAIResponsesSamplingParams,
	chain: OpenAIResponsesChainState,
): OpenAIResponsesChainedParams {
	const deltaInput = chain.canAppend
		? buildResponsesDeltaInput(chain.lastParams, chain.lastResponseItems, params)
		: null;
	if (deltaInput && deltaInput.length > 0 && chain.lastResponseId) {
		return {
			params: { ...params, previous_response_id: chain.lastResponseId, input: deltaInput },
			previousResponseId: chain.lastResponseId,
		};
	}
	if (chain.canAppend) {
		// History mutated or options changed — break the chain and replay in full.
		resetOpenAIResponsesChainState(chain);
	}
	return { params };
}

function isOpenAIResponsesStalePreviousResponseError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ((error as { code?: string }).code === "previous_response_not_found") return true;
	return (
		/previous[ _]?response/i.test(error.message) &&
		/not[ _]?found|invalid|expired|stale|unsupported/i.test(error.message)
	);
}

function registerOpenAIResponsesChainStaleFailure(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.staleFailures += 1;
	if (chain.staleFailures >= OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT) {
		chain.disabled = true;
	}
	logger.debug("OpenAI responses previous_response_id rejected; falling back to full context", {
		error: errorMessage(error),
		consecutiveFailures: chain.staleFailures,
		disabled: chain.disabled,
	});
}

function markOpenAIResponsesChainZeroDataRetention(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.disabled = true;
	chain.staleFailures = OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT;
	logger.debug("OpenAI responses chaining disabled (Zero Data Retention)", {
		error: errorMessage(error),
	});
}

export type OpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	session_id?: string;
	stream_options?: { include_obfuscation?: boolean };
	provider?: OpenAICompat["openRouterRouting"];
	reasoning?: { effort?: string } | { enabled: false };
	cache_control?: CacheControlEphemeral;
};

export function buildDeveloperSystemInput(
	systemPrompts: readonly string[],
	cachePolicy: OpenAIPromptCachePolicy,
): ResponseInput[number][] {
	return systemPrompts.map((systemPrompt, index) => {
		const content =
			index === 0 && cachePolicy.stablePrefixBreakpoint
				? [formatOpenAIInputText(systemPrompt, cachePolicy)]
				: systemPrompt;
		return { role: "developer", content } as ResponseInput[number];
	});
}

export function maybeAddOpenRouterAnthropicCacheControl(
	params: OpenAIResponsesSamplingParams,
	model: Model<"openai-responses">,
	cacheRetention: CacheRetention,
): void {
	if (cacheRetention === "none" || !isOpenRouterAnthropicModel(model)) return;
	if (params.cache_control != null) return;
	params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

const streamOpenAIResponsesOnce = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let wireBodyJson: string | undefined;

		let chainState: OpenAIResponsesChainState | undefined;
		let sentPreviousResponseId: string | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		const modelSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;
		const rawSseObserver = modelSseObserver
			? (event: RawSseEvent) => {
					resolveOpenAiSseEventName(event);
					notifyRawSseEvent(modelSseObserver, event);
				}
			: undefined;

		try {
			// Keep request routing on `sessionId` while allowing callers to pin a
			// stable prompt-cache key independently. Side-channel calls use this to
			// avoid perturbing provider conversation state without cold-starting the cache.
			const routingSessionId = getOpenAIResponsesRoutingSessionId(options);
			const promptCacheSessionId = getOpenAIPromptCacheKey(options);
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const { headers, copilotPremiumRequests, baseUrl } = resolveOpenAIRequestSetup(model, {
				apiKey,
				extraHeaders: options?.headers,
				initiatorOverride: options?.initiatorOverride,
				messages: context.messages,
				openAISessionId: routingSessionId,
				promptCacheSessionId,
			});
			const premiumRequestsTotal = copilotPremiumRequests;
			const providerSessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			const builtParams = buildParams(model, context, options, providerSessionState, strictToolsScope);
			const params = builtParams.params;
			let activeParams = params;
			const resolvedBaseUrl = trimTrailingSlashes(baseUrl ?? "https://api.openai.com/v1");
			const requestReasoningEffortFallbacks = new Map<string, OpenAIReasoningEffortFallback>();
			const attemptedReasoningEffortFallbacks = new Set<string>();
			let pendingReasoningEffortFallback: { key: string; fallback: OpenAIReasoningEffortFallback } | undefined;
			let activeReasoningEffortFallbackKey: string | undefined;
			let activeRequestParams: OpenAIResponsesSamplingParams | undefined;
			const applyReasoningEffortFallbackForRequest = (requestParams: OpenAIResponsesSamplingParams): string => {
				const fallbackKey = createOpenAIReasoningEffortFallbackKey(
					"responses",
					resolvedBaseUrl,
					typeof requestParams.model === "string" ? requestParams.model : model.id,
				);
				const requestReasoningEffortFallback = requestReasoningEffortFallbacks.has(fallbackKey)
					? requestReasoningEffortFallbacks.get(fallbackKey)
					: getOpenAIReasoningEffortFallback(providerSessionState, fallbackKey);
				if (requestReasoningEffortFallback !== undefined) {
					applyOpenAIReasoningEffortFallback(requestParams, requestReasoningEffortFallback);
				}
				return fallbackKey;
			};
			if (isOpenAIResponsesStatefulEnabled(options, baseUrl) && routingSessionId && providerSessionState) {
				chainState = getOpenAIResponsesChainState(providerSessionState, model, baseUrl, routingSessionId);
				if (!chainState.disabled) {
					params.store = true;
				}
			}
			applyReasoningEffortFallbackForRequest(params);
			let chained: OpenAIResponsesChainedParams =
				chainState && !chainState.disabled ? buildOpenAIResponsesChainedParams(params, chainState) : { params };
			sentPreviousResponseId = chained.previousResponseId;
			const idleTimeoutMs =
				options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const requestUrl = `${resolvedBaseUrl}/responses`;
			const applyPayloadReplacement = async (
				requestParams: OpenAIResponsesSamplingParams,
			): Promise<{ wireParams: OpenAIResponsesSamplingParams; bodyJson: string }> => {
				const bodyJson = JSON.stringify(requestParams);
				let attemptParams = requestParams;
				if (options?.onPayload) {
					const hookView = JSON.parse(bodyJson) as OpenAIResponsesSamplingParams;
					const replacementPayload = await options.onPayload(hookView, model);
					attemptParams =
						replacementPayload !== undefined && replacementPayload !== hookView
							? (replacementPayload as OpenAIResponsesSamplingParams)
							: hookView;
				}
				const fallbackKey = applyReasoningEffortFallbackForRequest(attemptParams);
				const fallbackApplied =
					requestReasoningEffortFallbacks.has(fallbackKey) ||
					getOpenAIReasoningEffortFallback(providerSessionState, fallbackKey) !== undefined;
				return {
					wireParams: attemptParams,
					bodyJson: fallbackApplied || attemptParams !== requestParams ? JSON.stringify(attemptParams) : bodyJson,
				};
			};
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: requestUrl,
			};
			const openResponsesStream = async (requestParams: OpenAIResponsesSamplingParams, captureOnly = false) => {
				const prepareRequest = async (): Promise<RequestInit> => {
					const { wireParams, bodyJson } = await applyPayloadReplacement(requestParams);
					activeReasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
						"responses",
						resolvedBaseUrl,
						typeof wireParams.model === "string" ? wireParams.model : model.id,
					);
					activeRequestParams = wireParams;
					wireBodyJson = bodyJson;
					return { body: bodyJson };
				};
				if (captureOnly) {
					await prepareRequest();
					throw new AIError.RequestAbortError();
				}
				return callWithCopilotModelRetry(
					async () => {
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
							const handle = await postOpenAIStream<ResponseStreamEvent>({
								url: requestUrl,
								headers: headersWithTimeout,
								body: undefined,
								signal: requestSignal,
								fetch: options?.fetch,
								prepareInit: prepareRequest,
								maxRetryDelayMs: options?.maxRetryDelayMs,
								onSseEvent: rawSseObserver,
							});
							if (requestTimeout !== undefined) {
								clearTimeout(requestTimeout);
								requestTimeout = undefined;
							}
							return handle;
						} finally {
							clearTimeout(requestTimeout);
						}
					},
					{ provider: model.provider, signal: requestSignal },
				);
			};
			if (requestSignal.aborted) await openResponsesStream(chained.params, true);
			let openaiHandle: OpenAIStreamHandle<ResponseStreamEvent>;
			let strictRetryAvailable = true;
			let activeStrictToolsApplied = builtParams.strictToolsApplied;
			let forceDisableStrictTools = false;
			while (true) {
				try {
					openaiHandle = await openResponsesStream(chained.params);
					if (pendingReasoningEffortFallback) {
						rememberOpenAIReasoningEffortFallback(
							providerSessionState,
							pendingReasoningEffortFallback.key,
							pendingReasoningEffortFallback.fallback,
						);
						pendingReasoningEffortFallback = undefined;
					}
					break;
				} catch (error) {
					const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
					const reasoningEffortFallback =
						activeReasoningEffortFallbackKey && activeRequestParams && !requestSignal.aborted
							? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, activeRequestParams, {
									explicitDisable: options?.disableReasoning === true && options.reasoning === undefined,
								})
							: undefined;
					if (reasoningEffortFallback !== undefined && activeReasoningEffortFallbackKey) {
						const retryMarker = `${activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
						if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
						attemptedReasoningEffortFallbacks.add(retryMarker);
						requestReasoningEffortFallbacks.set(activeReasoningEffortFallbackKey, reasoningEffortFallback);
						applyOpenAIReasoningEffortFallback(chained.params, reasoningEffortFallback);
						applyOpenAIReasoningEffortFallback(activeParams, reasoningEffortFallback);
						pendingReasoningEffortFallback = {
							key: activeReasoningEffortFallbackKey,
							fallback: reasoningEffortFallback,
						};
						continue;
					}
					const compiledGrammarTooLarge =
						isOpenRouterAnthropicModel(model) &&
						isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse);
					const canRetryWithoutStrictTools =
						strictRetryAvailable &&
						!requestSignal.aborted &&
						(compiledGrammarTooLarge ||
							shouldRetryWithoutStrictTools(
								error,
								capturedErrorResponse,
								activeStrictToolsApplied,
								context.tools,
							));
					if (canRetryWithoutStrictTools) {
						strictRetryAvailable = false;
						forceDisableStrictTools = true;
						disableStrictToolsForScope(providerSessionState, strictToolsScope);
						const fallbackBuilt = buildParams(
							model,
							context,
							options,
							providerSessionState,
							strictToolsScope,
							true,
						);
						const fallbackParams = fallbackBuilt.params;
						if (chainState && !chainState.disabled) fallbackParams.store = true;
						const fallbackChained: OpenAIResponsesChainedParams =
							chainState && !chainState.disabled
								? buildOpenAIResponsesChainedParams(fallbackParams, chainState)
								: { params: fallbackParams };
						sentPreviousResponseId = fallbackChained.previousResponseId;
						chained = fallbackChained;
						activeParams = fallbackParams;
						activeStrictToolsApplied = fallbackBuilt.strictToolsApplied;
						continue;
					}
					if (!chainState || !sentPreviousResponseId || requestSignal.aborted) {
						throw error;
					}
					const zdrRejection =
						error instanceof Error &&
						/previous[ _]?response/i.test(error.message) &&
						/zero[ _-]?data[ _-]?retention/i.test(error.message);
					if (!zdrRejection && !isOpenAIResponsesStalePreviousResponseError(error)) {
						throw error;
					}
					if (zdrRejection) {
						markOpenAIResponsesChainZeroDataRetention(chainState, error);
					} else {
						registerOpenAIResponsesChainStaleFailure(chainState, error);
					}
					sentPreviousResponseId = undefined;
					const currentBuilt = buildParams(
						model,
						context,
						options,
						providerSessionState,
						strictToolsScope,
						forceDisableStrictTools,
					);
					const currentParams = currentBuilt.params;
					currentParams.store = !zdrRejection;
					chained = { params: currentParams };
					activeParams = currentParams;
					activeStrictToolsApplied = currentBuilt.strictToolsApplied;
				}
			}
			await notifyProviderResponse(options, openaiHandle.response, model, openaiHandle.requestId);
			const openaiStream = openaiHandle.events;
			if (premiumRequestsTotal !== undefined) output.usage.premiumRequests = premiumRequestsTotal;
			stream.push({ type: "start", partial: output });

			const nativeOutputItems: Array<Record<string, unknown>> = [];
			let sawTerminalResponseEvent = false;
			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI responses stream stalled while waiting for the next event",
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				onIdle: () => requestAbortController.abort(),
				abortSignal: options?.signal,
				isProgressItem: isOpenAIResponsesProgressEvent,
			});
			await processResponsesStream(timedOpenaiStream, output, stream, model, {
				onFirstToken: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
				onOutputItemDone: item => {
					nativeOutputItems.push(item as unknown as Record<string, unknown>);
				},
				onCompleted: () => {
					sawTerminalResponseEvent = true;
				},
				requestServiceTier: options?.serviceTier,
			});

			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) {
				throw localAbortReason;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new AIError.RequestAbortError();
			}

			if (!sawTerminalResponseEvent) {
				throw new AIError.ProviderResponseError(
					"OpenAI responses stream closed before a terminal response event was received",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
					provider: model.provider,
					kind: "runtime",
				});
			}

			output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeOutputItems);
			const replayableResponseItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
				structuredCloneJSON(nativeOutputItems),
			);
			if (replayableResponseItems) {
				if (providerSessionState) providerSessionState.nativeHistoryReplayWarmed = true;
				if (chainState) {
					chainState.lastParams = structuredCloneJSON(activeParams);
					if (output.responseId) {
						chainState.lastResponseId = output.responseId;
						chainState.lastResponseItems = replayableResponseItems;
						chainState.canAppend = true;
						if (sentPreviousResponseId) chainState.staleFailures = 0;
					} else {
						chainState.canAppend = false;
					}
				}
			} else if (chainState) {
				chainState.canAppend = false;
				chainState.lastParams = structuredCloneJSON(activeParams);
				chainState.lastResponseId = undefined;
				chainState.lastResponseItems = undefined;
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			if (chainState) resetOpenAIResponsesChainState(chainState);
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
			// Some providers via OpenRouter include extra details here.
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

export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAIResponsesOnce);
