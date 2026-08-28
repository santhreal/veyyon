/** The `thinking/` prompt rows: classifying how much reasoning a turn needs. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";
import thinkingDifficulty from "./difficulty.md" with { type: "text" };
import thinkingDifficultyLocal from "./difficulty-local.md" with { type: "text" };

/** Every prompt under `src/prompts/thinking/`, keyed by its id (the path under `src/prompts/`). */
export const thinkingPrompts = definePromptRows({
	"thinking/difficulty": { text: thinkingDifficulty, purpose: "classifies how much thinking a turn needs" },
	"thinking/difficulty-local": {
		text: thinkingDifficultyLocal,
		purpose: "classifies request difficulty for a local classifier model",
	},
} satisfies Record<string, PromptEntry>);
