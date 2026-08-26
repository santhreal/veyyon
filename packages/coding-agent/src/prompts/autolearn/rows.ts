/**
 * The `autolearn/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";
import autolearnGuidance from "./guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "./guidance-learn.md" with { type: "text" };
import autolearnNudgeAutocontinue from "./nudge-autocontinue.md" with { type: "text" };

/** Every prompt under `src/prompts/autolearn/`, keyed by its id (the path under `src/prompts/`). */
export const autolearnPrompts = definePromptRows({
	"autolearn/guidance": { text: autolearnGuidance, purpose: "explains managed skills and when to mint one" },
	"autolearn/guidance-learn": {
		text: autolearnGuidanceLearn,
		purpose: "the autolearn block covering the `learn` tool",
	},
	"autolearn/nudge-autocontinue": {
		text: autolearnNudgeAutocontinue,
		purpose: "an automated capture turn that must not be read as a user reply",
	},
} satisfies Record<string, PromptEntry>);
