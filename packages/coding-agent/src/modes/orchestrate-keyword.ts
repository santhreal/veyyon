import { PROMPTS } from "../prompts/registry";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * The "orchestrate" keyword's DETECTION half: whether a message mentions it, and
 * the notice appended when it does.
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
const ORCHESTRATE_WORD = magicKeywordRegex("orchestrate");

/** Hidden system notice appended after a user message that mentions "orchestrate". */
export const ORCHESTRATE_NOTICE: string = PROMPTS["subagent/orchestrate-notice"].text.trim();

/**
 * Whether `text` contains the standalone keyword "orchestrate" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}
