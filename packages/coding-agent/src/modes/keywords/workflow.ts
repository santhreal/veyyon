import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/**
 * "workflowz" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a warm
 * amber→green gradient ({@link highlightWorkflow}); submitting a message that
 * mentions it appends a hidden workflow notice that steers the model to author
 * a deterministic multi-subagent workflow through the active task schema.
 * Matching is prose-delimited and case-sensitive (lowercase only) —
 * "workflowz" triggers, but "workflowzed", "Workflowz", and "workflowz.ts"
 * never do.
 *
 * The detection half lives in `./workflow-keyword` so a caller that only needs to
 * know whether a message mentions the keyword does not have to import the
 * gradient highlighter and, through it, the theme engine. Both halves are
 * re-exported here, so this stays the one place to import either from.
 */

export { containsWorkflow, renderWorkflowNotice, WORKFLOW_NOTICE } from "./workflow-keyword";

/**
 * Highlight every standalone "workflowz" in `text` for editor display
 * with a warm amber→green gradient (hue 30..150), visually distinct from
 * ultrathink's rainbow and orchestrate's teal→violet.
 */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflowz/,
	highlight: magicKeywordRegex("workflowz", "g"),
	stops: 14,
	hue: t => 30 + t * 120,
});
