/**
 * Shared token budget for tiny-model yes/no and difficulty classifiers.
 * Single owner for `unexpected-stop-classifier.ts` and `auto-thinking/classifier.ts`
 * — see BACKLOG SPEC-ONE-PLACE-AUDIT F4.
 */

/**
 * Online classifier budget. Sized to survive backends that ignore
 * `disableReasoning` (e.g. Qwen3 via llama.cpp catalogued `reasoning: false`
 * but still emitting thinking): the classifier keyword needs to land after any
 * unavoidable thinking preamble. `maxTokens` is a hard cap — non-thinking
 * completions still return in a handful of tokens (issue #4355).
 */
export const REASONING_SAFE_MAX_TOKENS = 1024;
