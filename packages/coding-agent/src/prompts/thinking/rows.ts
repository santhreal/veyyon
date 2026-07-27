/**
 * The `thinking/` prompt rows: classifying how much reasoning a turn needs.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
 * paid 167 modules for it, the largest single edge that file had. A consumer now imports the directory it
 * belongs to and pays for that directory.
 *
 * THE INVARIANT IS UNCHANGED AND IS CHECKED ONE LEVEL DEEPER. Every `.md` under `src/prompts/` is imported by
 * exactly one row module, every row module is aggregated by `registry.ts`, and nothing else in the repository
 * may import a `.md`. `packages/coding-agent/test/core/prompt-registry-coverage.test.ts` pins all three, so a
 * new prompt is still unreachable code until it is registered, and a row still cannot describe a file that is
 * not there.
 *
 * DO NOT re-declare a row that another module already holds. The id-to-file mapping exists exactly once, here
 * for these ids, and the coverage suite fails on a second importer.
 */

import type { PromptEntry } from "@veyyon/utils/prompt-registry";
import thinkingDifficulty from "./difficulty.md" with { type: "text" };
import thinkingDifficultyLocal from "./difficulty-local.md" with { type: "text" };

/** Every prompt under `src/prompts/thinking/`, keyed by its id (the path under `src/prompts/`). */
export const thinkingPrompts = {
	"thinking/difficulty": { text: thinkingDifficulty, purpose: "classifies how much thinking a turn needs" },
	"thinking/difficulty-local": {
		text: thinkingDifficultyLocal,
		purpose: "classifies request difficulty for a local classifier model",
	},
} satisfies Record<string, PromptEntry>;
