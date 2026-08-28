import { buildModel } from "@veyyon/catalog/build";
import { resolveReasoningSelection } from "@veyyon/catalog/model-thinking";
import { ANTHROPIC_THINKING_BUDGETS, resolveThinkingBudget } from "../reasoning-budget";
import { mapAnthropicToolChoice } from "../stream";
import type { Context, Model, ModelSpec, SimpleStreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamAnthropic, streamOpenAICompletions } from "./register-builtins";

export type OpenAIAnthropicApiFormat = "openai" | "anthropic";

export interface OpenAIAnthropicShimOptions extends SimpleStreamOptions {
	format?: OpenAIAnthropicApiFormat;
}

export interface OpenAIAnthropicShimConfig {
	anthropicBaseUrl: string;
	openaiBaseUrl?: string;
	defaultFormat: OpenAIAnthropicApiFormat;
	extraHeaders?: () => Record<string, string>;
}

export function streamOpenAIAnthropicShim(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAIAnthropicShimOptions | undefined,
	config: OpenAIAnthropicShimConfig,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const format = options?.format ?? config.defaultFormat;
	// The resolver form of `apiKey` is resolved upstream in `streamSimple`;
	// this shim only ever receives a static bearer string.
	const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;

	(async () => {
		try {
			const mergedHeaders = {
				...(config.extraHeaders?.() ?? {}),
				...options?.headers,
			};

			if (format === "anthropic") {
				const anthropicModel = buildModel({
					id: model.id,
					name: model.name,
					api: "anthropic-messages",
					provider: model.provider,
					baseUrl: config.anthropicBaseUrl,
					headers: mergedHeaders,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
				} as ModelSpec<"anthropic-messages">);

				const reasoningSelection = resolveReasoningSelection(anthropicModel, {
					effort: options?.reasoning,
					disabled: options?.disableReasoning,
				});
				const reasoningEffort = reasoningSelection.effort;
				const thinkingEnabled = reasoningSelection.enabled;
				const thinkingBudget = reasoningEffort
					? resolveThinkingBudget(reasoningEffort, ANTHROPIC_THINKING_BUDGETS, options?.thinkingBudgets)
					: undefined;

				const innerStream = streamAnthropic(anthropicModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					sessionId: options?.sessionId,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					thinkingEnabled,
					thinkingBudgetTokens: thinkingBudget,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
				// An inner that ends without a terminal event must still settle this
				// stream; a result-less end rejects innerStream.result() into the
				// catch, which emits a terminal error. Otherwise consumers park forever.
				if (!stream.done) stream.end(await innerStream.result());
			} else {
				const openaiModel: Model<"openai-completions"> = config.openaiBaseUrl
					? buildModel({
							...model,
							baseUrl: config.openaiBaseUrl,
							headers: mergedHeaders,
							compat: model.compatConfig,
						} as ModelSpec<"openai-completions">)
					: model;

				const reasoningEffort = options?.reasoning;
				const innerStream = streamOpenAICompletions(openaiModel, context, {
					apiKey,
					temperature: options?.temperature,
					topP: options?.topP,
					topK: options?.topK,
					minP: options?.minP,
					presencePenalty: options?.presencePenalty,
					repetitionPenalty: options?.repetitionPenalty,
					maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
					signal: options?.signal,
					headers: mergedHeaders,
					sessionId: options?.sessionId,
					onPayload: options?.onPayload,
					onResponse: options?.onResponse,
					onSseEvent: options?.onSseEvent,
					fetch: options?.fetch,
					reasoning: reasoningEffort,
					toolChoice: options?.toolChoice,
					serviceTier: options?.serviceTier,
					disableReasoning: options?.disableReasoning,
				});

				for await (const event of innerStream) {
					stream.push(event);
				}
				// An inner that ends without a terminal event must still settle this
				// stream; a result-less end rejects innerStream.result() into the
				// catch, which emits a terminal error. Otherwise consumers park forever.
				if (!stream.done) stream.end(await innerStream.result());
			}
		} catch (err) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, err),
			});
		}
	})();

	return stream;
}
