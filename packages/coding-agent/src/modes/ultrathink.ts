import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/** "ultrathink" keyword support, mirroring Claude Code's affordance. Typing the standalone word in the input editor paints it with a rainbow */

export { containsUltrathink, ULTRATHINK_NOTICE } from "./ultrathink-keyword";

/** Rainbow-highlight every standalone "ultrathink" in `text` for editor display. Sweeps red→violet (hue 0..330), stopping short of the wrap back to red so the */
export const highlightUltrathink: KeywordHighlighter = createGradientHighlighter({
	probe: /ultrathink/,
	highlight: magicKeywordRegex("ultrathink", "g"),
	stops: 14,
	hue: t => t * 330,
});
