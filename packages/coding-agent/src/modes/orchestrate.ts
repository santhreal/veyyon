import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";

/** "orchestratez" keyword support. Typing the standalone word in the input editor paints it with a cool */

export { containsOrchestrate, ORCHESTRATE_NOTICE } from "./orchestrate-keyword";

/** Highlight every standalone "orchestratez" in `text` for editor display with a cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's */
export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter({
	probe: /orchestratez/,
	highlight: magicKeywordRegex("orchestratez", "g"),
	stops: 14,
	hue: t => 150 + t * 130,
});
