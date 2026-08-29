import { scheduler } from "node:timers/promises";
import type { Effort } from "@veyyon/catalog/effort";
import {
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	type ReasoningSelection,
	requireSupportedEffort,
	resolveReasoningSelection,
	resolveWireModelId,
} from "@veyyon/catalog/model-thinking";
import { discardAttemptUsage } from "@veyyon/catalog/models";
import { $env } from "@veyyon/utils/env";
import { withExtraCaFetch } from "@veyyon/utils/tls-fetch";
import { errorMessage } from "@veyyon/utils/type-guards";
import { getCustomApi } from "./api-registry";
import { createAuthRetryKeyState, isApiKeyResolver, resolveNextAuthRetryKey } from "./auth-retry";
import { getEnvApiKey } from "./env-api-key";
import * as AIError from "./error";
import { ProviderHttpError } from "./error";
import { isAuthRetryableError } from "./error/auth-classify";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import { isGitLabDuoModel, streamGitLabDuo } from "./providers/gitlab-duo";
import { streamGitLabDuoWorkflow } from "./providers/gitlab-duo-workflow";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import { isKimiModel, streamKimi } from "./providers/kimi";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamPiNative } from "./providers/pi-native-client";
import { isSyntheticModel, streamSynthetic } from "./providers/synthetic";
import {
	ANTHROPIC_THINKING_BUDGETS,
	BEDROCK_CLAUDE_THINKING_BUDGETS,
	GOOGLE_THINKING_BUDGETS,
	resolveThinkingBudget,
} from "./reasoning-budget";
import { healLeakedThinking, stream, withProviderInFlightLimit } from "./stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	ThinkingBudgets,
	ToolChoice,
} from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { wrapFetchForProxy } from "./utils/proxy";
import { withRequestDebugFetch } from "./utils/request-debug";
import { withGeminiThinkingLoopGuard } from "./utils/thinking-loop";

export const THINKING_LOOP_MAX_ABORTS = 3;
export const THINKING_LOOP_RETRY_BASE_DELAY_MS = 500;
export const THINKING_LOOP_RETRY_MAX_DELAY_MS = 8_000;

/**
 * Resolve a completion, re-sampling a thinking-loop stall up to
 * {@link THINKING_LOOP_MAX_ABORTS} times before letting it cook. The loop guard
 * raises an empty `stopReason: "error"` stall on each guarded attempt; this
 * result-path consumer re-dispatches a fresh request per stall and, once the abort
 * budget is spent, runs one final pass with the guard disabled so a stubborn loop
 * returns the model's raw output instead of a fatal stall. Non-stall results —
 * including genuine errors — return immediately; a caller abort during backoff
 * propagates so cancellation surfaces as an abort, never a stale stall result.
 */
export async function resolveWithThinkingLoopCook<TApi extends Api>(
	model: Model<TApi>,
	signal: AbortSignal | undefined,
	dispatch: () => AssistantMessageEventStream,
	cook: () => AssistantMessageEventStream,
): Promise<AssistantMessage> {
	let message = await dispatch().result();
	let thinkingLoopRetry = AIError.is(message.errorId, AIError.Flag.ThinkingLoop);
	for (let attempt = 0; thinkingLoopRetry && attempt < THINKING_LOOP_MAX_ABORTS - 1; attempt += 1) {
		// A caller abort surfaces as a thrown abort (never the stall, which would
		// misclassify as a 502): throwIfAborted before backoff, and scheduler.wait
		// rejects if the abort lands mid-delay.
		signal?.throwIfAborted();
		const delay = Math.min(THINKING_LOOP_RETRY_BASE_DELAY_MS * 2 ** attempt, THINKING_LOOP_RETRY_MAX_DELAY_MS);
		await scheduler.wait(delay, { signal });
		const stalled = message;
		message = await dispatch().result();
		// A loop is sampled tokens the provider bills and this re-sample throws
		// away, which is the most expensive discard in the system: carry it.
		discardAttemptUsage(model, stalled.usage, message.usage);
		thinkingLoopRetry =
			message.stopReason === "error" &&
			message.content.length === 0 &&
			AIError.is(message.errorId, AIError.Flag.ThinkingLoop);
	}
	if (!thinkingLoopRetry) return message;
	signal?.throwIfAborted();
	// Abort budget spent and still looping: let it cook with the guard disabled.
	const cooked = await cook().result();
	discardAttemptUsage(model, message.usage, cooked.usage);
	return cooked;
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopCook(
		model,
		options?.signal,
		() => stream(model, context, options),
		() => stream(model, context, { ...options, loopGuard: { ...options?.loopGuard, enabled: false } }),
	);
}

export type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

export function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return AIError.status({ message: message.errorMessage });
}

/**
 * The failure an assistant message reports, in the shape the classifier reads.
 *
 * A terminal `error` event carries its status and wording on the MESSAGE rather than on a thrown
 * error, so the rotation question could not be asked about it directly and was re-derived here from
 * the two fields. `errorId` is carried as well: the provider already classified this failure, and
 * dropping the id would make the same failure answer differently depending on which side of the
 * event boundary it was asked on.
 */
function assistantFailure(message: AssistantMessage): { status?: number; message?: string; errorId?: number } {
	return {
		status: extractStatusFromAssistantError(message),
		message: message.errorMessage,
		errorId: message.errorId,
	};
}

function createAssistantAuthError(message: AssistantMessage): Error {
	const text = message.errorMessage ?? "Provider authentication failed";
	const status = extractStatusFromAssistantError(message);
	const error =
		status === undefined
			? new AIError.ProviderResponseError(text, { kind: "runtime" })
			: new ProviderHttpError(text, status);
	return typeof message.errorId === "number" ? AIError.attach(error, message.errorId) : error;
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const baseOptions = (options || {}) as SimpleStreamOptions;
	const debugOptions = withExtraCaFetch(withRequestDebugFetch(baseOptions));
	const requestOptions = {
		...debugOptions,
		fetch: wrapFetchForProxy(debugOptions.fetch ?? (globalThis.fetch as FetchImpl), model.provider),
	} as SimpleStreamOptions;
	const apiKeyResolver = isApiKeyResolver(requestOptions?.apiKey) ? requestOptions.apiKey : undefined;
	if (apiKeyResolver) {
		const outer = new AssistantMessageEventStream();
		const signal = requestOptions?.signal;
		// One inner attempt against a resolved string key. A retryable auth error
		// that arrives before any replay-unsafe event is buffered and returned
		// (so the caller can retry with a fresh key) instead of surfaced. Once any
		// non-start event escapes, retry is no longer safe and the failure is
		// emitted directly.
		const runAttempt = async (apiKey: string): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const inner = streamSimple(model, context, { ...requestOptions, apiKey });
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						event.type === "error" &&
						isAuthRetryableError(assistantFailure(event.error))
					) {
						return { error: createAssistantAuthError(event.error), bufferedEvents, terminalEvent: event };
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				if (!emittedReplayUnsafeEvent && isAuthRetryableError(error)) {
					return { error, bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			let lastKey: string | undefined;
			try {
				lastKey = (await apiKeyResolver({ lastChance: false, error: undefined, signal })) || undefined;
			} catch (error) {
				// A thrown resolver is a broker/OAuth/network failure, not a missing
				// key — surface the cause instead of masking it as "No API key".
				outer.fail(
					new AIError.ConfigurationError(
						`Failed to resolve API key for provider ${model.provider}: ${errorMessage(error)}`,
						{ cause: error },
					),
				);
				return;
			}
			if (lastKey === undefined) {
				outer.fail(new AIError.MissingApiKeyError(model.provider));
				return;
			}
			const retryState = createAuthRetryKeyState(lastKey);
			let failure = await runAttempt(lastKey);
			if (!failure) return;
			while (true) {
				// Caller aborted between attempts: don't mint a fresh token or fire
				// another doomed request — emit the captured failure instead.
				if (signal?.aborted) break;
				const nextKey = await resolveNextAuthRetryKey(retryState, apiKeyResolver, failure.error, signal);
				if (nextKey === undefined) break;
				const next = await runAttempt(nextKey);
				if (!next) return;
				failure = next;
			}
			emitFailure(failure);
		})();
		return outer;
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	if (model.transport === "pi-native") {
		return withGeminiThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => streamPiNative(model, context, opts)),
		);
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return withGeminiThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => customApiProvider.streamSimple(model, context, opts)),
		);
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	}

	// The resolver form is handled by the wrapper above; only a static string
	// key reaches this point.
	const apiKey =
		(typeof requestOptions?.apiKey === "string" ? requestOptions.apiKey : undefined) || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	// GitLab Duo - wraps Anthropic/OpenAI behind GitLab AI Gateway direct access tokens
	if (isGitLabDuoModel(model)) {
		return withProviderInFlightLimit(model, requestOptions, () =>
			streamGitLabDuo(model, context, {
				...requestOptions,
				apiKey,
			}),
		);
	}

	// GitLab Duo Workflow - IDE workflow protocol + WebSocket action bridge
	if (model.api === "gitlab-duo-agent") {
		// Does not route through withProviderInFlightLimit, so heal explicitly.
		return healLeakedThinking(
			model,
			streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
				...requestOptions,
				apiKey,
			}),
		);
	}

	// Kimi Code - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isKimiModel(model)) {
		// Pass raw SimpleStreamOptions - streamKimi handles mapping internally
		return withProviderInFlightLimit(model, requestOptions, () =>
			streamKimi(model as Model<"openai-completions">, context, {
				...requestOptions,
				apiKey,
				format: requestOptions?.kimiApiFormat ?? "anthropic",
			}),
		);
	}

	// Synthetic - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isSyntheticModel(model)) {
		// Pass raw SimpleStreamOptions - streamSynthetic handles mapping internally
		return withProviderInFlightLimit(model, requestOptions, () =>
			streamSynthetic(model as Model<"openai-completions">, context, {
				...requestOptions,
				apiKey,
				format: requestOptions?.syntheticApiFormat ?? "openai", // Default to OpenAI format
			}),
		);
	}
	const providerOptions = mapOptionsForApi(model, requestOptions, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return resolveWithThinkingLoopCook(
		model,
		options?.signal,
		() => streamSimple(model, context, options),
		() => streamSimple(model, context, { ...options, loopGuard: { ...options?.loopGuard, enabled: false } }),
	);
}

export const MIN_OUTPUT_TOKENS = 1024;
// Fallback total output cap for models whose catalog entry has no maxTokens.
export const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncappedMaxTokens = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncappedMaxTokens, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}
export const OUTPUT_FALLBACK_BUFFER = 4000;
export const ANTHROPIC_USE_INTERLEAVED_THINKING = Bun.env.VEYYON_NO_INTERLEAVED_THINKING !== "1";

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}

export function mapGoogleToolChoice(
	choice?: ToolChoice,
): GoogleOptions["toolChoice"] | GoogleGeminiCliOptions["toolChoice"] | GoogleVertexOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	// Named-tool routing on Google: emit an `ANY`-mode allow-list of one entry,
	// mirroring the Anthropic mapper that returns `{type: "tool", name}`.
	if (choice.type === "tool") {
		return choice.name ? { mode: "ANY", allowedFunctionNames: [choice.name] } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { mode: "ANY", allowedFunctionNames: [name] } : undefined;
	}
	return undefined;
}

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

function applyReasoningSelection(
	options: SimpleStreamOptions | undefined,
	selection: ReasoningSelection,
): SimpleStreamOptions | undefined {
	const disableReasoning = options?.disableReasoning === true && selection.state === "disabled" ? true : undefined;
	if (options?.reasoning === selection.effort && options?.disableReasoning === disableReasoning) {
		return options;
	}
	return { ...options, reasoning: selection.effort, disableReasoning };
}

export const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

/** Exported for tests: effort-to-wire-id routing (devin/cursor) is invisible
 *  from outside the request, so its mapping is locked at this seam. */
export function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	rawOptions?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const reasoningSelection = resolveReasoningSelection(model, {
		effort: rawOptions?.reasoning,
		disabled: rawOptions?.disableReasoning,
	});
	const options = applyReasoningSelection(rawOptions, reasoningSelection);
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
		signal: options?.signal,
		apiKey: apiKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined),
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		taskBudget: options?.taskBudget,
		sessionId: options?.sessionId,
		conversationId: options?.conversationId,
		promptCacheKey: options?.promptCacheKey,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
		providerSessionState: options?.providerSessionState,
		maxInFlightRequests: options?.maxInFlightRequests,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		execHandlers: options?.execHandlers,
		fetch: options?.fetch,
		fallbacks: options?.fallbacks,
	};

	switch (model.api) {
		case "anthropic-messages": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			const reasoning = reasoningSelection.effort;
			if (!reasoningSelection.enabled || !reasoning) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			let thinkingBudget = resolveThinkingBudget(reasoning, ANTHROPIC_THINKING_BUDGETS, options?.thinkingBudgets);
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			const thinkingMode = model.thinking?.mode;
			const effort =
				thinkingMode === "anthropic-adaptive" || thinkingMode === "anthropic-budget-effort"
					? mapEffortToAnthropicAdaptiveEffort(model, reasoning)
					: undefined;

			// For Opus 4.6+ and Sonnet 4.6+: use adaptive thinking with effort level
			// For older models: use budget-based thinking
			if (thinkingMode === "anthropic-adaptive") {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: reasoningSelection.wireModelId,
					thinkingEnabled: true,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			if (ANTHROPIC_USE_INTERLEAVED_THINKING) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: reasoningSelection.wireModelId,
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
			const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			// If not enough room for thinking + output, reduce thinking budget
			if (maxTokens <= thinkingBudget) {
				thinkingBudget = maxTokens - MIN_OUTPUT_TOKENS;
			}

			// If thinking budget is too low, disable thinking
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			} else {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens,
					requestModelId: reasoningSelection.wireModelId,
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}
		}

		case "bedrock-converse-stream": {
			const bedrockBase: BedrockOptions = {
				...base,
				reasoning: reasoningSelection.effort,
				thinkingBudgets: options?.thinkingBudgets,
				toolChoice: mapAnthropicToolChoice(options?.toolChoice),
				thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
			};
			// Adaptive mode sends effort directly, no budget_tokens — skip budget inflation.
			if (model.thinking?.mode === "anthropic-adaptive") {
				return castApi<"bedrock-converse-stream">(bedrockBase);
			}
			const level = reasoningSelection.effort;
			if (!reasoningSelection.enabled || !level) return bedrockBase as OptionsForApi<TApi>;
			const budget = resolveThinkingBudget(level, BEDROCK_CLAUDE_THINKING_BUDGETS, options?.thinkingBudgets);
			let maxTokens = bedrockBase.maxTokens ?? model.maxTokens ?? OUTPUT_CAP_WHEN_UNKNOWN;
			let thinkingBudgets = bedrockBase.thinkingBudgets;
			if (maxTokens <= budget) {
				const desiredMaxTokens = Math.min(model.maxTokens ?? Number.POSITIVE_INFINITY, budget + MIN_OUTPUT_TOKENS);
				if (desiredMaxTokens > maxTokens) {
					maxTokens = desiredMaxTokens;
				}
			}
			if (maxTokens <= budget) {
				const adjustedBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				thinkingBudgets = { ...(thinkingBudgets ?? {}), [level]: adjustedBudget };
			}
			return castApi<"bedrock-converse-stream">({ ...bedrockBase, maxTokens, thinkingBudgets });
		}

		case "openrouter": {
			const useResponses = $env.VEYYON_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return castApi<"openai-responses">({
					...base,
					reasoning: reasoningSelection.effort,
					toolChoice: mapOpenAiToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
					reasoningSummary: options?.hideThinkingSummary ? null : undefined,
					openrouterVariant: options?.openrouterVariant,
					maxTokensExplicit: rawOptions?.maxTokens !== undefined,
					disableReasoning: options?.disableReasoning,
					textVerbosity: options?.textVerbosity,
				});
			}
			return castApi<"openai-completions">({
				...base,
				reasoning: reasoningSelection.effort,
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
			});
		}

		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: reasoningSelection.effort,
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: reasoningSelection.effort,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				disableReasoning: options?.disableReasoning,
				textVerbosity: options?.textVerbosity,
			});

		case "azure-openai-responses":
			return castApi<"azure-openai-responses">({
				...base,
				reasoning: reasoningSelection.effort,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		case "openai-codex-responses":
			return castApi<"openai-codex-responses">({
				...base,
				reasoning: reasoningSelection.effort,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				preferWebsockets: options?.preferWebsockets,
				codexCompaction: options?.codexCompaction,
				reasoningSummary: options?.hideThinkingSummary ? null : "detailed",
				textVerbosity: options?.textVerbosity,
			});

		case "google-generative-ai": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			// This is needed because Gemini has "dynamic thinking" enabled by default
			const reasoning = reasoningSelection.effort;
			if (!reasoningSelection.enabled || !reasoning) {
				return castApi<"google-generative-ai">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const googleModel = model as Model<"google-generative-ai">;
			const effort = requireSupportedEffort(googleModel, reasoning);

			// Gemini 3+ models use thinkingLevel exclusively instead of thinkingBudget.
			// https://ai.google.dev/gemini-api/docs/thinking#set-budget
			if (googleModel.thinking?.mode === "google-level") {
				return castApi<"google-generative-ai">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort),
					},
					hideThinkingSummary: options?.hideThinkingSummary,
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			return castApi<"google-gemini-cli">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(googleModel, effort, options?.thinkingBudgets),
				},
				hideThinkingSummary: options?.hideThinkingSummary,
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
			});
		}

		case "google-gemini-cli": {
			const reasoning = reasoningSelection.effort;
			const toolChoice = mapGoogleToolChoice(options?.toolChoice);
			if (reasoningSelection.enabled && reasoning) {
				const effort = requireSupportedEffort(model, reasoning);

				// Gemini 3+ models use thinkingLevel instead of thinkingBudget
				if (model.thinking?.mode === "google-level") {
					return castApi<"google-gemini-cli">({
						...base,
						requestModelId: reasoningSelection.wireModelId,
						thinking: {
							enabled: true,
							level: mapEffortToGoogleThinkingLevel(effort),
						},
						hideThinkingSummary: options?.hideThinkingSummary,
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}

				let thinkingBudget = resolveThinkingBudget(
					effort,
					GOOGLE_THINKING_BUDGETS,
					options?.thinkingBudgets,
					model.thinking?.effortBudgets,
				);

				// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
				const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

				// If not enough room for thinking + output, reduce thinking budget
				if (maxTokens <= thinkingBudget) {
					thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				}

				if (thinkingBudget > 0) {
					return castApi<"google-gemini-cli">({
						...base,
						maxTokens,
						requestModelId: reasoningSelection.wireModelId,
						thinking: { enabled: true, budgetTokens: thinkingBudget },
						hideThinkingSummary: options?.hideThinkingSummary,
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}
				// Budget clamped to zero — fall through to the thinking-off path.
			}

			const thinking: GoogleGeminiCliOptions["thinking"] = { enabled: false };
			if (model.reasoning && model.thinking?.suppressWhenOff) {
				// CCA re-applies the per-id baked server default when the config
				// is omitted; suppression must be explicit on the wire.
				thinking.suppress = model.thinking.mode === "google-level" ? { level: "MINIMAL" } : { budget: 0 };
			}
			return castApi<"google-gemini-cli">({
				...base,
				requestModelId: resolveWireModelId(model, undefined),
				thinking,
				toolChoice,
				antigravityEndpointMode: options?.antigravityEndpointMode,
			});
		}

		case "google-vertex": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			const reasoning = reasoningSelection.effort;
			if (!reasoningSelection.enabled || !reasoning) {
				return castApi<"google-vertex">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const vertexModel = model as Model<"google-vertex">;
			const effort = requireSupportedEffort(vertexModel, reasoning);
			const geminiModel = vertexModel as unknown as Model<"google-generative-ai">;

			if (geminiModel.thinking?.mode === "google-level") {
				return castApi<"google-vertex">({
					...base,
					serviceTier: options?.serviceTier,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort),
					},
					hideThinkingSummary: options?.hideThinkingSummary,
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			return castApi<"google-vertex">({
				...base,
				serviceTier: options?.serviceTier,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(geminiModel, effort, options?.thinkingBudgets),
				},
				hideThinkingSummary: options?.hideThinkingSummary,
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
			});
		}

		case "ollama-chat":
			return castApi<"ollama-chat">({
				...base,
				reasoning: reasoningSelection.effort,
				disableReasoning: options?.disableReasoning,
				toolChoice: options?.toolChoice,
			});

		case "cursor-agent": {
			const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
			const onToolResult = options?.cursorOnToolResult ?? execHandlers?.onToolResult;
			// Cursor carries no wire effort param: effort selects a tier-suffixed
			// sibling model id via `thinking.effortRouting` (mirrors devin-agent).
			return castApi<"cursor-agent">({
				...base,
				execHandlers,
				onToolResult,
				wireModelId: reasoningSelection.wireModelId,
			});
		}

		case "gitlab-duo-agent":
			return castApi<"gitlab-duo-agent">({
				...base,
				cwd: options?.cwd,
				toolChoice: options?.toolChoice,
			});
		case "devin-agent":
			return castApi<"devin-agent">({
				...base,
				chatModelUid: reasoningSelection.wireModelId,
			});
		default:
			throw new AIError.ConfigurationError(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}

export function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: Effort,
	customBudgets?: ThinkingBudgets,
): number {
	requireSupportedEffort(model, effort);

	// Custom budgets take precedence if provided for this level
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	// See https://ai.google.dev/gemini-api/docs/thinking#set-budget
	if (model.id.includes("2.5-")) {
		switch (effort) {
			case "minimal":
				return 128;
			case "low":
				return 2048;
			case "medium":
				return 8192;
			case "high":
				// The 2.5 rows declare a budget range and no levels, so the ladder is the
				// budget mode's own minimal..xhigh; high must sit below xhigh or the two
				// top tiers are the same request.
				return 16_384;
			case "xhigh":
			case "max":
				return model.id.includes("2.5-flash") ? 24576 : 32768;
		}
	}

	// Every effort level used to land here as -1, Gemini's "you decide" sentinel, for any id
	// without "2.5-" in it. That made the thinking control a no-op on eleven bundled rows:
	// `gemini-flash-latest` and `-lite` on both `google` and `google-vertex`, plus 7 `gemma-4`
	// rows. minimal, low, medium and high all produced the byte-identical
	// `{enabled: true, budgetTokens: -1}`, so the operator set an effort, the request did not
	// change, and nothing said so.
	//
	// Refuse rather than invent a number. A budget picked for a row whose underlying model is
	// unknown is a second silent wrong answer: `gemini-flash-latest` is an alias, and the Gemini 3
	// generation takes `thinkingLevel` rather than `thinkingBudget`, so a plausible-looking value
	// could be wrong in a way no one would ever observe. The caller can pick a row that accepts a
	// budget, or leave thinking off and take the model's own behaviour.
	throw new AIError.ConfigurationError(
		`${model.provider}/${model.id} does not accept a thinking budget, so the requested effort "${effort}" would change nothing about the request. ` +
			`Choose a model that supports budgeted thinking (the Gemini 2.5 family on this API), pass an explicit thinkingBudgets entry for "${effort}", or turn thinking off for this model.`,
	);
}
