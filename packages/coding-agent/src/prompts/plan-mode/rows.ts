/** The `plan-mode/` prompt rows: the read-only plan contract and its handovers. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import planModeActive from "./active.md" with { type: "text" };
import planModeApproved from "./approved.md" with { type: "text" };
import planModeCompactInstructions from "./compact-instructions.md" with { type: "text" };
import planModeReference from "./reference.md" with { type: "text" };
import planModeSubagent from "./subagent.md" with { type: "text" };
import planModeToolDecisionReminder from "./tool-decision-reminder.md" with { type: "text" };
import planModeYoloHandoff from "./yolo-handoff.md" with { type: "text" };

/** Every prompt under `src/prompts/plan-mode/`, keyed by its id (the path under `src/prompts/`). */
export const planModePrompts = definePromptRows({
	"plan-mode/active": { text: planModeActive, purpose: "the read-only contract while plan mode is on" },
	"plan-mode/approved": { text: planModeApproved, purpose: "hands over an approved plan for execution" },
	"plan-mode/compact-instructions": {
		text: planModeCompactInstructions,
		purpose: "distills the plan-mode discussion before execution",
	},
	"plan-mode/reference": { text: planModeReference, purpose: "points a later turn back at the approved plan file" },
	"plan-mode/subagent": {
		text: planModeSubagent,
		purpose: "the prompt a subagent runs under while plan mode is active",
	},
	"plan-mode/tool-decision-reminder": {
		text: planModeToolDecisionReminder,
		purpose: "forces a next action when a plan-mode turn ended without one",
	},
	"plan-mode/yolo-handoff": {
		text: planModeYoloHandoff,
		purpose: "hands an approved plan to an agent that did not draft it",
	},
} satisfies Record<string, PromptEntry>);
