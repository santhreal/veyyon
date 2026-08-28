import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/** "workflowz" keyword support. Typing the standalone word in the input editor paints it with a warm */

export { containsWorkflow, renderWorkflowNotice, WORKFLOW_NOTICE } from "./workflow-keyword";

/** Highlight every standalone "workflowz" in `text` for editor display with a warm amber→green gradient (hue 30..150), visually distinct from */
export const highlightWorkflow: KeywordHighlighter = createGradientHighlighter({
	probe: /workflowz/,
	highlight: magicKeywordRegex("workflowz", "g"),
	stops: 14,
	hue: t => 30 + t * 120,
});
