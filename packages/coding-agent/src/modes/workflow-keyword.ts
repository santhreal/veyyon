import { prompt } from "@veyyon/utils";
import { PROMPTS } from "../prompts/registry";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * The "workflowz" keyword's DETECTION half: whether a message mentions it, and
 * the notice rendered when it does.
 *
 * Split from `./workflow` for the same reason as `./ultrathink-keyword` and
 * `./orchestrate-keyword`, the other two members of this family. The editor
 * gradient that paints the word needs `./gradient-highlight`, which reaches the
 * theme engine and 146 modules with it, and `session/agent-session` was paying for
 * all of it to ask one question about a string. Detection is domain logic and
 * highlighting is terminal presentation.
 *
 * Import this when you need to KNOW about the keyword. Import `./workflow` when
 * you need to DRAW it.
 */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const WORKFLOW_WORD = magicKeywordRegex("workflowz");

/** WORKFLOW_NOTICE is the default hidden notice for sessions with batched task calls enabled. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });

/** renderWorkflowNotice renders the workflow notice for the active task schema. */
export function renderWorkflowNotice({ taskBatch }: { taskBatch: boolean }): string {
	return prompt.render(PROMPTS["subagent/workflow-notice"].text, { taskBatch }).trim();
}

/**
 * Whether `text` contains the standalone keyword "workflowz"
 * (lowercase, prose-delimited) in prose — never inside a code block, inline
 * code span, or XML/HTML section.
 */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}
