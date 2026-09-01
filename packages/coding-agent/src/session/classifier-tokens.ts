/** Shared token budget for tiny-model yes/no and difficulty classifiers. Single owner for `unexpected-stop-classifier.ts` and `auto-thinking/classifier.ts` */

/** Online classifier budget. Sized to survive backends that ignore `disableReasoning` (e.g. Qwen3 via llama.cpp catalogued `reasoning: false` */
export const REASONING_SAFE_MAX_TOKENS = 1024;
