import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/**
 * "orchestratez" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a cool
 * teal→violet gradient ({@link highlightOrchestrate}); submitting a message that
 * mentions it appends a hidden {@link ORCHESTRATE_NOTICE} that switches the model
 * into multi-agent orchestration mode. Matching is prose-delimited and
 * case-sensitive (lowercase only), so "orchestratezed", "Orchestratez", or a
 * path like "orchestratez.ts" never trigger either behavior, and neither does
 * the ordinary verb `orchestrate` (see `./orchestrate-keyword` for why). Replaces
 * the former `/orchestrate` slash command.
 *
 * The detection half lives in `./orchestrate-keyword` so a caller that only needs
 * to know whether a message mentions the keyword does not have to import the
 * gradient highlighter and, through it, the theme engine. Detection is
 * re-exported here so a caller that draws the word can also test for it; the
 * notice it appends is in `../session/magic-keyword-notices`, which reads the prompt
 * registry and belongs in neither of the other two graphs.
 */

export { containsOrchestrate } from "./orchestrate-keyword";

/**
 * Highlight every standalone "orchestratez" in `text` for editor display with a
 * cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's
 * full-spectrum rainbow.
 */
export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter({
	probe: /orchestratez/,
	highlight: magicKeywordRegex("orchestratez", "g"),
	stops: 14,
	hue: t => 150 + t * 130,
});
