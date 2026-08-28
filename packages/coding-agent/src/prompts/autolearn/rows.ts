/** The `autolearn/` prompt rows: managed-skill guidance and its capture turn. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

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
