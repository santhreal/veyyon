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
	StopReason,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import {
	createOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	resolveCacheRetention,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "../utils";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { OpenAIHttpError, type OpenAIStreamHandle, postOpenAIStream } from "../utils/openai-http";
import { conversationIdForOpenCode } from "../utils/opencode-headers";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	NO_STRICT,
	sanitizeSchemaForOpenAIResponses,
	toolWireSchema,
} from "../utils/schema";
import { notifyRawSseEvent, resolveOpenAiSseEventName } from "../utils/sse-debug";
import {
	isForcedToolChoice,
	mapToOpenAIResponsesToolChoice,
	type OpenAIResponsesToolChoice,
} from "../utils/tool-choice";
import type { CacheControlEphemeral } from "./anthropic-wire";
import { compactGrammarDefinition } from "./grammar";
import { createInitialResponsesAssistantMessage } from "./initial-message";
import {
	formatOpenAIInputText,
	isOfficialOpenAIResponsesEndpoint,
	type OpenAIPromptCachePolicy,
	resolveOpenAIPromptCachePolicy,
} from "./openai-prompt-cache";
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
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import {
	applyCommonResponsesSamplingParams,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyResponsesCompatPolicy,
	applyWireModelIdTransform,
	buildResponsesDeltaInput,
	buildResponsesInput,
	clearOpenAIStrictToolsState,
	clearOpenAIToolChoiceState,
	createOpenAIStrictToolsState,
	createOpenAIToolChoiceState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIResponsesRoutingSessionId,
	getOpenAIStrictToolsScope,
	getOpenRouterResponsesSessionId,
	isCompiledGrammarTooLargeStrictError,
	isOpenAIResponsesProgressEvent,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	isToolChoiceRejectedForScope,
	isToolChoiceRejection,
	type OpenAIStrictToolsScope,
	type OpenAIStrictToolsState,
	type OpenAIToolChoiceState,
	processResponsesStream,
	rejectToolChoiceForScope,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	shouldRetryWithoutStrictTools,
	supportsFreeformApplyPatch,
} from "./openai-shared";

export { supportsFreeformApplyPatch } from "./openai-shared";

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ServiceTier;
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: ToolChoice;
	openrouterVariant?: string;
	maxTokensExplicit?: boolean;
	disableReasoning?: boolean;
	/**
	 * Stateful turns: chain via `previous_response_id` + delta input instead of
	 * replaying the full transcript. Forces `store: true` (the platform only
	 * resolves stored responses). Defaults ON against the official OpenAI API
	 * and OFF for other Responses endpoints; `VEYYON_OPENAI_STATEFUL` overrides the
	 * default, and `false` here vetoes everything. Requires `sessionId` +
	 * `providerSessionState`. Falls back to a full replay whenever history
	 * mutates or the server reports a stale id.
	 */
	statefulResponses?: boolean;
	/**
	 * Override catalog compat for strict tool call/result pairing when building
	 * Responses API inputs. Default behavior is catalog compat; this is only for
	 * debugging/adapter wrappers.
	 */
	strictResponsesPairing?: boolean;
	/**
	 * Override catalog compat for `include: ["reasoning.encrypted_content"]`.
	 * Default behavior is catalog compat; this is only for debugging/adapter wrappers.
	 */
	includeEncryptedReasoning?: boolean;
	/**
	 * Override catalog compat for stripping `type: "reasoning"` items from
	 * replayed conversation history before request encoding. Default behavior is
	 * catalog compat; this is only for debugging/adapter wrappers.
	 */
	filterReasoningHistory?: boolean;
	/**
	 * Override catalog compat for suppressing the `reasoning.effort` wire param.
	 * Default behavior is catalog compat; this is only for debugging/adapter wrappers.
	 */
	omitReasoningEffort?: boolean;
	/**
	 * Extra request headers merged onto the model/copilot defaults. Used by
	 * adapter wrappers to inject provider-specific
	 * routing or cache hints.
	 */
	headers?: Record<string, string>;
	/**
	 * Extra body fields merged into the Responses request payload. Used by
	 * adapter wrappers to inject provider-specific body keys (e.g.,
	 * prompt_cache_key for prompt-cache routing).
	 */
	extraBody?: Record<string, unknown>;
}

const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
const OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI responses stream timed out while waiting for the first event";
/** Consecutive stale-previous-response failures before chaining is disabled for the session. */
const OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT = 3;

interface OpenAIResponsesProviderSessionState
	extends ProviderSessionState,
		OpenAIStrictToolsState,
		OpenAIReasoningEffortFallbackState,
		OpenAIToolChoiceState {
	nativeHistoryReplayWarmed: boolean;
	/** Stateful `previous_response_id` chain baselines, keyed by baseUrl/model/session. */
	chains: Map<string, OpenAIResponsesChainState>;
}

interface OpenAIResponsesChainState {
	/**
	 * Wire params of the last successful turn; never carries
	 * `previous_response_id`.
	 */
	lastParams?: OpenAIResponsesSamplingParams;
	lastResponseId?: string;
	/** Output items of the last response, in replay-sanitized form (matches next-turn input). */
	lastResponseItems?: ResponseInput;
	canAppend: boolean;
	/** Consecutive stale-previous-response failures; reset on a successful chained completion. */
	staleFailures: number;
	/** Set once chaining is judged unsupported for this session (circuit breaker). */
	disabled: boolean;
}

function createOpenAIResponsesProviderSessionState(): OpenAIResponsesProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const toolChoiceState = createOpenAIToolChoiceState();
	const state: OpenAIResponsesProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		...toolChoiceState,
		nativeHistoryReplayWarmed: false,
		chains: new Map(),
		close: () => {
			state.nativeHistoryReplayWarmed = false;
			state.chains.clear();
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
			clearOpenAIToolChoiceState(state);
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
	// Default ON only against the official OpenAI API: chaining forces
	// `store: true`, and third-party /v1/responses proxies routinely ignore or
	// reject `previous_response_id`. An unset baseUrl means the default
	// endpoint (api.openai.com).
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
	/** Set iff the params carry previous_response_id (delta request). */
	previousResponseId?: string;
}

/**
 * Shape the next turn's request: when the session's append baseline is intact
 * (same options, strict history prefix), chain via `previous_response_id` +
 * delta-only `input`; otherwise break the chain and replay the full transcript.
 *
 * The prefix check runs on the wire form of the conversation arguments, so
 * history mutations or option changes force a full replay.
 */
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
	// "unsupported" covers endpoints that reject the parameter outright
	// (e.g. "Unsupported parameter: previous_response_id").
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

/**
 * One-shot ZDR signal: the org will never resolve a stored response, so skip
 * the staleFailures counter and disable chaining immediately for this session.
 */
function markOpenAIResponsesChainZeroDataRetention(chain: OpenAIResponsesChainState, error: unknown): void {
	resetOpenAIResponsesChainState(chain);
	chain.disabled = true;
	chain.staleFailures = OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT;
	logger.debug("OpenAI responses chaining disabled (Zero Data Retention)", {
		error: errorMessage(error),
	});
}

type OpenAIResponsesSamplingParams = ResponseCreateParamsStreaming & {
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

function buildDeveloperSystemInput(
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

function maybeAddOpenRouterAnthropicCacheControl(
	params: OpenAIResponsesSamplingParams,
	model: Model<"openai-responses">,
	cacheRetention: CacheRetention,
): void {
	if (cacheRetention === "none" || !isOpenRouterAnthropicModel(model)) return;
	if (params.cache_control != null) return;
	params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** A reasoning-effort downgrade this call retried with, remembered for the session once a stream opens. */
interface PendingReasoningEffortFallback {
	key: string;
	fallback: OpenAIReasoningEffortFallback;
}

/**
 * Reasoning-effort downgrades for one call: the fallback each wire model fell back to, which
 * retries already ran, and the wire params of the last prepared attempt a rejection resolves against.
 */
class ResponsesReasoningEffortFallbacks {
	readonly #forRequest = new Map<string, OpenAIReasoningEffortFallback>();
	readonly #attempted = new Set<string>();
	#pending: PendingReasoningEffortFallback | undefined;
	#sentKey: string | undefined;
	#sentParams: OpenAIResponsesSamplingParams | undefined;

	constructor(
		readonly model: Model<"openai-responses">,
		readonly baseUrl: string,
		readonly sessionState: OpenAIResponsesProviderSessionState | undefined,
	) {}

	/** Apply the fallback this call or the session holds for the params' wire model; true when one applied. */
	apply(requestParams: OpenAIResponsesSamplingParams): boolean {
		const key = this.#keyOf(requestParams);
		const fallback = this.#forRequest.has(key)
			? this.#forRequest.get(key)
			: getOpenAIReasoningEffortFallback(this.sessionState, key);
		if (fallback === undefined) return false;
		applyOpenAIReasoningEffortFallback(requestParams, fallback);
		return true;
	}

	/** Record the wire params an attempt sends, so a rejection of it resolves against them. */
	sent(wireParams: OpenAIResponsesSamplingParams): void {
		this.#sentKey = this.#keyOf(wireParams);
		this.#sentParams = wireParams;
	}

	/**
	 * The fallback a rejection of the last sent attempt asks for, recorded for this call's retry;
	 * undefined when the rejection is not about reasoning effort. Rethrows `error` when that
	 * fallback already ran, so no retry repeats.
	 */
	retryFallback(error: unknown, explicitDisable: boolean): OpenAIReasoningEffortFallback | undefined {
		const key = this.#sentKey;
		if (!key || !this.#sentParams) return undefined;
		const captured = error instanceof OpenAIHttpError ? error.captured : undefined;
		const fallback = resolveOpenAIReasoningEffortFallback(error, captured, this.#sentParams, { explicitDisable });
		if (fallback === undefined) return undefined;
		const retryMarker = `${key}:${String(fallback)}`;
		if (this.#attempted.has(retryMarker)) throw error;
		this.#attempted.add(retryMarker);
		this.#forRequest.set(key, fallback);
		this.#pending = { key, fallback };
		return fallback;
	}

	/** Remember the fallback that let the stream open, so the session's next call starts from it. */
	commit(): void {
		const pending = this.#pending;
		if (!pending) return;
		rememberOpenAIReasoningEffortFallback(this.sessionState, pending.key, pending.fallback);
		this.#pending = undefined;
	}

	#keyOf(requestParams: OpenAIResponsesSamplingParams): string {
		const wireModelId = typeof requestParams.model === "string" ? requestParams.model : this.model.id;
		return createOpenAIReasoningEffortFallbackKey("responses", this.baseUrl, wireModelId);
	}
}

/** What one attempt sends. */
interface OpenAIResponsesAttempt {
	/** Full-transcript params; the chain baseline records these when the attempt succeeds. */
	params: OpenAIResponsesSamplingParams;
	/** The params on the wire: `params`, or a delta onto the last response when the chain is live. */
	chained: OpenAIResponsesChainedParams;
	strictToolsApplied: boolean;
}

/** Request facts fixed before the first attempt. */
interface OpenAIResponsesRequestPlan {
	headers: Record<string, string>;
	premiumRequests: number | undefined;
	sessionState: OpenAIResponsesProviderSessionState | undefined;
	strictToolsScope: OpenAIStrictToolsScope;
	/** The session's rejected `tool_choice` forms, or this call's own when there is no session. */
	toolChoiceState: OpenAIToolChoiceState;
	requestUrl: string;
	idleTimeoutMs: number | undefined;
	firstEventTimeoutMs: number | undefined;
	/** First-event watchdog armed around each POST; undefined when disabled. */
	requestTimeoutMs: number | undefined;
	effortFallbacks: ResponsesReasoningEffortFallbacks;
	firstAttempt: OpenAIResponsesAttempt;
}

/** A cleanly ended response: the reason it is delivered with and the native output items it produced. */
interface OpenAIResponsesConsumed {
	reason: Extract<StopReason, "stop" | "length" | "toolUse">;
	nativeOutputItems: Array<Record<string, unknown>>;
}

/**
 * One `streamOpenAIResponsesOnce` call: plan the request, open it through the retry ladder,
 * consume the stream, and record what the next turn chains onto.
 */
class OpenAIResponsesStreamRun {
	readonly #startTime = performance.now();
	readonly #output: AssistantMessage;
	readonly #abortTracker: AbortSourceTracker;
	readonly #firstEventTimeoutAbortError = new AIError.StreamTimeoutError(OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE);
	readonly #rawSseObserver: ((event: RawSseEvent) => void) | undefined;
	#firstTokenTime: number | undefined;
	#rawRequestDump: RawHttpRequestDump | undefined;
	/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
	#wireBodyJson: string | undefined;
	#chainState: OpenAIResponsesChainState | undefined;
	#sentPreviousResponseId: string | undefined;
	/** Set once a rejection dropped strict tools; every later rebuild of this call keeps them off. */
	#strictToolsDisabled = false;

	constructor(
		readonly model: Model<"openai-responses">,
		readonly context: Context,
		readonly options: OpenAIResponsesOptions | undefined,
		readonly stream: AssistantMessageEventStream,
	) {
		this.#output = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		this.#abortTracker = createAbortSourceTracker(options?.signal);
		const onSseEvent = options?.onSseEvent;
		const modelSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;
		this.#rawSseObserver = modelSseObserver
			? (event: RawSseEvent) => {
					resolveOpenAiSseEventName(event);
					notifyRawSseEvent(modelSseObserver, event);
				}
			: undefined;
	}

	async run(): Promise<void> {
		const output = this.#output;
		try {
			const plan = this.#plan();
			const { handle, attempt } = await this.#open(plan);
			const { reason, nativeOutputItems } = await this.#consume(plan, handle);
			this.#recordChainBaseline(plan.sessionState, attempt.params, nativeOutputItems);
			this.#stampTiming();
			this.stream.push({ type: "done", reason, message: output });
		} catch (error) {
			await this.#fail(error);
		}
		this.stream.end();
	}

	#plan(): OpenAIResponsesRequestPlan {
		const { model, context, options } = this;
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
			conversationId: conversationIdForOpenCode(options),
			openAISessionId: routingSessionId,
			promptCacheSessionId,
		});
		const sessionState = getOpenAIResponsesProviderSessionState(model, options?.providerSessionState);
		const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
		const toolChoiceState = sessionState ?? createOpenAIToolChoiceState();
		const built = buildParams(model, context, options, sessionState, strictToolsScope, false, toolChoiceState);
		const resolvedBaseUrl = trimTrailingSlashes(baseUrl ?? "https://api.openai.com/v1");
		const effortFallbacks = new ResponsesReasoningEffortFallbacks(model, resolvedBaseUrl, sessionState);
		if (isOpenAIResponsesStatefulEnabled(options, baseUrl) && routingSessionId && sessionState) {
			this.#chainState = getOpenAIResponsesChainState(sessionState, model, baseUrl, routingSessionId);
		}
		effortFallbacks.apply(built.params);
		const firstAttempt = this.#chainAttempt(built.params, built.strictToolsApplied);
		const idleTimeoutMs =
			options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs);
		const firstEventTimeoutMs =
			options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
		const requestUrl = `${resolvedBaseUrl}/responses`;
		this.#rawRequestDump = {
			provider: model.provider,
			api: this.#output.api,
			model: model.id,
			method: "POST",
			url: requestUrl,
		};
		return {
			headers,
			premiumRequests: copilotPremiumRequests,
			sessionState,
			strictToolsScope,
			toolChoiceState,
			requestUrl,
			idleTimeoutMs,
			firstEventTimeoutMs,
			requestTimeoutMs:
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined,
			effortFallbacks,
			firstAttempt,
		};
	}

	/** An attempt from freshly built params, stored and chained onto the last response while the chain is live. */
	#chainAttempt(params: OpenAIResponsesSamplingParams, strictToolsApplied: boolean): OpenAIResponsesAttempt {
		const chain = this.#chainState;
		let chained: OpenAIResponsesChainedParams = { params };
		if (chain && !chain.disabled) {
			// Platform `previous_response_id` chaining only resolves stored responses.
			params.store = true;
			chained = buildOpenAIResponsesChainedParams(params, chain);
		}
		this.#sentPreviousResponseId = chained.previousResponseId;
		return { params, chained, strictToolsApplied };
	}

	/**
	 * POST the request, retrying on the rung a rejection allows: a reasoning-effort fallback, then
	 * dropping strict tools, then a full-transcript replay when the chain baseline was rejected.
	 * Each rung runs at most once per cause, so the loop ends.
	 */
	async #open(
		plan: OpenAIResponsesRequestPlan,
	): Promise<{ handle: OpenAIStreamHandle<ResponseStreamEvent>; attempt: OpenAIResponsesAttempt }> {
		let attempt = plan.firstAttempt;
		// Copilot retry policy rejects a latched abort before invoking its
		// callback, so preserve the payload-inspection contract outside it.
		if (this.#abortTracker.requestSignal.aborted) {
			await this.#prepareRequest(plan, attempt.chained.params);
			throw new AIError.RequestAbortError();
		}
		while (true) {
			try {
				const handle = await this.#post(plan, attempt.chained.params);
				plan.effortFallbacks.commit();
				return { handle, attempt };
			} catch (error) {
				attempt = this.#retryAttempt(plan, attempt, error);
			}
		}
	}

	/** The attempt that answers `error`; rethrows it when no rung of the ladder does. */
	#retryAttempt(
		plan: OpenAIResponsesRequestPlan,
		attempt: OpenAIResponsesAttempt,
		error: unknown,
	): OpenAIResponsesAttempt {
		const { model, context, options } = this;
		const aborted = this.#abortTracker.requestSignal.aborted;
		const effortFallback = aborted
			? undefined
			: plan.effortFallbacks.retryFallback(
					error,
					options?.disableReasoning === true && options.reasoning === undefined,
				);
		if (effortFallback !== undefined) {
			applyOpenAIReasoningEffortFallback(attempt.chained.params, effortFallback);
			applyOpenAIReasoningEffortFallback(attempt.params, effortFallback);
			return attempt;
		}
		const captured = error instanceof OpenAIHttpError ? error.captured : undefined;
		const sentToolChoice = attempt.chained.params.tool_choice;
		if (!aborted && isToolChoiceRejection(error, captured, sentToolChoice)) {
			// The endpoint rejected the `tool_choice` form, not the request. The rebuilt request
			// leaves that form out, so this rung cannot answer its own retry.
			rejectToolChoiceForScope(plan.toolChoiceState, plan.strictToolsScope, sentToolChoice);
			const built = buildParams(
				model,
				context,
				options,
				plan.sessionState,
				plan.strictToolsScope,
				this.#strictToolsDisabled,
				plan.toolChoiceState,
			);
			plan.effortFallbacks.apply(built.params);
			return this.#chainAttempt(built.params, built.strictToolsApplied);
		}
		const compiledGrammarTooLarge =
			isOpenRouterAnthropicModel(model) && isCompiledGrammarTooLargeStrictError(error, captured);
		if (
			!this.#strictToolsDisabled &&
			!aborted &&
			(compiledGrammarTooLarge ||
				shouldRetryWithoutStrictTools(error, captured, attempt.strictToolsApplied, context.tools))
		) {
			this.#strictToolsDisabled = true;
			disableStrictToolsForScope(plan.sessionState, plan.strictToolsScope);
			const built = buildParams(
				model,
				context,
				options,
				plan.sessionState,
				plan.strictToolsScope,
				true,
				plan.toolChoiceState,
			);
			return this.#chainAttempt(built.params, built.strictToolsApplied);
		}
		return this.#replayAttempt(plan, error);
	}

	/**
	 * The server rejected the chain baseline: reset it, count the failure (or disable chaining
	 * outright on Zero Data Retention), and replay the full transcript. The replay carries no
	 * `previous_response_id`, so this rung cannot repeat. Rethrows `error` for any other rejection.
	 */
	#replayAttempt(plan: OpenAIResponsesRequestPlan, error: unknown): OpenAIResponsesAttempt {
		const chain = this.#chainState;
		if (!chain || !this.#sentPreviousResponseId || this.#abortTracker.requestSignal.aborted) {
			throw error;
		}
		const zdrRejection =
			error instanceof Error &&
			/previous[ _]?response/i.test(error.message) &&
			/zero[ _-]?data[ _-]?retention/i.test(error.message);
		if (zdrRejection) {
			markOpenAIResponsesChainZeroDataRetention(chain, error);
		} else if (isOpenAIResponsesStalePreviousResponseError(error)) {
			registerOpenAIResponsesChainStaleFailure(chain, error);
		} else {
			throw error;
		}
		this.#sentPreviousResponseId = undefined;
		const { params, strictToolsApplied } = buildParams(
			this.model,
			this.context,
			this.options,
			plan.sessionState,
			plan.strictToolsScope,
			this.#strictToolsDisabled,
			plan.toolChoiceState,
		);
		// Only ZDR forces `store: false` (the org never persists responses). A
		// non-ZDR stale baseline is transient, so keep storing: the full-context
		// retry must be chainable next turn, and the consecutive stale-failure
		// breaker only trips when each retry stores and the next turn re-chains.
		params.store = !zdrRejection;
		return { params, chained: { params }, strictToolsApplied };
	}

	/** One POST through the Copilot model retry, with the first-event watchdog armed until headers arrive. */
	#post(
		plan: OpenAIResponsesRequestPlan,
		requestParams: OpenAIResponsesSamplingParams,
	): Promise<OpenAIStreamHandle<ResponseStreamEvent>> {
		const { model, options } = this;
		const abortTracker = this.#abortTracker;
		const { requestTimeoutMs } = plan;
		return callWithCopilotModelRetry(
			async () => {
				const requestTimeout =
					requestTimeoutMs === undefined
						? undefined
						: setTimeout(() => abortTracker.abortLocally(this.#firstEventTimeoutAbortError), requestTimeoutMs);
				try {
					const headers = { ...plan.headers };
					if (requestTimeoutMs !== undefined) {
						headers["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					// Transient 408/429/5xx get Retry-After-aware transport retries; the
					// first-event watchdog aborts `requestSignal`, so retries cannot extend
					// the caller's deadline.
					return await postOpenAIStream<ResponseStreamEvent>({
						url: plan.requestUrl,
						headers,
						body: undefined,
						signal: abortTracker.requestSignal,
						fetch: options?.fetch,
						prepareInit: () => this.#prepareRequest(plan, requestParams),
						maxRetryDelayMs: options?.maxRetryDelayMs,
						onSseEvent: this.#rawSseObserver,
					});
				} finally {
					clearTimeout(requestTimeout);
				}
			},
			{ provider: model.provider, signal: abortTracker.requestSignal },
		);
	}

	/**
	 * Serialize the attempt once. The `onPayload` hook gets an isolated parse of exactly those
	 * bytes, and when no extension replaces the payload those bytes are sent as they are; a
	 * reasoning-effort fallback applied afterwards forces a second serialization.
	 */
	async #prepareRequest(
		plan: OpenAIResponsesRequestPlan,
		requestParams: OpenAIResponsesSamplingParams,
	): Promise<RequestInit> {
		const bodyJson = JSON.stringify(requestParams);
		let wireParams = requestParams;
		const onPayload = this.options?.onPayload;
		if (onPayload) {
			const hookView = JSON.parse(bodyJson) as OpenAIResponsesSamplingParams;
			const replacementPayload = await onPayload(hookView, this.model);
			wireParams =
				replacementPayload !== undefined && replacementPayload !== hookView
					? (replacementPayload as OpenAIResponsesSamplingParams)
					: hookView;
		}
		const fallbackApplied = plan.effortFallbacks.apply(wireParams);
		const wireBodyJson = fallbackApplied || wireParams !== requestParams ? JSON.stringify(wireParams) : bodyJson;
		plan.effortFallbacks.sent(wireParams);
		this.#wireBodyJson = wireBodyJson;
		return { body: wireBodyJson };
	}

	/** Stream the response into the message; the native output items it produced, once it ended cleanly. */
	async #consume(
		plan: OpenAIResponsesRequestPlan,
		handle: OpenAIStreamHandle<ResponseStreamEvent>,
	): Promise<OpenAIResponsesConsumed> {
		const { model, options, stream } = this;
		const output = this.#output;
		const abortTracker = this.#abortTracker;
		await notifyProviderResponse(options, handle.response, model, handle.requestId);
		if (plan.premiumRequests !== undefined) output.usage.premiumRequests = plan.premiumRequests;
		stream.push({ type: "start", partial: output });

		const nativeOutputItems: Array<Record<string, unknown>> = [];
		let sawTerminalResponseEvent = false;
		const events = iterateWithIdleTimeout(handle.events, {
			idleTimeoutMs: plan.idleTimeoutMs,
			firstItemTimeoutMs: plan.firstEventTimeoutMs,
			firstItemErrorMessage: OPENAI_RESPONSES_FIRST_EVENT_TIMEOUT_MESSAGE,
			errorMessage: "OpenAI responses stream stalled while waiting for the next event",
			onFirstItemTimeout: () => abortTracker.abortLocally(this.#firstEventTimeoutAbortError),
			onIdle: () => abortTracker.requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isOpenAIResponsesProgressEvent,
		});
		await processResponsesStream(events, output, stream, model, {
			onFirstToken: () => {
				if (!this.#firstTokenTime) this.#firstTokenTime = performance.now();
			},
			onOutputItemDone: item => {
				// `processResponsesStream` hands over a private clone already; no
				// second deep copy needed (reasoning items carry multi-KB blobs).
				nativeOutputItems.push(item as unknown as Record<string, unknown>);
			},
			onCompleted: () => {
				sawTerminalResponseEvent = true;
			},
			requestServiceTier: options?.serviceTier,
		});

		const localAbortReason = abortTracker.getLocalAbortReason();
		if (localAbortReason) throw localAbortReason;
		if (abortTracker.wasCallerAbort()) throw new AIError.RequestAbortError();
		// Detect premature stream closure: the HTTP stream ended without the
		// provider sending a recognized terminal response event. Custom/proxy
		// providers may drop the connection mid-stream; without this guard the
		// incomplete output is silently surfaced as a successful "stop".
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
		return { reason: output.stopReason, nativeOutputItems };
	}

	/**
	 * Record what the next turn chains onto: this turn's full-transcript params and, when the
	 * response has an id and replayable output, that output as the append baseline.
	 */
	#recordChainBaseline(
		sessionState: OpenAIResponsesProviderSessionState | undefined,
		params: OpenAIResponsesSamplingParams,
		nativeOutputItems: Array<Record<string, unknown>>,
	): void {
		const replayableResponseItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
			structuredCloneJSON(nativeOutputItems),
		);
		const chain = this.#chainState;
		if (!replayableResponseItems) {
			// Hidden-empty / fully sanitized successes cannot be used as an append
			// baseline, but `lastParams` still records the successful wire controls
			// without re-enabling `previous_response_id` chaining.
			if (chain) {
				chain.canAppend = false;
				chain.lastParams = structuredCloneJSON(params);
				chain.lastResponseId = undefined;
				chain.lastResponseItems = undefined;
			}
			return;
		}
		if (sessionState) sessionState.nativeHistoryReplayWarmed = true;
		if (!chain) return;
		chain.lastParams = structuredCloneJSON(params);
		const responseId = this.#output.responseId;
		if (!responseId) {
			// Without a response id the append baseline cannot be trusted.
			chain.canAppend = false;
			return;
		}
		chain.lastResponseId = responseId;
		chain.lastResponseItems = replayableResponseItems;
		chain.canAppend = true;
		// Only a successful CHAINED completion clears the stale counter — a
		// full-context success must not mask categorical rejection.
		if (this.#sentPreviousResponseId) chain.staleFailures = 0;
	}

	async #fail(error: unknown): Promise<void> {
		const { model } = this;
		const output = this.#output;
		if (this.#chainState) resetOpenAIResponsesChainState(this.#chainState);
		const result = await AIError.finalize(error, {
			api: model.api,
			provider: model.provider,
			abortTracker: this.#abortTracker,
			rawRequestDump: materializeDumpBody(this.#rawRequestDump, this.#wireBodyJson),
			capturedErrorResponse: error instanceof OpenAIHttpError ? error.captured : undefined,
		});
		AIError.applyFinalizeResult(output, result);
		// Some providers via OpenRouter include extra details here.
		const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
		if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
		this.#stampTiming();
		this.stream.push({ type: "error", reason: output.stopReason, error: output });
	}

	#stampTiming(): void {
		this.#output.duration = performance.now() - this.#startTime;
		if (this.#firstTokenTime) this.#output.ttft = this.#firstTokenTime - this.#startTime;
	}
}

/** Generate function for OpenAI Responses API: one attempt, retried on empty completions by the public entry. */
const streamOpenAIResponsesOnce = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void new OpenAIResponsesStreamRun(model, context, options, stream).run();
	return stream;
};

/**
 * Public entry: wrap the single-attempt Responses streamer with bounded
 * empty-completion retries — a `response.completed` carrying no content/usage
 * would otherwise stall the agent loop. Shared with the OpenAI-completions and
 * Anthropic providers via `withEmptyCompletionRetry`.
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOpenAIResponsesOnce);

export function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	strictToolsScope?: OpenAIStrictToolsScope,
	disableStrictToolsOverride = false,
	toolChoiceState: OpenAIToolChoiceState | undefined = providerSessionState,
): { params: OpenAIResponsesSamplingParams; strictToolsApplied: boolean } {
	const policy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: options?.toolChoice,
		strictResponsesPairing: options?.strictResponsesPairing,
		includeEncryptedReasoning: options?.includeEncryptedReasoning,
		filterReasoningHistory: options?.filterReasoningHistory,
		omitReasoningEffort: options?.omitReasoningEffort,
	});
	const strictResponsesPairing = policy.tools.strictResponsesPairing;
	const shouldReplayNativeHistory = providerSessionState?.nativeHistoryReplayWarmed ?? true;
	const messages = buildResponsesInput({
		model,
		context,
		strictResponsesPairing,
		supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
		supportsCustomToolCalls: supportsFreeformApplyPatch(model),
		supportsDeveloperRole: policy.messages.supportsDeveloperRole,
		nativeHistory: {
			replay: shouldReplayNativeHistory,
			filterReasoning: policy.reasoning.filterReasoningHistory,
		},
		includeThinkingSignatures: shouldReplayNativeHistory && !policy.reasoning.filterReasoningHistory,
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	const cachePolicy = resolveOpenAIPromptCachePolicy({
		model,
		promptCacheKey,
		cacheRetention,
	});
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	let systemInstructions: string | undefined;
	if (systemPrompts.length > 0) {
		const needsDeveloperRole = policy.messages.systemRole === "developer";
		if (needsDeveloperRole) {
			// Reasoning models on known OpenAI-compatible endpoints require the
			// `developer` role. The OpenAI cache boundary decides whether the
			// stable first block can carry a generation-specific breakpoint.
			messages.unshift(...buildDeveloperSystemInput(systemPrompts, cachePolicy));
		} else {
			// All other endpoints (including third-party /v1/responses proxies) use
			// the canonical top-level `instructions` field so that proxies that
			// reject `input[{role:"system"}]` work out of the box.
			systemInstructions = systemPrompts.join("\n\n");
		}
	}

	const modelId = applyWireModelIdTransform(
		model.requestModelId ?? model.id,
		model.compat.wireModelIdMode,
		options?.openrouterVariant,
	);
	const params: OpenAIResponsesSamplingParams = {
		model: modelId,
		input: messages,
		instructions: systemInstructions,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: cachePolicy.promptCacheRetention,
		// Gateway routing: OpenRouter-only Responses wire field for sticky upstream
		// routing + observability grouping; no equivalent on direct OpenAI.
		session_id: model.compat.isOpenRouterHost ? getOpenRouterResponsesSessionId(options) : undefined,
		store: false,
		stream_options: model.compat.supportsObfuscationOptOut ? { include_obfuscation: false } : undefined,
	};
	maybeAddOpenRouterAnthropicCacheControl(params, model, cacheRetention);
	const outputToken = resolveOpenAIOutputTokenParam({
		field: "max_output_tokens",
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		routedUpstreamSelfCaps: model.compat.routedUpstreamSelfCaps,
		alwaysSendMaxTokens: model.compat.alwaysSendMaxTokens,
	});

	applyCommonResponsesSamplingParams(params, { ...options, maxTokens: outputToken?.value }, model);
	if (options?.textVerbosity && isOfficialOpenAIResponsesEndpoint(model)) {
		params.text = { ...params.text, verbosity: options.textVerbosity };
	}
	// TODO: openai responses has no top-level `stop`/`stop_sequences`; surface via reasoning.stop?
	// `StreamOptions.stopSequences` is intentionally dropped for this provider.
	// TODO: openai responses has no top-level `frequency_penalty` field as of the current SDK;
	// `StreamOptions.frequencyPenalty` is intentionally dropped for this provider.

	let strictToolsApplied = false;
	if (context.tools) {
		const disableStrictTools =
			disableStrictToolsOverride || isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
		const strictMode = !disableStrictTools && model.compat.supportsStrictMode !== false;
		params.tools = convertTools(context.tools, strictMode, model);
		strictToolsApplied = params.tools.some(t => (t as { strict?: boolean }).strict === true);
		if (options?.toolChoice) {
			// Map tool_choice against the tools that survived quarantine, not the
			// original list: a forced choice for a dropped tool — or "required" when
			// every tool was dropped — would otherwise send a tool_choice with no
			// matching tool, which the provider rejects just like the bad schema did (#2652).
			const emittedNames = new Set(
				params.tools.map(t => (t as { name?: string }).name).filter((n): n is string => n !== undefined),
			);
			const survivingTools =
				params.tools.length === context.tools.length
					? context.tools
					: context.tools.filter(t => emittedNames.has(t.customWireName ?? t.name));
			const toolChoice = mapOpenAIResponsesToolChoiceForTools(options.toolChoice, survivingTools, model);
			if (toolChoice !== undefined && params.tools.length > 0) {
				params.tool_choice = toolChoice;
			}
		}
		if (
			toolChoiceState &&
			strictToolsScope &&
			isToolChoiceRejectedForScope(toolChoiceState, strictToolsScope, params.tool_choice)
		) {
			// This model rejected this form of `tool_choice` earlier in the session. Leaving the
			// field out is `auto`, and the reasoning policy below reads the choice actually sent.
			delete params.tool_choice;
		}
	}

	const reasoningPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
		strictResponsesPairing: options?.strictResponsesPairing,
		includeEncryptedReasoning: options?.includeEncryptedReasoning,
		filterReasoningHistory: options?.filterReasoningHistory,
		omitReasoningEffort: options?.omitReasoningEffort,
	});
	const reasoningSummary =
		model.provider === "xai-oauth"
			? options?.reasoning === undefined
				? undefined
				: null
			: options?.reasoningSummary;
	applyResponsesCompatPolicy(params, reasoningPolicy, {
		reasoningSummary,
		mapEffort: effort =>
			model.compat.reasoningEffortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			model.thinking?.effortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			effort,
	});
	// Catalog pro aliases (`gpt-5.6-*-pro`): merge AFTER the compat policy so the
	// mode survives every policy branch (disabled/omitted effort included) while
	// keeping whatever effort/summary the policy produced — mode and effort are
	// independent wire fields.
	if (model.reasoningMode) {
		params.reasoning = { ...params.reasoning, mode: model.reasoningMode };
	}

	applyOpenAIGatewayRouting(params, model.compat);

	applyOpenAIExtraBody(params, options?.extraBody);

	return { params, strictToolsApplied };
}

/** @internal Exported for tests. */
export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	if (!model.compat.supportsToolChoice) return undefined;
	if (isForcedToolChoice(choice) && !model.compat.supportsForcedToolChoice) {
		return "auto";
	}
	const mapped = mapToOpenAIResponsesToolChoice(choice);
	if (!mapped || typeof mapped === "string" || mapped.type !== "function") {
		return mapped;
	}

	const directTool = tools.find(tool => tool.name === mapped.name);
	const customTool = supportsFreeformApplyPatch(model)
		? tools.find(tool => tool.customFormat && (tool.name === mapped.name || tool.customWireName === mapped.name))
		: undefined;
	const offeredTool = customTool ?? directTool;
	if (!offeredTool) {
		return undefined;
	}
	return customTool ? { type: "custom", name: customTool.customWireName ?? customTool.name } : mapped;
}

/** @internal Exported for tests. */
export function convertTools(
	tools: Tool[],
	strictMode: boolean,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	onQuarantine: (toolName: string, schemaPath: string) => void = (toolName, schemaPath) =>
		logger.warn(
			`Tool "${toolName}" omitted from the openai-responses request: its parameter schema is invalid for this provider at ${schemaPath} (an enum/const value cannot match its declared type). Other tools are unaffected.`,
		),
): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	const out: OpenAITool[] = [];
	for (const tool of tools) {
		if (allowFreeform && tool.customFormat) {
			out.push({
				type: "custom",
				// Tool advertises its wire-level name (e.g. `apply_patch`) — the
				// agent-loop dispatcher will match incoming calls by either the
				// internal `name` or `customWireName`.
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			} as unknown as OpenAITool);
			continue;
		}
		const strict = !NO_STRICT && strictMode && tool.strict !== false;
		const baseParameters = toolWireSchema(tool);
		const responseParameters = sanitizeSchemaForOpenAIResponses(baseParameters);
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, strict);
		// Quarantine a tool whose emitted schema carries a provider-rejecting
		// enum/const-vs-type contradiction: dropping just that tool keeps the rest
		// of the request valid instead of letting one bad MCP schema 400 the whole
		// turn (#2652). Other tools and built-ins are unaffected.
		const violation = findStrictToolSchemaViolation(parameters);
		if (violation) {
			onQuarantine(tool.name, violation);
			continue;
		}
		out.push({
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			// `strict: false` and an omitted `strict` are NOT equivalent for every
			// OpenAI-compat backend — some over-fill optional args when the flag is
			// absent (#4336). Preserve the author's explicit `false` unless the
			// provider is explicitly known not to understand the field
			// (`supportsStrictMode: false`) or the strict-schema fallback is
			// active — both paths rely on a uniformly absent wire flag. Mirrors the
			// `supportsStrictMode !== false` gate used by openai-completions
			// (#4527).
			...(effectiveStrict
				? { strict: true }
				: !NO_STRICT && strictMode && tool.strict === false
					? { strict: false }
					: {}),
		} as OpenAITool);
	}
	return out;
}
