/** The `rules/` prompt rows: user-defined rule (TTSR) violations. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import rulesTtsrInterrupt from "./ttsr-interrupt.md" with { type: "text" };
import rulesTtsrToolReminder from "./ttsr-tool-reminder.md" with { type: "text" };

/** Every prompt under `src/prompts/rules/`, keyed by its id (the path under `src/prompts/`). */
export const rulesPrompts = definePromptRows({
	"rules/ttsr-interrupt": { text: rulesTtsrInterrupt, purpose: "interrupts output that violated a user-defined rule" },
	"rules/ttsr-tool-reminder": {
		text: rulesTtsrToolReminder,
		purpose: "reports a rule that matched a tool call without interrupting it",
	},
} satisfies Record<string, PromptEntry>);
