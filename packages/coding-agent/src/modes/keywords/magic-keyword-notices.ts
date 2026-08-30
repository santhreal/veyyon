/**
 * The hidden system notices a magic keyword appends to a turn.
 *
 * Detection lives in `./ultrathink-keyword`, `./orchestrate-keyword` and
 * `./workflow-keyword`; drawing lives in `./ultrathink`, `./orchestrate` and
 * `./workflow`. This file is the third half of that family, and it is the only
 * one that reads the prompt registry.
 *
 * WHY IT IS ITS OWN FILE. A notice body is `prompts/subagent/rows` and
 * `prompts/turn-control/rows`, which load and index every markdown prompt in
 * those directories. The composer highlights these keywords as you type and asks
 * whether the buffer holds one, so the editor's import graph reached the whole
 * prompt registry to paint three words. Only the turn that submits a message
 * needs the notice text.
 *
 * Import this when you need to SEND the notice. Import `./<keyword>-keyword`
 * when you need to KNOW about the keyword, and `./<keyword>` when you need to
 * DRAW it.
 */

import * as prompt from "@veyyon/utils/prompt";
import { subagentPrompts } from "../../prompts/subagent/rows";
import { turnControlPrompts } from "../../prompts/turn-control/rows";

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = turnControlPrompts["turn-control/ultrathink-notice"].text.trim();

/** Hidden system notice appended after a user message that mentions "orchestratez". */
export const ORCHESTRATE_NOTICE: string = subagentPrompts["subagent/orchestrate-notice"].text.trim();

/** renderWorkflowNotice renders the workflow notice for the active task schema. */
export function renderWorkflowNotice({ taskBatch }: { taskBatch: boolean }): string {
	return prompt.render(subagentPrompts["subagent/workflow-notice"].text, { taskBatch }).trim();
}

/** WORKFLOW_NOTICE is the default hidden notice for sessions with batched task calls enabled. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });
