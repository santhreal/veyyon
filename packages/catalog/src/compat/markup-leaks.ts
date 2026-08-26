/**
 * Which endpoints leak model markup into the visible text channel, and which grammar it is. Belongs beside
 * the catalog's model identity — `@veyyon/ai` and OpenAI compat resolution both compose from this. Two lists
 * that used to be duplicated in both consumers.
 */
import { isDeepseekModelIdOrName } from "../identity/family";
import type { OpenAIStreamMarkupHealingPattern } from "../types";

/** Kimi-K2 chat-template token leaks, by provider or by model id. */
export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

/** The hosts that front DeepSeek models and pass its DSML tool-call envelope through as content. */
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

/** DeepSeek DSML envelope leaks: a DeepSeek model on a host that does not parse the envelope itself. */
export function modelMayLeakDsmlToolCalls(provider: string, modelId: string): boolean {
	return isDeepseekModelIdOrName(modelId) && DSML_HEALING_PROVIDERS.has(provider);
}

/**
 * The tool-call grammar this model may leak, or `undefined` when only reasoning idioms can.
 *
 * `undefined` is not "heals nothing": every pattern runs the reasoning healer, and the caller decides
 * whether a stream with no tool-call grammar to read still needs the reasoning floor.
 */
export function leakedToolCallGrammar(provider: string, modelId: string): OpenAIStreamMarkupHealingPattern | undefined {
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (modelMayLeakDsmlToolCalls(provider, modelId)) return "dsml";
	return undefined;
}
