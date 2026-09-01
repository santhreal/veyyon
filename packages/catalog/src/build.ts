import { buildAnthropicCompat } from "./compat/anthropic";
import { buildCursorCompat } from "./compat/cursor";
import { buildDevinCompat } from "./compat/devin";
import { buildOpenAICompat, buildOpenAIResponsesCompat, buildOpenRouterCompat } from "./compat/openai";
import { resolveModelThinking } from "./model-thinking";
import type { Api, CompatOf, Model, ModelSpec } from "./types";
import { cleanModelName } from "./utils";

export function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	const compat = buildCompat(spec) as CompatOf<TApi>;
	return {
		...spec,
		name: cleanModelName(spec.name),
		thinking: resolveModelThinking(spec, compat),
		compat,
		compatConfig: spec.compat,
	} as Model<TApi>;
}

export function buildCompat(spec: ModelSpec<Api>): CompatOf<Api> {
	switch (spec.api) {
		case "openrouter":
			return buildOpenRouterCompat(spec as ModelSpec<"openrouter">);
		case "openai-completions":
			return buildOpenAICompat(spec as ModelSpec<"openai-completions">);
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return buildOpenAIResponsesCompat(spec as ModelSpec<"openai-responses">);
		case "anthropic-messages":
			return buildAnthropicCompat(spec as ModelSpec<"anthropic-messages">);
		case "devin-agent":
			return buildDevinCompat(spec as ModelSpec<"devin-agent">);
		case "cursor-agent":
			return buildCursorCompat(spec as ModelSpec<"cursor-agent">);
		default:
			return undefined;
	}
}
