import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/**
 * "orchestrate" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a cool
 * teal→violet gradient ({@link highlightOrchestrate}); submitting a message that
 * mentions it appends a hidden {@link ORCHESTRATE_NOTICE} that switches the model
 * into multi-agent orchestration mode. Matching is prose-delimited and
 * case-sensitive (lowercase only), so "orchestrated", "Orchestrate", or a path
 * like "orchestrate.ts" never trigger either behavior. Replaces the former
 * `/orchestrate` slash command.
 *
 * The detection half lives in `./orchestrate-keyword` so a caller that only needs
 * to know whether a message mentions the keyword does not have to import the
 * gradient highlighter and, through it, the theme engine. Both halves are
 * re-exported here, so this stays the one place to import either from.
 */

export { containsOrchestrate, ORCHESTRATE_NOTICE } from "./orchestrate-keyword";

/**
 * Highlight every standalone "orchestrate" in `text` for editor display with a
 * cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's
 * full-spectrum rainbow.
 */
export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter({
	probe: /orchestrate/,
	highlight: magicKeywordRegex("orchestrate", "g"),
	stops: 14,
	hue: t => 150 + t * 130,
});
