import { subagentPrompts } from "../prompts/subagent/rows";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * The "orchestratez" keyword's DETECTION half: whether a message mentions it,
 * and the notice appended when it does.
 *
 * WHY THE TOKEN IS NOT `orchestrate`. It was, and `orchestrate` is an ordinary
 * English verb. "orchestrate the release", "orchestrate this migration
 * yourself", "do not orchestrate anything" each appended the hidden notice, and
 * that notice tells the model to drive the work as a multi-phase parallel
 * subagent run and to override any tendency to do it inline. So an operator
 * writing an ordinary sentence got a different execution strategy than the one
 * they had just described, invisibly, because the notice does not display. A
 * magic keyword has to be a token nobody types by accident: `ultrathink` is not
 * a word, `workflowz` is deliberately misspelled for exactly this reason, and
 * this one now carries the same `z`.
 *
 * Split from `./orchestrate`, which also owns the editor gradient that paints the
 * word as you type. That highlighter needs `./gradient-highlight`, which reaches
 * the theme engine and 146 modules with it, and `session/agent-session` was paying
 * for all of it to ask one question about a string. Detection is domain logic and
 * highlighting is terminal presentation; they only shared a file because they
 * share a keyword.
 *
 * Import this when you need to KNOW about the keyword. Import `./orchestrate`
 * when you need to DRAW it.
 */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const ORCHESTRATE_WORD = magicKeywordRegex("orchestratez");

/** Hidden system notice appended after a user message that mentions "orchestratez". */
export const ORCHESTRATE_NOTICE: string = subagentPrompts["subagent/orchestrate-notice"].text.trim();

/**
 * Whether `text` contains the standalone keyword "orchestratez" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section. The ordinary verb `orchestrate` is not a trigger.
 */
export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}
