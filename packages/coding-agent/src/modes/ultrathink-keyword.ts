import { turnControlPrompts } from "../prompts/turn-control/rows";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * The "ultrathink" keyword's DETECTION half: whether a message mentions it, and
 * the notice appended when it does.
 *
 * Split from `./ultrathink` for the same reason as `./orchestrate-keyword`. The
 * editor gradient that paints the word needs `./gradient-highlight`, which reaches
 * the theme engine and 146 modules with it, and `session/agent-session` was paying
 * for all of it to ask one question about a string. Detection is domain logic and
 * highlighting is terminal presentation.
 *
 * Import this when you need to KNOW about the keyword. Import `./ultrathink` when
 * you need to DRAW it.
 */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const ULTRATHINK_WORD = magicKeywordRegex("ultrathink");

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = turnControlPrompts["turn-control/ultrathink-notice"].text.trim();

/**
 * Whether `text` contains the standalone keyword "ultrathink" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltrathink(text: string): boolean {
	return keywordInProse(text, ULTRATHINK_WORD);
}
