import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/**
 * "ultrathink" keyword support, mirroring Claude Code's affordance.
 *
 * Typing the standalone word in the input editor paints it with a rainbow
 * gradient ({@link highlightUltrathink}); submitting a message that mentions it
 * appends a hidden {@link ULTRATHINK_NOTICE} nudging the model toward careful
 * multi-step reasoning. Matching is prose-delimited and case-sensitive
 * (lowercase only), so "ultrathinking", "Ultrathink", or "ultrathink.ts" never
 * trigger either behavior.
 *
 * The detection half lives in `./ultrathink-keyword` so a caller that only needs
 * to know whether a message mentions the keyword does not have to import the
 * gradient highlighter and, through it, the theme engine. Both halves are
 * re-exported here, so this stays the one place to import either from.
 */

export { containsUltrathink, ULTRATHINK_NOTICE } from "./ultrathink-keyword";

/**
 * Rainbow-highlight every standalone "ultrathink" in `text` for editor display.
 * Sweeps red→violet (hue 0..330), stopping short of the wrap back to red so the
 * gradient resolves smoothly regardless of casing or match length.
 */
export const highlightUltrathink: KeywordHighlighter = createGradientHighlighter({
	probe: /ultrathink/,
	highlight: magicKeywordRegex("ultrathink", "g"),
	stops: 14,
	hue: t => t * 330,
});
