import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type SyntheticApiFormat = OpenAIAnthropicApiFormat;

const SYNTHETIC_NEW_BASE_URL = "https://api.synthetic.new/openai/v1";
const SYNTHETIC_NEW_ANTHROPIC_BASE_URL = "https://api.synthetic.new/anthropic";

export interface SyntheticOptions extends OpenAIAnthropicShimOptions {
	format?: SyntheticApiFormat;
}

export function streamSynthetic(
	model: Model<"openai-completions">,
	context: Context,
	options?: SyntheticOptions,
): AssistantMessageEventStream {
	return streamOpenAIAnthropicShim(model, context, options, {
		anthropicBaseUrl: SYNTHETIC_NEW_ANTHROPIC_BASE_URL,
		openaiBaseUrl: SYNTHETIC_NEW_BASE_URL,
		defaultFormat: "openai",
	});
}

export function isSyntheticModel(model: Model<Api>): boolean {
	return model.provider === "synthetic";
}
