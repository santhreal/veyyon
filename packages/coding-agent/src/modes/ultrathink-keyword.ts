import { turnControlPrompts } from "../prompts/turn-control/rows";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/** The "ultrathink" keyword's DETECTION half: whether a message mentions it, and the notice appended when it does. */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const ULTRATHINK_WORD = magicKeywordRegex("ultrathink");

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = turnControlPrompts["turn-control/ultrathink-notice"].text.trim();

/** Whether `text` contains the standalone keyword "ultrathink" (lowercase, prose-delimited) in prose — never inside a code block, inline code span, */
export function containsUltrathink(text: string): boolean {
	return keywordInProse(text, ULTRATHINK_WORD);
}
