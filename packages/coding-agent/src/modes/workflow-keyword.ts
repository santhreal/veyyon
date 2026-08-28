import { prompt } from "@veyyon/utils";
import { subagentPrompts } from "../prompts/subagent/rows";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/** The "workflowz" keyword's DETECTION half: whether a message mentions it, and the notice rendered when it does. */

/** Lowercase keyword flanked by prose punctuation, whitespace, or a string edge. */
const WORKFLOW_WORD = magicKeywordRegex("workflowz");

/** WORKFLOW_NOTICE is the default hidden notice for sessions with batched task calls enabled. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });

/** renderWorkflowNotice renders the workflow notice for the active task schema. */
export function renderWorkflowNotice({ taskBatch }: { taskBatch: boolean }): string {
	return prompt.render(subagentPrompts["subagent/workflow-notice"].text, { taskBatch }).trim();
}

/** Whether `text` contains the standalone keyword "workflowz" (lowercase, prose-delimited) in prose — never inside a code block, inline */
export function containsWorkflow(text: string): boolean {
	return keywordInProse(text, WORKFLOW_WORD);
}
