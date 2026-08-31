/**
 * Which endpoints leak model markup into the visible text channel, and which grammar it is.
 *
 * A model that streams its chat template, its tool-call envelope or its reasoning idiom as ordinary
 * content needs that markup read back out. WHICH grammar to read is a fact about the provider and the
 * model id, so it belongs beside the rest of the catalog's model identity rather than in the code that
 * does the reading — `@veyyon/ai` composes the healer from this, and the OpenAI compat resolution
 * composes the per-model `streamMarkupHealingPattern` from it. Both used to carry their own copy of
 * these two lists, byte for byte, one as a `Set` and one as an or-chain, which is two places for a
 * newly-leaking provider to be added to only one of.
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
