/**
 * Kimi Code provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Kimi Code runs one deployment for mainland China (api.kimi.com) and one for every other region
 * (api.kimi.ai), each exposing both an OpenAI-compatible API (`/coding/v1/chat/completions`) and an
 * Anthropic-compatible one (`/coding/v1/messages`). A token is accepted only by the deployment that
 * issued it; the API key names that deployment (see `@veyyon/catalog/wire/kimi-code`).
 *
 * The Anthropic API is generally more stable and recommended.
 * Note: Kimi calculates TPM rate limits based on max_tokens, not actual output.
 */

import { resolveKimiCodeEndpoint } from "@veyyon/catalog/wire/kimi-code";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	/** API format: "openai" or "anthropic". Default: "anthropic" */
	format?: KimiApiFormat;
}

/**
 * Stream from Kimi Code, routing to either OpenAI or Anthropic API based on format, at the deployment
 * that issued the token. Returns synchronously like other providers - async header fetching happens
 * internally.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	// `streamSimple` always passes a string key, stored or read from `KIMI_API_KEY`. A direct caller
	// without one is routed to the configured base's deployment and fails at the inner client.
	const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
	const endpoint = resolveKimiCodeEndpoint(apiKey ?? "", model.baseUrl);
	return streamOpenAIAnthropicShim(
		model,
		context,
		apiKey === undefined ? options : { ...options, apiKey: endpoint.apiKey },
		{
			// The Anthropic SDK appends /v1/messages, so this base does not include /v1.
			anthropicBaseUrl: endpoint.anthropicBaseUrl,
			openaiBaseUrl: endpoint.baseUrl === model.baseUrl ? undefined : endpoint.baseUrl,
			defaultFormat: "anthropic",
			extraHeaders: getKimiCommonHeaders,
		},
	);
}

/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
