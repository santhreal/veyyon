import { prompt } from "@veyyon/utils";
import { subagentPrompts } from "../../prompts/subagent/rows";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * The "workflowz" keyword's DETECTION half: whether a message mentions it.
 *
 * Split from `./workflow` for the same reason as `./ultrathink-keyword` and
 * `./orchestrate-keyword`, the other two members of this family. The editor
 * gradient that paints the word needs `./gradient-highlight`, which reaches the
 * theme engine and 146 modules with it, and `session/agent-session` was paying for
 * all of it to ask one question about a string. Detection is domain logic and
 * highlighting is terminal presentation.
 *
 * Import this when you need to KNOW about the keyword. Import `./workflow` when
 * you need to DRAW it, and `./magic-keyword-notices` when you need to SEND the
 * notice it appends.
 */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const WORKFLOW_WORD = magicKeywordRegex("workflowz");

/**
 * Whether `text` contains the standalone keyword "workflowz"
 * (lowercase, prose-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}
