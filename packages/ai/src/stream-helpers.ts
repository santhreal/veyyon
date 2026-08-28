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

export async function resolveWithThinkingLoopCook<TApi extends Api>(
	model: Model<TApi>,
	signal: AbortSignal | undefined,
	dispatch: () => AssistantMessageEventStream,
	cook: () => AssistantMessageEventStream,
): Promise<AssistantMessage> {
	let message = await dispatch().result();
	let thinkingLoopRetry = AIError.is(message.errorId, AIError.Flag.ThinkingLoop);
	for (let attempt = 0; thinkingLoopRetry && attempt < THINKING_LOOP_MAX_ABORTS - 1; attempt += 1) {
		signal?.throwIfAborted();
		const delay = Math.min(THINKING_LOOP_RETRY_BASE_DELAY_MS * 2 ** attempt, THINKING_LOOP_RETRY_MAX_DELAY_MS);
		await scheduler.wait(delay, { signal });
		const stalled = message;
		message = await dispatch().result();
		discardAttemptUsage(model, stalled.usage, message.usage);
		thinkingLoopRetry =
			message.stopReason === "error" &&
			message.content.length === 0 &&
			AIError.is(message.errorId, AIError.Flag.ThinkingLoop);
	}
	if (!thinkingLoopRetry) return message;
	signal?.throwIfAborted();
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

export function assistantFailure(message: AssistantMessage): { status?: number; message?: string; errorId?: number } {
	return {
		status: extractStatusFromAssistantError(message),
		message: message.errorMessage,
		errorId: message.errorId,
	};
}

export function createAssistantAuthError(message: AssistantMessage): Error {
	const text = message.errorMessage ?? "Provider authentication failed";
	const status = extractStatusFromAssistantError(message);
	const error =
		status === undefined
			? new AIError.ProviderResponseError(text, { kind: "runtime" })
			: new ProviderHttpError(text, status);
	return typeof message.errorId === "number" ? AIError.attach(error, message.errorId) : error;
}

export function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
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

	if (model.transport === "pi-native") {
		return withGeminiThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => streamPiNative(model, context, opts)),
		);
	}

	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return withGeminiThinkingLoopGuard(model, requestOptions, opts =>
			withProviderInFlightLimit(model, opts, () => customApiProvider.streamSimple(model, context, opts)),
		);
	}

	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (model.api === "bedrock-converse-stream") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	}

	const apiKey =
		(typeof requestOptions?.apiKey === "string" ? requestOptions.apiKey : undefined) || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	if (isGitLabDuoModel(model)) {
		return withProviderInFlightLimit(model, requestOptions, () =>
			streamGitLabDuo(model, context, {
				...requestOptions,
				apiKey,
			}),
		);
	}

	if (model.api === "gitlab-duo-agent") {
		return healLeakedThinking(
			model,
			streamGitLabDuoWorkflow(model as Model<"gitlab-duo-agent">, context, {
				...requestOptions,
				apiKey,
			}),
		);
	}

	if (isKimiModel(model)) {
		return withProviderInFlightLimit(model, requestOptions, () =>
			streamKimi(model as Model<"openai-completions">, context, {
				...requestOptions,
				apiKey,
				format: requestOptions?.kimiApiFormat ?? "anthropic",
			}),
		);
	}

	if (isSyntheticModel(model)) {
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
export const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
export function maxTokensWithThinkingBudget(
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
	if (choice.type === "tool") {
		return choice.name ? { mode: "ANY", allowedFunctionNames: [choice.name] } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { mode: "ANY", allowedFunctionNames: [name] } : undefined;
	}
	return undefined;
}

export function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
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

export function applyReasoningSelection(
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

			const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			if (maxTokens <= thinkingBudget) {
				thinkingBudget = maxTokens - MIN_OUTPUT_TOKENS;
			}

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

				const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

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
			}

			const thinking: GoogleGeminiCliOptions["thinking"] = { enabled: false };
			if (model.reasoning && model.thinking?.suppressWhenOff) {
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
			return castApi<"cursor-agent">({
				...base,
				execHandlers,
				onToolResult,
				cursorRules: options?.cursorRules,
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

	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (model.id.includes("2.5-")) {
		switch (effort) {
			case "minimal":
				return 128;
			case "low":
				return 2048;
			case "medium":
				return 8192;
			case "high":
				return 16_384;
			case "xhigh":
			case "max":
				return model.id.includes("2.5-flash") ? 24576 : 32768;
		}
	}

	throw new AIError.ConfigurationError(
		`${model.provider}/${model.id} does not accept a thinking budget, so the requested effort "${effort}" would change nothing about the request. ` +
			`Choose a model that supports budgeted thinking (the Gemini 2.5 family on this API), pass an explicit thinkingBudgets entry for "${effort}", or turn thinking off for this model.`,
	);
}
