import { isDeepseekModelIdOrName } from "../identity/family";
import type { OpenAIStreamMarkupHealingPattern } from "../types";

export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

const DSML_HEALING_PROVIDERS: ReadonlySet<string> = new Set([
	"ollama",
	"ollama-cloud",
	"nvidia",
	"deepseek",
	"fireworks",
	"nanogpt",
	"opencode-go",
	"openrouter",
]);

export function modelMayLeakDsmlToolCalls(provider: string, modelId: string): boolean {
	return isDeepseekModelIdOrName(modelId) && DSML_HEALING_PROVIDERS.has(provider);
}

export function leakedToolCallGrammar(provider: string, modelId: string): OpenAIStreamMarkupHealingPattern | undefined {
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (modelMayLeakDsmlToolCalls(provider, modelId)) return "dsml";
	return undefined;
}
