import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

const KIMI_ANTHROPIC_BASE_URL = "https://api.kimi.com/coding";

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	format?: KimiApiFormat;
}

export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: KIMI_ANTHROPIC_BASE_URL,
		defaultFormat: "anthropic",
		extraHeaders: getKimiCommonHeaders,
	});
}

export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
