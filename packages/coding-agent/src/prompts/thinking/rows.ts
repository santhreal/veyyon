/**
 * The `thinking/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

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
