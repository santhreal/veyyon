/** The `steering/` prompt rows: messages that arrive mid-turn and take priority. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import steeringParentIrc from "./parent-irc.md" with { type: "text" };
import steeringUserInterjection from "./user-interjection.md" with { type: "text" };

/** Every prompt under `src/prompts/steering/`, keyed by its id (the path under `src/prompts/`). */
export const steeringPrompts = definePromptRows({
	"steering/parent-irc": {
		text: steeringParentIrc,
		purpose: "delivers a parent agent's IRC message that broke an interruptible wait",
	},
	"steering/user-interjection": {
		text: steeringUserInterjection,
		purpose: "delivers a user message that arrived mid-turn and takes priority",
	},
} satisfies Record<string, PromptEntry>);
