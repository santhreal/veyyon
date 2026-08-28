import { subagentPrompts } from "../prompts/subagent/rows";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/** The "orchestratez" keyword's DETECTION half: whether a message mentions it, and the notice appended when it does. */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const ORCHESTRATE_WORD = magicKeywordRegex("orchestratez");

/** Hidden system notice appended after a user message that mentions "orchestratez". */
export const ORCHESTRATE_NOTICE: string = subagentPrompts["subagent/orchestrate-notice"].text.trim();

/** Whether `text` contains the standalone keyword "orchestratez" (lowercase, prose-delimited) in prose — never inside a code block, inline code span, */
export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}
