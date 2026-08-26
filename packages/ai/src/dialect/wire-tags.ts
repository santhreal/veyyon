/**
 * The in-band tag vocabulary the ChatML-family dialects share. Each tag is a byte sequence that appears in
 * a prompt this repo writes AND in model output this repo parses — a contract between renderer, scanner, and
 * detector. Nothing validates agreement; drift turns tool calls into visible text.
 * Before this module the vocabulary was declared 19 times across 8 modules under 15 names. This leaf imports
 * nothing so `utils/validation.ts` can reach tags without pulling in dialect types. Per-dialect tags (DeepSeek,
 * Harmony, Gemma, Gemini) stay with their dialect.
 */

/**
 * The Hermes tool-call envelope: `<tool_call>` … `</tool_call>` around a call body.
 *
 * Three dialects speak it, and they do NOT agree on the body. Hermes and Qwen3 put a JSON object inside;
 * GLM puts `<arg_key>`/`<arg_value>` pairs there. The envelope is shared, the body is not, which is why these
 * two are separate from the arg tags below rather than bundled into one "GLM format" record.
 */
export const TOOL_CALL_OPEN = "<tool_call>";
export const TOOL_CALL_CLOSE = "</tool_call>";

/**
 * The tool-result envelope the host writes back into the transcript.
 *
 * This pair crosses the widest boundary of anything here. `rendering.ts` WRITES it when it renders tool
 * results, and `owned-stream.ts` LOOKS FOR it to find where the host's injected text begins so a model that
 * carries on past its own call can be cut off there. Those two modules never reference each other. Change the
 * renderer's tag alone and the detector's search simply finds nothing: no error, no log, and the model's
 * hallucinated continuation of the tool output lands in the visible transcript as if it were real.
 */
export const TOOL_RESPONSE_OPEN = "<tool_response>";
export const TOOL_RESPONSE_CLOSE = "</tool_response>";

/**
 * GLM's argument tags, one pair naming the argument and one pair holding its value.
 *
 * Shared between the GLM scanner, which parses them from a stream, and `utils/validation.ts`, which finds them
 * where they should never be: inside the arguments of a tool call the PROVIDER already parsed server-side,
 * left there when the model botched an `</arg_value>` closer. That repair is keyed on the exact closer bytes,
 * so a copy that drifted would not fail loudly. It would just stop recognising the spill and hand the tool a
 * string with markup in it.
 */
export const ARG_KEY_OPEN = "<arg_key>";
export const ARG_KEY_CLOSE = "</arg_key>";
export const ARG_VALUE_OPEN = "<arg_value>";
export const ARG_VALUE_CLOSE = "</arg_value>";

/**
 * The short `<think>` envelope shared by the ChatML-style dialects (deepseek, glm, hermes, kimi, pi-native,
 * qwen3). Gemini deliberately differs and keeps its own fenced ` ```thinking ` delimiters with its dialect.
 */
export const THINK_OPEN = "<think>";
export const THINK_CLOSE = "</think>";

/**
 * The longer `<thinking>` envelope used by the XML-style dialects (anthropic, minimax, xml).
 *
 * Deliberately distinct from `<think>` above. The two families are not interchangeable, so they get two pairs
 * of constants rather than one pair switched by a flag: a flag would let a caller pick the wrong family at
 * runtime, and the failure would be a model whose reasoning stops being recognised as reasoning.
 */
export const XML_THINKING_OPEN = "<thinking>";
export const XML_THINKING_CLOSE = "</thinking>";

/**
 * A markdown code fence, three backticks.
 *
 * Shared because two dialects SCAN for it: DeepSeek closes a tool call's arguments at the last fence, and
 * Gemini closes a code block at the first one. Neither emits it, so this is a parser's vocabulary rather than a
 * renderer's, and a copy that drifted would make one dialect stop finding the end of a block and swallow the
 * rest of the stream as arguments.
 *
 * Fences that carry an INFO STRING stay with their dialect, because the string is the dialect's own convention:
 * DeepSeek's `` ```json `` and Gemini's `` ```thinking `` are not shared vocabulary.
 */
export const CODE_FENCE = "```";
