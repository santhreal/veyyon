/**
 * An agent's resolved model string, split into the two facts a badge shows.
 *
 * The executor reports one string — `provider/id[:level]` — and every surface that shows it wants
 * the id without its provider and the reasoning level on its own. The split is not obvious: a model
 * id may itself contain a colon (`qwen3:14b`), so the suffix counts as a level only when it parses
 * as one, and splitting on the first colon turned `qwen3:14b` into the model `qwen3` at an invented
 * level. Stated once here, so the terminal badge and the task card cannot disagree about it.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import { parseThinkingLevel } from "../thinking";

/** The model id a selector names, without its provider, and the level it runs at when it states one. */
export function splitModelSelector(resolved: string): { model: string; level: ThinkingLevel | undefined } {
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level === undefined ? resolved : resolved.slice(0, colon);
	return { model: selector.slice(selector.indexOf("/") + 1), level };
}
